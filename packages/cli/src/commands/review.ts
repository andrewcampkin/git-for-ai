// `git for-ai review [--port <n>] [--no-open]` — the local review web app server
// (architecture/REVIEW_UI.md; PLAN_2026-07-18.md §2.2). Serves the built `review-ui` SPA
// plus a read-only JSON API over Node's built-in `node:http` — deliberately no server
// framework (REVIEW_UI.md §1: Fastify stays reserved for the future team server).
//
// Server rules (REVIEW_UI.md §2 — privacy is the product here):
//   1. Binds 127.0.0.1 ONLY, never 0.0.0.0. Random free port by default; `--port` pins it.
//   2. Read-only: every endpoint is a GET (anything else is 405). All git reads go through
//      runReport / runShow / core's readSessionRecord, which follow the established
//      non-minting pattern — serving the UI leaves every ref byte-identical (the test
//      asserts this against `git for-each-ref` output).
//   3. Fully self-contained: the SPA build makes zero external requests (asserted in
//      review-ui's own tests). The server itself makes exactly one kind of outbound call,
//      and only on explicit opt-in: /api/ask's synthesis step calls the Anthropic API
//      when the user configured GIT_FOR_AI_ANTHROPIC_KEY / ANTHROPIC_API_KEY — the same
//      key-gated behavior as `git for-ai ask` (CLI_PLAN.md M11 honest-scope note). With
//      no key, /api/ask stays fully local and returns ranked raw sources.
//   4. No auth — localhost, single user.
//
// The API is a thin wrapper over ALREADY-TESTED command logic (REVIEW_UI.md §3): it
// returns the structured results those modules produce today; no new data assembly here.
// The endpoints without a preexisting command module are /api/meta (plain git +
// config/state file reads) and the DESKTOP.md §5-step-2 pair /api/branches + /api/diff/:sha,
// whose plain-git reads live next door in ./reviewGit.ts. All three are read-only like the
// rest, so browser mode serves them too — the desktop app needs them first, but nothing
// about them is desktop-specific.
//
// Judgment calls:
//   - `/api/change/:target` maps ANY runShow error to 404 with the message in the body.
//     For a localhost read-only viewer, "not found, here's why" is the honest rendering of
//     every lookup failure ("cannot resolve", "ambiguous prefix", …) and the client shows
//     the reason verbatim rather than guessing at categories.
//   - `/api/session/:ref` always answers 200 with an explicit status ("available" |
//     "unavailable" + reason) mirroring show.ts's ShowSessionInfo — an unresolvable ref is
//     honest degradation data, not an HTTP error.
//   - The SPA assets are resolved through the workspace dependency
//     (`require.resolve("@git-for-ai/review-ui/package.json")`, REVIEW_UI.md §5); a
//     missing build is an actionable startup error, never a blank page.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import type { SessionRecord } from "@git-for-ai/schemas";
import {
  askQuestion,
  runGit,
  readIndexState,
  readSessionRecord,
  type Embedder,
  type EnrichedSource,
  type GitContext,
  type SynthesisOptions,
  type SynthesisResult,
} from "@git-for-ai/core";

import { createAskTools } from "./askTools.js";
import { openQueryDeps, type QueryDeps } from "./queryDeps.js";
import { runReport } from "./report.js";
import { ReviewActions, type ReviewActionName } from "./reviewActions.js";
import { listBranches, readCommitDiff } from "./reviewGit.js";
import { runShow } from "./show.js";

/** The action verbs advertised by `/api/meta` when actions are enabled. */
const ACTION_NAMES_PUBLIC: readonly ReviewActionName[] = [
  "doctor",
  "reindex",
  "sync",
  "annotate",
  "relink",
  "reconcile",
];

// ---------------------------------------------------------------------------------------
// Options and structured result types (imported as TYPES ONLY by review-ui — §3)
// ---------------------------------------------------------------------------------------

/** Options for {@link runReview} / {@link startReviewServer} (`git for-ai review`). */
export interface ReviewOptions {
  /** Repository to serve (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--port <n>` — pin the port. Default: a random free port chosen by the OS. */
  port?: number;
  /** `--no-open` sets this false. Default true: open the browser after listening. */
  open?: boolean;
  /** Injectable query embedder for /api/ask (tests — the real model is never loaded). */
  embedder?: Embedder;
  /**
   * Synthesis overrides for /api/ask (tests inject apiKey + fetchImpl; the CLI leaves
   * this unset so the key comes from the environment, exactly like `git for-ai ask`).
   */
  synthesis?: SynthesisOptions;
  /**
   * Which host is serving (DESKTOP.md §4). `browser` (default) is `git for-ai review`:
   * strictly read-only. `desktop` is the Electron shell, which may also enable the
   * token-gated action endpoints — the SPA renders host-specific panes off the
   * capability flags in /api/meta, never off user-agent sniffing.
   */
  mode?: "browser" | "desktop";
  /**
   * Enables the POST action endpoints (DESKTOP.md §5 step 4b), which are the only way
   * this server can write to a repository. The host generates a fresh random token per
   * launch and gives it to its OWN renderer out of band; every action request must carry
   * it in `x-git-for-ai-token`. Absent (the `git for-ai review` case) the endpoints do
   * not exist at all and the server stays strictly read-only.
   */
  actionToken?: string;
}

/**
 * `/api/meta.capabilities` — what THIS server offers, so one SPA build can serve both
 * hosts without guessing. Flags describe the server, not the client; a false flag means
 * the pane must not render (rather than render and 404 on click).
 */
export interface ReviewCapabilities {
  mode: "browser" | "desktop";
  /** `/api/branches` is served (branch sidebar + `?rev=` scoping). */
  branches: boolean;
  /** `/api/diff/:sha` is served (diff pane). */
  diff: boolean;
  /**
   * Token-gated POST action endpoints are served. True only when the host launched with
   * an action token (the desktop shell); `git for-ai review` leaves this false and the
   * endpoints genuinely do not exist.
   */
  actions: boolean;
  /** The actions this server accepts, so the panel renders buttons it can actually press. */
  actionNames?: string[];
}

/** Index (`.git-for-ai/state.json`) status for `/api/meta`. Absence is labeled, never faked. */
export interface ReviewMetaIndex {
  /** True when state.json exists and parses — the index has been built at least once. */
  built: boolean;
  lastIndexedCommit?: string | null;
  modelFingerprint?: string;
  chunkCount?: number;
  updatedAt?: string;
  /** Present when state.json exists but is unreadable — reported, never silent. */
  error?: string;
}

/** `GET /api/meta` — repo identity plus capture/index status (REVIEW_UI.md §3). */
export interface ReviewMeta {
  repoName: string;
  /** Absolute worktree toplevel. */
  repoRoot: string;
  /** HEAD commit, or null on an unborn branch (fresh `git init`). */
  head: { sha: string; shortSha: string; subject: string } | null;
  /** True when `.git-for-ai/` exists (the repo opted in via `git for-ai init`). */
  initialized: boolean;
  /** `[capture].enabled` from config.toml (init default true); false when uninitialized. */
  captureEnabled: boolean;
  index: ReviewMetaIndex;
  /** What this server offers — the SPA renders its optional panes off these. */
  capabilities: ReviewCapabilities;
}

/** `GET /api/session/:ref` — the full span list for the trace viewer (REVIEW_UI.md §3). */
export interface ReviewSessionData {
  /** The session ref exactly as requested. */
  ref: string;
  /** `unavailable` carries a reason — honest degradation, mirroring show.ts. */
  status: "available" | "unavailable";
  reason?: string;
  /** The validated session record (present iff status is `available`). */
  record?: SessionRecord;
}

/**
 * `GET /api/ask?q=` — one ranked source, flattened to a SELF-CONTAINED wire shape.
 * The SPA's type bridge (review-ui/src/types.ts) only reaches the CLI's declaration
 * files and the schemas package, so the ask payload deliberately references no core
 * types — everything the panel renders is projected here by the server.
 */
export interface ReviewAskSource {
  /** 1-based rank (citation number — the panel's [n] markers index this list). */
  rank: number;
  kind: "code" | "ledger" | "session";
  /** Which retrieval halves surfaced this source ("vector" and/or "keyword"). */
  matchedBy: string[];
  /** Full change-id (link target `#/change/c/<id>`), when the source has one. */
  changeId: string | null;
  /** Full session ref (link target `#/session/<ref>`), when the source has one. */
  sessionRef: string | null;
  /** Code chunks: repo-relative path and line range. */
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** Ledger provenance ("agent-captured", ...), when the ledger record resolved. */
  provenance: string | null;
  /** Ledger scope, pre-rendered (`src/auth/session.ts:40-118`), when present. */
  scope: string | null;
  /** Agent tool for session sources ("claude-code"), when the record resolved. */
  agentTool: string | null;
  /** Record timestamp (ledger created_at / session captured_at), when present. */
  when: string | null;
  /** One-line story: ledger/session summary, else the chunk's first text line. */
  summary: string;
}

/** Synthesis outcome on the wire — mirrors core's SynthesisResult field-for-field. */
export interface ReviewAskSynthesis {
  synthesized: boolean;
  answer: string | null;
  /** 1-based ranks the answer cites, in order of first appearance. */
  citedSources: number[];
  model?: string;
  skippedReason?: string;
  error?: string;
  /**
   * Repository reads the answer made for itself (ASK_TOOLS.md §5.5), in call order.
   * An answer grounded in a live read is MORE verifiable than one grounded in an
   * embedding hit, so the page can show what was consulted beside it.
   */
  consulted?: ReviewAskConsulted[];
}

/** One repository read performed while answering. */
export interface ReviewAskConsulted {
  /** Tool name (`commit_diff`, `show_change`, `log_intent`, `blame_why`). */
  name: string;
  /** Arguments the answer chose. */
  input: Record<string, unknown>;
  /** False when that read failed — surfaced, never hidden. */
  ok: boolean;
  error?: string;
}

/** `GET /api/ask?q=` — honest degradation first-class: `unavailable` carries a reason. */
export interface ReviewAskData {
  question: string;
  /** `unavailable` = the index is not ready (uninitialized / never built / mismatched). */
  status: "ok" | "unavailable";
  /** Present iff status is `unavailable` — the same actionable message the CLI prints. */
  reason?: string;
  /** Present iff status is `ok`. */
  sources?: ReviewAskSource[];
  synthesis?: ReviewAskSynthesis;
  warnings?: string[];
}

/** A running review server (returned by {@link startReviewServer}). */
export interface ReviewServerHandle {
  port: number;
  /** `http://127.0.0.1:<port>/` — the only address this server answers on. */
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Result of {@link runReview}: the listening server plus whether a browser was launched. */
export interface ReviewResult {
  url: string;
  port: number;
  /** True when a browser-open command was spawned (best-effort — never fatal). */
  opened: boolean;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// SPA asset resolution (REVIEW_UI.md §5)
// ---------------------------------------------------------------------------------------

/**
 * Locate review-ui's built `dist/` through the workspace dependency. A missing build is an
 * actionable error at startup ("run pnpm build"), never a blank page at request time.
 */
export function resolveUiDist(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@git-for-ai/review-ui/package.json");
  const dist = join(dirname(manifestPath), "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(
      "the review UI is not built — packages/review-ui/dist/index.html is missing; " +
        "run `pnpm build` at the repository root, then retry `git for-ai review`",
    );
  }
  return dist;
}

/**
 * How many commits `/api/overview` walks when the caller doesn't say. A page must open
 * promptly on a repo with 50,000 commits; `?n=` raises it, and `git for-ai report` (which
 * is generating a document, not painting a screen) still defaults to all of history.
 */
const DEFAULT_OVERVIEW_COMMITS = 300;

/** Content types for the small, fixed set of asset kinds a Vite build emits. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------------------
// /api/meta assembly (plain git + config/state reads; all read-only)
// ---------------------------------------------------------------------------------------

/** Build a GitContext without materializing undefined keys (exactOptionalPropertyTypes). */
function toContext(options: ReviewOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

/** Field separator for `git log` format strings — never appears in a subject line. */
const FIELD_SEP = "\u001f";

/**
 * Read `[capture].enabled` from `.git-for-ai/config.toml` with the same deliberately tiny
 * line-based TOML idiom as reindex.ts. Missing file or key = init's default (true).
 */
async function readCaptureEnabled(gitForAiDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(gitForAiDir, "config.toml"), "utf8");
  } catch {
    return true;
  }
  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    if (section !== "capture") continue;
    const match = /^enabled\s*=\s*(true|false)\s*$/.exec(stripped);
    if (match !== null) {
      return match[1] === "true";
    }
  }
  return true;
}

async function assembleMeta(ctx: GitContext, options: ReviewOptions): Promise<ReviewMeta> {
  const top = await runGit(["rev-parse", "--show-toplevel"], { ...ctx, allowFailure: true });
  const repoRoot = top.exitCode === 0 && top.stdout.length > 0 ? top.stdout : (ctx.cwd ?? process.cwd());
  const repoName = basename(repoRoot);

  // HEAD is null on an unborn branch — an honest empty repo, not an error.
  const headResult = await runGit(["log", "-1", `--format=%H%x1f%h%x1f%s`, "HEAD"], {
    ...ctx,
    allowFailure: true,
  });
  let head: ReviewMeta["head"] = null;
  if (headResult.exitCode === 0 && headResult.stdout.length > 0) {
    const [sha, shortSha, ...rest] = headResult.stdout.split(FIELD_SEP);
    if (sha !== undefined && sha.length > 0 && shortSha !== undefined) {
      head = { sha, shortSha, subject: rest.join(FIELD_SEP) };
    }
  }

  const gitForAiDir = join(repoRoot, ".git-for-ai");
  const initialized = existsSync(gitForAiDir);
  const captureEnabled = initialized ? await readCaptureEnabled(gitForAiDir) : false;

  let index: ReviewMetaIndex;
  if (!initialized) {
    index = { built: false };
  } else {
    try {
      const state = await readIndexState(gitForAiDir);
      index =
        state === null
          ? { built: false }
          : {
              built: true,
              lastIndexedCommit: state.last_indexed_commit,
              modelFingerprint: state.model_fingerprint,
              chunkCount: state.chunk_count,
              updatedAt: state.updated_at,
            };
    } catch (error) {
      // An unreadable state.json is reported, never silently rendered as "not built".
      index = { built: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const mode = options.mode ?? "browser";
  const actions = options.actionToken !== undefined && options.actionToken.length > 0;
  return {
    repoName,
    repoRoot,
    head,
    initialized,
    captureEnabled,
    index,
    capabilities: {
      mode,
      // Both are plain read-only git reads: the browser gets them too (DESKTOP.md §5.2).
      branches: true,
      diff: true,
      // Writes exist only where a launch token does. The token itself is NEVER served
      // here — anything on localhost can read /api/meta.
      actions,
      ...(actions ? { actionNames: [...ACTION_NAMES_PUBLIC] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readSessionData(ref: string, ctx: GitContext): Promise<ReviewSessionData> {
  try {
    const record = await readSessionRecord(ref, ctx);
    if (record === null) {
      return {
        ref,
        status: "unavailable",
        reason: `no session object for ${ref} under refs/git-for-ai/sessions`,
      };
    }
    return { ref, status: "available", record };
  } catch (error) {
    return {
      ref,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── /api/ask (M12): the CLI's ask surface, served to the SPA panel ──
//
// Reuses the exact query deps `git for-ai ask` opens (openQueryDeps + askQuestion).
// The embedder is cached per server process (the transformers model loads once, not
// once per request) while the store is reopened per request (cheap, and it picks up a
// concurrent `reindex` immediately). Ask is a pure read: the engine's enrichment is
// read-only by contract (enrich.ts judgment #1 — never mints identity), so the
// non-minting ref guarantee holds; the review test asserts it byte-for-byte.

/** Per-server mutable ask state: injected seams + the process-cached embedder. */
interface AskRuntime {
  options: ReviewOptions;
  cached?: { embedder: Embedder; fingerprint: string };
}

function firstTextLine(text: string): string {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

function toAskSource(source: EnrichedSource): ReviewAskSource {
  const chunk = source.chunk;
  const scope = source.ledgerEntry?.scope[0];
  const summary =
    chunk.kind === "ledger" && source.ledgerEntry !== null
      ? source.ledgerEntry.summary
      : chunk.kind === "session" && source.sessionRecord?.summary !== undefined
        ? source.sessionRecord.summary
        : firstTextLine(chunk.text);
  return {
    rank: source.rank,
    kind: chunk.kind,
    matchedBy: [...source.matchedBy],
    changeId: chunk.changeId ?? source.ledgerEntry?.change_id ?? null,
    sessionRef: chunk.sessionRef,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    provenance: source.ledgerEntry?.provenance ?? null,
    scope:
      scope !== undefined
        ? `${scope.path}${scope.range ? `:${scope.range[0]}-${scope.range[1]}` : ""}`
        : null,
    agentTool: source.sessionRecord?.agent.tool ?? null,
    when: source.ledgerEntry?.created_at ?? source.sessionRecord?.captured_at ?? null,
    summary,
  };
}

function toAskSynthesis(synthesis: SynthesisResult): ReviewAskSynthesis {
  return {
    synthesized: synthesis.synthesized,
    answer: synthesis.answer,
    citedSources: [...synthesis.citedSources],
    ...(synthesis.model !== undefined ? { model: synthesis.model } : {}),
    ...(synthesis.skippedReason !== undefined ? { skippedReason: synthesis.skippedReason } : {}),
    ...(synthesis.error !== undefined ? { error: synthesis.error } : {}),
    ...(synthesis.toolCalls !== undefined && synthesis.toolCalls.length > 0
      ? {
          consulted: synthesis.toolCalls.map((call) => ({
            name: call.name,
            input: call.input,
            ok: call.ok,
            ...(call.error !== undefined ? { error: call.error } : {}),
          })),
        }
      : {}),
  };
}

async function handleAsk(
  query: URLSearchParams,
  res: ServerResponse,
  ctx: GitContext,
  runtime: AskRuntime,
): Promise<void> {
  const question = query.get("q")?.trim() ?? "";
  if (question.length === 0) {
    sendJson(res, 400, { error: "missing q parameter (the question)" });
    return;
  }
  const kRaw = query.get("k");
  let k: number | undefined;
  if (kRaw !== null) {
    k = Number.parseInt(kRaw, 10);
    if (!Number.isInteger(k) || k < 1) {
      sendJson(res, 400, { error: `invalid k parameter: ${kRaw} (expected a positive integer)` });
      return;
    }
  }

  let deps: QueryDeps;
  try {
    deps = await openQueryDeps({
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(runtime.options.embedder !== undefined
        ? { embedder: runtime.options.embedder }
        : runtime.cached !== undefined
          ? { embedder: runtime.cached.embedder, fingerprint: runtime.cached.fingerprint }
          : {}),
    });
  } catch (error) {
    // Not-ready states (uninitialized / never indexed / model changed) are honest
    // degradation data for the panel, not HTTP errors — same idiom as /api/session.
    const body: ReviewAskData = {
      question,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
    sendJson(res, 200, body);
    return;
  }
  // Cache the (possibly model-backed) embedder for subsequent requests.
  if (runtime.options.embedder === undefined && runtime.cached === undefined) {
    runtime.cached = { embedder: deps.embedder, fingerprint: deps.fingerprint };
  }

  try {
    const result = await askQuestion(
      { store: deps.store, embedder: deps.embedder, ctx: deps.ctx },
      question,
      {
        ...(k !== undefined ? { k } : {}),
        // Synthesis may read the repository for itself (ASK_TOOLS.md): the same toolbox
        // `git for-ai ask` uses, over the same read-only commands this server already
        // serves — so the non-minting guarantee holds unchanged. The request's embedder
        // is threaded through so a nested blame_why reuses it (RAM rule).
        synthesis: {
          ...runtime.options.synthesis,
          ...(runtime.options.synthesis?.tools === undefined
            ? { tools: createAskTools({ cwd: deps.repoRoot, embedder: deps.embedder }) }
            : {}),
        },
      },
    );
    const body: ReviewAskData = {
      question,
      status: "ok",
      sources: result.sources.map(toAskSource),
      synthesis: toAskSynthesis(result.synthesis),
      warnings: [...deps.warnings, ...result.warnings],
    };
    sendJson(res, 200, body);
  } finally {
    deps.close();
  }
}

async function handleApi(
  pathname: string,
  query: URLSearchParams,
  res: ServerResponse,
  ctx: GitContext,
  runtime: AskRuntime,
  actions: ReviewActions | null,
  req: IncomingMessage,
  port: number,
): Promise<void> {
  // Job status is a READ, but of write-path data, so it carries the same token gate: a
  // job's result can contain repository detail the page's other readers don't expose.
  if (pathname.startsWith("/api/actions/jobs")) {
    if (actions === null) {
      sendJson(res, 404, { error: "this server does not offer actions (read-only)" });
      return;
    }
    if (!actions.authorize(req, port)) {
      sendJson(res, 401, { error: "missing or invalid action token" });
      return;
    }
    const id = pathname.slice("/api/actions/jobs".length).replace(/^\//, "");
    if (id.length === 0) {
      sendJson(res, 200, { jobs: actions.jobs() });
      return;
    }
    const job = actions.job(decodeURIComponent(id));
    if (job === null) {
      sendJson(res, 404, { error: `no such job: ${id}` });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  if (pathname === "/api/ask") {
    await handleAsk(query, res, ctx, runtime);
    return;
  }

  if (pathname === "/api/overview") {
    const since = query.get("since");
    const until = query.get("until");
    const n = query.get("n");
    const rev = query.get("rev");
    let maxCount: number | undefined;
    if (n !== null) {
      maxCount = Number.parseInt(n, 10);
      if (!Number.isInteger(maxCount) || maxCount < 1) {
        sendJson(res, 400, { error: `invalid n parameter: ${n} (expected a positive integer)` });
        return;
      }
    }
    try {
      // format "md" — the API serves the structured data; nobody reads the rendered string.
      const { data } = await runReport({
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
        ...(since !== null ? { since } : {}),
        ...(until !== null ? { until } : {}),
        // A page bounds itself: without an explicit `n`, serve the most recent slice rather
        // than every commit a repo has ever had. The CLI's `report` keeps walking it all.
        maxCount: maxCount ?? DEFAULT_OVERVIEW_COMMITS,
        ...(rev !== null && rev.length > 0 ? { rev } : {}),
        format: "md",
      });
      sendJson(res, 200, data);
    } catch (error) {
      // An unresolvable `rev` is the caller's mistake, not a server fault — and it must
      // never degrade into "this branch has no history", which would read as a fact.
      if (rev !== null && rev.length > 0) {
        sendJson(res, 400, {
          error: `Couldn't show history for "${rev}": ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === "/api/branches") {
    sendJson(res, 200, await listBranches(ctx));
    return;
  }

  if (pathname.startsWith("/api/diff/")) {
    const target = decodeURIComponent(pathname.slice("/api/diff/".length));
    if (target.length === 0) {
      sendJson(res, 404, { error: "missing commit target" });
      return;
    }
    const contextRaw = query.get("context");
    let contextLines: number | undefined;
    if (contextRaw !== null) {
      contextLines = Number.parseInt(contextRaw, 10);
      if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) {
        sendJson(res, 400, {
          error: `invalid context parameter: ${contextRaw} (expected an integer 0..100)`,
        });
        return;
      }
    }
    try {
      const data = await readCommitDiff(target, {
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
        ...(contextLines !== undefined ? { contextLines } : {}),
      });
      sendJson(res, 200, data);
    } catch (error) {
      // Same judgment call as /api/change: every lookup failure is a 404 with the reason.
      sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (pathname.startsWith("/api/change/")) {
    const target = decodeURIComponent(pathname.slice("/api/change/".length));
    if (target.length === 0) {
      sendJson(res, 404, { error: "missing change target" });
      return;
    }
    try {
      const { data } = await runShow(target, ctx.cwd !== undefined ? { cwd: ctx.cwd } : {});
      sendJson(res, 200, data);
    } catch (error) {
      // Judgment call (module header): every lookup failure is a 404 with the reason.
      sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (pathname.startsWith("/api/session/")) {
    const ref = decodeURIComponent(pathname.slice("/api/session/".length));
    if (ref.length === 0) {
      sendJson(res, 404, { error: "missing session ref" });
      return;
    }
    sendJson(res, 200, await readSessionData(ref, ctx));
    return;
  }

  if (pathname === "/api/meta") {
    sendJson(res, 200, await assembleMeta(ctx, runtime.options));
    return;
  }

  sendJson(res, 404, { error: `unknown API endpoint: ${pathname}` });
}

async function serveStatic(
  pathname: string,
  res: ServerResponse,
  distDir: string,
): Promise<void> {
  // Normalize and confine to distDir (path-traversal guard) before touching the disk.
  const decoded = decodeURIComponent(pathname).replaceAll("\\", "/");
  const target = decoded === "/" ? "/index.html" : decoded;
  const filePath = resolve(distDir, `.${target}`);
  const confined = filePath === distDir || filePath.startsWith(distDir + sep);

  if (confined) {
    try {
      const body = await readFile(filePath);
      const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
      res.end(body);
      return;
    } catch {
      // fall through — not a real file under dist/
    }
  }

  // SPA fallback: extensionless paths are client routes; serve the shell. Anything that
  // looks like a missing asset (has an extension) is an honest 404, not a blank page.
  if (extname(target) === "") {
    const body = await readFile(join(distDir, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
    res.end(body);
    return;
  }
  sendJson(res, 404, { error: `not found: ${pathname}` });
}

/**
 * POST `/api/actions/<name>` — the only write path (DESKTOP.md §5 step 4b). Every guard
 * lives here or in ReviewActions: no token, no actions; wrong token, 401; another action
 * running, 409. See reviewActions.ts's header for why each rule exists.
 */
async function handleActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  actions: ReviewActions | null,
  port: number,
): Promise<void> {
  if (actions === null) {
    // Not "forbidden" — on a browser-mode server these endpoints genuinely do not exist.
    sendJson(res, 404, { error: "this server does not offer actions (read-only)" });
    return;
  }
  if (!actions.authorize(req, port)) {
    sendJson(res, 401, { error: "missing or invalid action token" });
    return;
  }

  const action = ReviewActions.parseActionPath(pathname);
  if (action === null) {
    sendJson(res, 404, { error: `unknown action: ${pathname}` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await ReviewActions.readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    // 202: the job is accepted and running; the client polls for its outcome.
    sendJson(res, 202, actions.start(action, body));
  } catch (error) {
    sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  distDir: string,
  runtime: AskRuntime,
  actions: ReviewActions | null,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
      await handleActionRequest(req, res, url.pathname, actions, port);
      return;
    }

    // REVIEW_UI.md §2 rule 2, as amended by DESKTOP.md §4: every OTHER endpoint is a GET.
    // Reads never write, and the write path is exactly the one branch above.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", actions === null ? "GET, HEAD" : "GET, HEAD, POST");
      sendJson(res, 405, {
        error:
          actions === null
            ? "this server is read-only: GET only"
            : "only /api/actions/<name> accepts POST",
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(url.pathname, url.searchParams, res, ctx, runtime, actions, req, port);
    } else {
      await serveStatic(url.pathname, res, distDir);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------------------
// Server lifecycle + entry points
// ---------------------------------------------------------------------------------------

/**
 * Start the review server: 127.0.0.1 only (never 0.0.0.0), random free port unless pinned.
 * Fails loudly before listening when cwd is not a git repo or the UI is not built.
 */
export async function startReviewServer(options: ReviewOptions = {}): Promise<ReviewServerHandle> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  ) {
    throw new Error(`invalid --port ${options.port} (expected an integer 0..65535)`);
  }

  const ctx = toContext(options);
  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);
  const distDir = resolveUiDist();

  const runtime: AskRuntime = { options };
  // Actions exist only where the host supplied a launch token (DESKTOP.md §5 step 4b);
  // otherwise this stays the strictly read-only server it has always been.
  const actions =
    options.actionToken !== undefined && options.actionToken.length > 0
      ? new ReviewActions(options.actionToken, ctx)
      : null;
  // The bound port is only known after listen(); the handler reads it then (Origin check).
  let boundPort = 0;
  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx, distDir, runtime, actions, boundPort);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    // Rule 1 (REVIEW_UI.md §2): bind 127.0.0.1 only.
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo;
  boundPort = address.port;
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    port: address.port,
    url,
    server,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error !== undefined ? reject(error) : resolvePromise()));
      }),
  };
}

/**
 * Open `url` in the default browser, best-effort: a failure to launch is never fatal (the
 * URL is printed either way). Windows uses `start` via cmd.exe per the platform convention;
 * `""` is the window-title argument so URLs are never mistaken for one.
 */
export function openBrowser(url: string): boolean {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : process.platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // best-effort: the URL was already printed by the caller
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * `git for-ai review [--port <n>] [--no-open]`: start the local review server and open the
 * browser (unless `--no-open`). The returned handle keeps the process alive until closed
 * (Ctrl+C in the CLI case). bin.ts wires this as:
 *
 *   const { url } = await runReview({ ...flags });
 *   console.log(`review UI serving at ${url}`);
 */
export async function runReview(options: ReviewOptions = {}): Promise<ReviewResult> {
  const handle = await startReviewServer(options);
  const opened = options.open === false ? false : openBrowser(handle.url);
  return { url: handle.url, port: handle.port, opened, close: handle.close };
}

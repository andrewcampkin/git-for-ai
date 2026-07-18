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
//      review-ui's own tests); this server adds no external calls either.
//   4. No auth — localhost, single user.
//
// The API is a thin wrapper over ALREADY-TESTED command logic (REVIEW_UI.md §3): it
// returns the structured results those modules produce today; no new data assembly here.
// The one endpoint without a preexisting module is /api/meta, which is plain git +
// config/state file reads (also read-only).
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
  runGit,
  readIndexState,
  readSessionRecord,
  type GitContext,
} from "@git-for-ai/core";

import { runReport } from "./report.js";
import { runShow } from "./show.js";

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

async function assembleMeta(ctx: GitContext): Promise<ReviewMeta> {
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

  return { repoName, repoRoot, head, initialized, captureEnabled, index };
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

async function handleApi(
  pathname: string,
  query: URLSearchParams,
  res: ServerResponse,
  ctx: GitContext,
): Promise<void> {
  if (pathname === "/api/overview") {
    const since = query.get("since");
    const until = query.get("until");
    const n = query.get("n");
    let maxCount: number | undefined;
    if (n !== null) {
      maxCount = Number.parseInt(n, 10);
      if (!Number.isInteger(maxCount) || maxCount < 1) {
        sendJson(res, 400, { error: `invalid n parameter: ${n} (expected a positive integer)` });
        return;
      }
    }
    // format "md" — the API serves the structured data; nobody reads the rendered string.
    const { data } = await runReport({
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(maxCount !== undefined ? { maxCount } : {}),
      format: "md",
    });
    sendJson(res, 200, data);
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
    sendJson(res, 200, await assembleMeta(ctx));
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  distDir: string,
): Promise<void> {
  try {
    // Rule 2 (REVIEW_UI.md §2): read-only — every endpoint is a GET.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      sendJson(res, 405, { error: "this server is read-only: GET only" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(url.pathname, url.searchParams, res, ctx);
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

  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx, distDir);
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

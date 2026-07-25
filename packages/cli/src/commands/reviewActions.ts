// The review server's WRITE path (architecture/DESKTOP.md §5 step 4b) — the maintenance
// verbs the desktop app offers as buttons, wrapping the identical pure `run*` functions
// the CLI commands use. Nothing here reimplements an action; it schedules one.
//
// This is the only part of the server that can change a repository, so the rules are
// tighter than anywhere else in the codebase:
//
//   1. **Off unless a token exists.** `startReviewServer` enables these endpoints only
//      when the host passes `actionToken`. `git for-ai review` (browser mode) never does,
//      so it stays exactly as read-only as it has always been — a POST there is still 405.
//   2. **Per-launch token, checked in constant time.** The desktop main process generates
//      a fresh random token each launch and hands it to its own renderer out of band (a
//      URL fragment). It is never served by any endpoint: anything else on localhost can
//      call /api/meta, so a token that /api/meta returned would protect nothing.
//   3. **Header, not body or query.** A custom header cannot be sent by a cross-origin
//      HTML form, so a malicious page in the user's browser cannot drive these endpoints
//      even if it guesses the port; and the token never lands in a URL that could be
//      logged. Requests carrying a cross-origin `Origin` are refused outright.
//   4. **One job at a time.** Two concurrent reindexes would fight over the index and the
//      machine's RAM (CLAUDE.md rule 7). A second request while one runs is a 409 naming
//      the job that holds the lock.
//   5. **Jobs, not blocking calls.** A real reindex takes a minute or more; a request that
//      hangs that long is indistinguishable from the hang this project just fixed. Every
//      action returns a job id immediately and reports progress as it goes — including
//      the per-batch progress `runReindex` already emits.
//
// Judgment calls:
//   - **Every action goes through the job mechanism, even `doctor`, which takes a second.**
//      One shape for the client to implement, and no future action can accidentally block
//      the server by being "obviously fast".
//   - **`sync --push` requires `confirmed: true` in the body.** The CLI gates pushing
//      behind an interactive prompt because it is the one action that sends repository
//      data somewhere else; an API that dropped that gate would be a quieter tool, not a
//      safer one. The UI shows the same privacy reminder text the CLI prints.
//   - **Job records are kept in memory only**, newest MAX_JOBS. They are progress for a
//      window that is open, not an audit log — the ledger is the durable record.

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { GitContext } from "@git-for-ai/core";

import { runAnnotate } from "./annotate.js";
import { runDoctor } from "./doctor.js";
import { runReconcile } from "./reconcile.js";
import { runReindex } from "./reindex.js";
import { runRelink } from "./relink.js";
import { runSync } from "./sync.js";

/** The maintenance verbs exposed as actions (DESKTOP.md §3 item 4). */
export type ReviewActionName =
  | "doctor"
  | "reindex"
  | "sync"
  | "annotate"
  | "relink"
  | "reconcile";

const ACTION_NAMES = new Set<string>([
  "doctor",
  "reindex",
  "sync",
  "annotate",
  "relink",
  "reconcile",
]);

/** A running or finished action. Progress lines are appended as the action emits them. */
export interface ReviewActionJob {
  id: string;
  action: ReviewActionName;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Human-readable progress, newest last (reindex emits one line per batch). */
  progress: string[];
  /** The action's own structured result (the same data its CLI command returns). */
  result?: unknown;
  /** Present iff status is `failed` — the error message, verbatim. */
  error?: string;
}

/** How many finished jobs stay readable. Progress for an open window, not an audit log. */
const MAX_JOBS = 20;

/** Request body cap — these payloads are small; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 1_000_000;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Constant-time token comparison. Length is compared first (timingSafeEqual throws on a
 * length mismatch), which leaks only the token's length — not its content.
 */
function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Read a JSON request body, bounded. Returns `{}` for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body too large (limit ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const asBool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

/**
 * Dispatch one action to the pure `run*` function its CLI command uses. Every branch is a
 * thin argument translation — no behavior lives here, which is what keeps the GUI and the
 * CLI from drifting apart.
 */
async function invoke(
  action: ReviewActionName,
  body: Record<string, unknown>,
  ctx: GitContext,
  onProgress: (line: string) => void,
): Promise<unknown> {
  const cwd = ctx.cwd !== undefined ? { cwd: ctx.cwd } : {};

  switch (action) {
    case "doctor":
      return await runDoctor({ ...cwd });

    case "reindex":
      return await runReindex({
        ...cwd,
        ...(asBool(body["full"]) !== undefined ? { full: asBool(body["full"])! } : {}),
        ...(asString(body["since"]) !== undefined ? { since: asString(body["since"])! } : {}),
        ...(asBool(body["verify"]) !== undefined ? { verify: asBool(body["verify"])! } : {}),
        onProgress,
      });

    case "sync": {
      const dryRun = asBool(body["dryRun"]) ?? false;
      const push = asBool(body["push"]) ?? false;
      const fetch = asBool(body["fetch"]) ?? false;
      // Judgment call (module header): pushing is the one action that sends repository
      // data elsewhere, so it needs an explicit acknowledgement, exactly like the CLI's
      // prompt. Fetch-only and dry runs move nothing outward and need none.
      const willPush = !dryRun && (push || (!push && !fetch));
      if (willPush && asBool(body["confirmed"]) !== true) {
        throw new Error(
          "pushing requires confirmation: this sends your intent ledger and session " +
            'traces to the remote. Re-send with { "confirmed": true } once the user has agreed.',
        );
      }
      return await runSync({
        ...cwd,
        ...(push ? { push: true } : {}),
        ...(fetch ? { fetch: true } : {}),
        ...(asString(body["remote"]) !== undefined ? { remote: asString(body["remote"])! } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        // The confirmation already happened in the UI; runSync must not try to prompt a
        // TTY that isn't there.
        yes: true,
      });
    }

    case "annotate": {
      const summary = asString(body["summary"]);
      const stdinJson = asString(body["json"]);
      if (summary === undefined && stdinJson === undefined) {
        throw new Error("annotate needs a summary (or a full entry in `json`)");
      }
      return await runAnnotate(asString(body["target"]) ?? "HEAD", {
        ...cwd,
        ...(summary !== undefined ? { summary } : {}),
        ...(stdinJson !== undefined ? { stdinJson } : {}),
        ...(asString(body["intent"]) !== undefined ? { intent: asString(body["intent"])! } : {}),
        ...(asStringArray(body["constraints"]) !== undefined
          ? { constraints: asStringArray(body["constraints"])! }
          : {}),
        ...(asStringArray(body["rejected"]) !== undefined
          ? { rejected: asStringArray(body["rejected"])! }
          : {}),
        // `tested` is the field the change page shows as "nothing recorded" in its
        // prove-it block, so it is the one a person most often opens the form to fill.
        ...(asStringArray(body["tested"]) !== undefined
          ? { tested: asStringArray(body["tested"])! }
          : {}),
        ...(asNumber(body["confidence"]) !== undefined
          ? { confidence: asNumber(body["confidence"])! }
          : {}),
        ...(asString(body["scopeRisk"]) !== undefined
          ? { scopeRisk: asString(body["scopeRisk"])! }
          : {}),
        ...(asString(body["reversibility"]) !== undefined
          ? { reversibility: asString(body["reversibility"])! }
          : {}),
      });
    }

    case "relink": {
      const args = asStringArray(body["args"]);
      if (args === undefined || args.length === 0) {
        throw new Error("relink needs `args` (a change-id and commit, or one commit with detach)");
      }
      return await runRelink(args, {
        ...cwd,
        ...(asBool(body["detach"]) === true ? { detach: true } : {}),
      });
    }

    case "reconcile":
      return await runReconcile({
        ...cwd,
        ...(asBool(body["rebuildMap"]) === true ? { rebuildMap: true } : {}),
        ...(asNumber(body["limit"]) !== undefined ? { limit: asNumber(body["limit"])! } : {}),
      });
  }
}

/**
 * The action endpoints for one server instance. Constructed only when the host supplied a
 * token; `handle` returns false for anything that isn't an action request, so the caller's
 * routing is unchanged when actions are off.
 */
export class ReviewActions {
  readonly #token: string;
  readonly #ctx: GitContext;
  readonly #jobs = new Map<string, ReviewActionJob>();
  #running: string | null = null;

  constructor(token: string, ctx: GitContext) {
    this.#token = token;
    this.#ctx = ctx;
  }

  /** Recent jobs, newest first — what the actions panel lists. */
  jobs(): ReviewActionJob[] {
    return [...this.#jobs.values()].reverse();
  }

  job(id: string): ReviewActionJob | null {
    return this.#jobs.get(id) ?? null;
  }

  /** True when the request presents the launch token and is not cross-origin. */
  authorize(req: IncomingMessage, port: number): boolean {
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin.length > 0) {
      const expected = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (!expected.has(origin)) {
        return false;
      }
    }
    const header = req.headers["x-git-for-ai-token"];
    return tokensMatch(this.#token, typeof header === "string" ? header : undefined);
  }

  /** Start an action. Throws when one is already running (the caller maps that to 409). */
  start(action: ReviewActionName, body: Record<string, unknown>): ReviewActionJob {
    if (this.#running !== null) {
      const held = this.#jobs.get(this.#running);
      throw new Error(
        `another action is already running (${held?.action ?? "unknown"}, started ${
          held?.startedAt ?? "recently"
        }) — wait for it to finish`,
      );
    }

    const job: ReviewActionJob = {
      id: randomUUID(),
      action,
      status: "running",
      startedAt: nowIso(),
      progress: [],
    };
    this.#jobs.set(job.id, job);
    this.#running = job.id;
    while (this.#jobs.size > MAX_JOBS) {
      const oldest = this.#jobs.keys().next().value;
      if (oldest === undefined || oldest === job.id) break;
      this.#jobs.delete(oldest);
    }

    void invoke(action, body, this.#ctx, (line) => {
      job.progress.push(line);
    })
      .then((result) => {
        job.status = "done";
        job.result = result;
      })
      .catch((error: unknown) => {
        // A failed action is reported, never thrown into the void: the panel shows the
        // same message the CLI would have printed.
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        job.finishedAt = nowIso();
        this.#running = null;
      });

    return job;
  }

  /** Parse `/api/actions/<name>` into a known action, or null. */
  static parseActionPath(pathname: string): ReviewActionName | null {
    const name = pathname.slice("/api/actions/".length);
    return ACTION_NAMES.has(name) ? (name as ReviewActionName) : null;
  }

  /** Read and validate a request body (bounded JSON object). */
  static readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return readJsonBody(req);
  }
}

/** Shared response helper so action replies match the rest of the API byte-for-byte. */
export function sendActionJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

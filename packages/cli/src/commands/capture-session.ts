// `git for-ai capture-session` — internal, hook-invoked. Spec: architecture/
// CLI_REFERENCE.md (capture-session section), ARCHITECTURE.md §10.
//
// Invoked by the two Claude Code PostToolUse hooks with the hook payload as JSON on
// stdin: `--event plan` buffers the plan span; `--event maybe-commit` self-filters to
// successful `git commit` invocations and does the full capture.
//
// THE ONE HARD RULE: this command ALWAYS succeeds from the caller's perspective
// (exit 0 — a hook must never break the user's commit, §10.2). `runCaptureSession`
// therefore never rejects: every failure — unparseable stdin, unknown event, a bug in
// the capture path — comes back as a structured outcome, and the details are appended
// to `.git-for-ai/capture.log` for `doctor` to surface, not spewed to stderr where
// they'd pollute the hook's output. bin.ts wires this as (approximately):
//
//   const { logLine } = await runCaptureSession({ event: opts.event });
//   if (!opts.quiet) console.log(logLine);
//   process.exitCode = 0; // unconditionally

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  captureSession,
  runGit,
  type CaptureEventKind,
  type CaptureSessionResult,
} from "@git-for-ai/core";

// ─── Public types ────────────────────────────────────────────────────────────

export interface RunCaptureSessionOptions {
  /** Raw `--event` value. Anything other than `plan`/`maybe-commit` is a logged skip. */
  event: string;
  /**
   * Injected raw payload JSON (tests / programmatic use). When absent, the payload is
   * read from `stdin` (or `process.stdin`).
   */
  payload?: string;
  /** Stream to read the payload from when `payload` is not given. Default process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Fallback repo directory when the payload carries no `cwd`. Default process.cwd(). */
  cwd?: string;
}

export interface CaptureSessionCliResult {
  /** The structured outcome from core (or a synthesized failed-soft for CLI-level errors). */
  outcome: CaptureSessionResult;
  /** The human-readable one-liner (CLI_REFERENCE.md's representative log line shape). */
  logLine: string;
  /** Where the log line was appended, or null if no repo/log location was reachable. */
  logFile: string | null;
}

// ─── stdin ───────────────────────────────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  // A TTY stdin means a human ran this by hand with no piped payload — don't block
  // waiting for input that will never come.
  if ((stream as NodeJS.ReadStream).isTTY === true) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ─── Log line rendering ──────────────────────────────────────────────────────

function short(value: string): string {
  return value.slice(0, 8);
}

/** Render the one-line human log for an outcome (CLI_REFERENCE.md capture-session). */
export function formatCaptureLogLine(outcome: CaptureSessionResult, sessionId?: string): string {
  switch (outcome.status) {
    case "buffered-plan":
      return `[git-for-ai] buffered plan for session ${short(outcome.sessionId)}`;
    case "skipped":
      return `[git-for-ai] skipped: ${outcome.reason}`;
    case "failed-soft":
      return `[git-for-ai] capture failed (soft): ${outcome.reason}`;
    case "captured": {
      const session = sessionId !== undefined ? short(sessionId) : "(unknown)";
      const base =
        `[git-for-ai] captured session ${session} -> commit ${short(outcome.commitSha)} ` +
        `(change ${short(outcome.changeId)}), ${outcome.spanCount} spans, ` +
        `${outcome.redactedCount} redactions`;
      const notes: string[] = [];
      if (outcome.sessionRef === null) {
        notes.push("session trace dropped — ledger entry written without session_ref");
      }
      if (outcome.degraded === "plan-only") {
        notes.push(`plan-only capture: ${outcome.degradedReason ?? "transcript unusable"}`);
      }
      return notes.length > 0 ? `${base} [${notes.join("; ")}]` : base;
    }
  }
}

// ─── Logging (best-effort, never fatal) ──────────────────────────────────────

async function resolveRepoRoot(dir: string): Promise<string | null> {
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, allowFailure: true });
    return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

async function appendCaptureLog(repoRoot: string, logLine: string): Promise<string | null> {
  try {
    const dir = join(repoRoot, ".git-for-ai");
    await mkdir(dir, { recursive: true });
    const logFile = join(dir, "capture.log");
    await appendFile(logFile, `${new Date().toISOString()} ${logLine}\n`, "utf8");
    return logFile;
  } catch {
    return null; // logging is best-effort; a read-only disk must not break the hook.
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run one capture-session invocation. NEVER REJECTS — the resolved result carries
 * everything bin.ts needs (a log line already persisted to `.git-for-ai/capture.log`
 * where possible), and the process exit code is always 0 regardless of outcome.
 */
export async function runCaptureSession(
  options: RunCaptureSessionOptions,
): Promise<CaptureSessionCliResult> {
  const fallbackCwd = options.cwd ?? process.cwd();

  let outcome: CaptureSessionResult;
  let sessionId: string | undefined;
  let payloadCwd: string | undefined;

  try {
    // 1. The payload: injected, or read from stdin.
    let raw: string;
    if (options.payload !== undefined) {
      raw = options.payload;
    } else {
      raw = await readAll(options.stdin ?? process.stdin);
    }

    let payload: unknown = null;
    if (raw.trim() === "") {
      outcome = { status: "skipped", reason: "no hook payload on stdin" };
    } else {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
        outcome = { status: "failed-soft", reason: "hook payload on stdin is not valid JSON" };
      }
      if (payload !== undefined) {
        if (typeof payload === "object" && payload !== null) {
          const record = payload as Record<string, unknown>;
          if (typeof record["session_id"] === "string") {
            sessionId = record["session_id"];
          }
          if (typeof record["cwd"] === "string") {
            payloadCwd = record["cwd"];
          }
        }

        // 2. Dispatch on --event.
        const event = options.event;
        if (event !== "plan" && event !== "maybe-commit") {
          outcome = {
            status: "skipped",
            reason: `unknown --event "${event}" (expected plan or maybe-commit)`,
          };
        } else {
          outcome = await captureSession(payload, event as CaptureEventKind, { cwd: fallbackCwd });
        }
      } else {
        outcome = { status: "failed-soft", reason: "hook payload on stdin is not valid JSON" };
      }
    }
  } catch (error) {
    outcome = {
      status: "failed-soft",
      reason: `capture-session internal error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // 3. Log the outcome (best-effort — a failure to log is itself swallowed).
  const logLine = formatCaptureLogLine(outcome, sessionId);
  let logFile: string | null = null;
  const repoRoot = await resolveRepoRoot(payloadCwd ?? fallbackCwd);
  if (repoRoot !== null) {
    logFile = await appendCaptureLog(repoRoot, logLine);
  }

  return { outcome, logLine, logFile };
}

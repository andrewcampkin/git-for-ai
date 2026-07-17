// Per-session capture bookkeeping in `.git-for-ai/state.json` — the plan buffer
// (ARCHITECTURE.md §10.1: "buffer plan span keyed to session_id (in .git-for-ai/state)")
// and the slice markers ("slice since last captured commit", §10.2).
//
// state.json is created by `init` with index-bookkeeping keys (DATA_MODEL.md §5.1,
// `last_indexed_commit` etc.). This module adds ONE key — `sessions` — and is required
// to preserve every key it does not own (DATA_MODEL.md §6: writers preserve unknown
// keys). All reads and writes are DEFENSIVE: state is a convenience cache, and a
// missing, unreadable, or corrupt state file must never break capture — reads degrade
// to "no state", and writes refuse to clobber a file they could not parse (returning
// false so the caller can log it) rather than destroying whatever is actually in it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Relative location of the state file under the repo root (ARCHITECTURE.md §8.2). */
export const STATE_FILE_RELPATH = ".git-for-ai/state.json";

/** Capture bookkeeping for one Claude Code session (keyed by `session_id`). */
export interface SessionCaptureState {
  /** Buffered plan text from the last ExitPlanMode hook, awaiting the next commit. */
  plan?: string;
  /** When the plan was buffered. */
  plan_buffered_at?: string;
  /** HEAD at the last successful capture for this session (dedupe + commit_range.since). */
  last_captured_commit?: string;
  /** Transcript line count consumed at the last capture (the §10.2 slice marker). */
  last_captured_line?: number;
  /** Last time this entry was touched (used to prune stale sessions). */
  updated_at?: string;
}

/** Keep at most this many session entries; the oldest (by `updated_at`) are pruned. */
const MAX_TRACKED_SESSIONS = 20;

function statePath(repoRoot: string): string {
  return join(repoRoot, ...STATE_FILE_RELPATH.split("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse state.json. Distinguishes three cases:
 *   - `{ kind: "ok", state }` — parsed fine (or file simply absent: empty object);
 *   - `{ kind: "unreadable" }` — the file EXISTS but could not be parsed; callers must
 *     not write through it (that would destroy data we could not understand).
 */
async function readStateFile(
  repoRoot: string,
): Promise<{ kind: "ok"; state: Record<string, unknown> } | { kind: "unreadable" }> {
  let raw: string;
  try {
    raw = await readFile(statePath(repoRoot), "utf8");
  } catch {
    return { kind: "ok", state: {} }; // absent = empty, fine to create.
  }
  try {
    const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { kind: "unreadable" };
    }
    return { kind: "ok", state: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

function sessionsOf(state: Record<string, unknown>): Record<string, unknown> {
  const sessions = state["sessions"];
  return isRecord(sessions) ? sessions : {};
}

function sanitizeEntry(value: unknown): SessionCaptureState {
  if (!isRecord(value)) {
    return {};
  }
  const out: SessionCaptureState = {};
  if (typeof value["plan"] === "string") out.plan = value["plan"];
  if (typeof value["plan_buffered_at"] === "string") out.plan_buffered_at = value["plan_buffered_at"];
  if (typeof value["last_captured_commit"] === "string")
    out.last_captured_commit = value["last_captured_commit"];
  if (typeof value["last_captured_line"] === "number" && Number.isFinite(value["last_captured_line"]))
    out.last_captured_line = value["last_captured_line"];
  if (typeof value["updated_at"] === "string") out.updated_at = value["updated_at"];
  return out;
}

/**
 * Read the capture state for one session. Missing/corrupt state degrades to `{}` —
 * capture then just slices from the commit's parent instead of the recorded marker.
 */
export async function readSessionCaptureState(
  repoRoot: string,
  sessionId: string,
): Promise<SessionCaptureState> {
  const read = await readStateFile(repoRoot);
  if (read.kind !== "ok") {
    return {};
  }
  return sanitizeEntry(sessionsOf(read.state)[sessionId]);
}

/** Drop the oldest session entries once the table exceeds {@link MAX_TRACKED_SESSIONS}. */
function pruneSessions(sessions: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_TRACKED_SESSIONS) {
    return sessions;
  }
  const byAge = keys
    .map((key) => {
      const entry = sessions[key];
      const updatedAt = isRecord(entry) && typeof entry["updated_at"] === "string" ? entry["updated_at"] : "";
      return { key, updatedAt };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const pruned: Record<string, unknown> = { ...sessions };
  for (const { key } of byAge.slice(0, keys.length - MAX_TRACKED_SESSIONS)) {
    delete pruned[key];
  }
  return pruned;
}

/**
 * Merge `patch` into the capture state for `sessionId` and persist, preserving every
 * key this module does not own (both at the top level of state.json and inside other
 * sessions' entries). Setting a patch field to `null` deletes it (used to clear a
 * consumed plan buffer).
 *
 * Returns false — without throwing — when the state could not be persisted (existing
 * file unparseable, or the write itself failed). Capture treats that as a logged
 * warning, never a failure: state is an optimization, not source of truth.
 */
export async function updateSessionCaptureState(
  repoRoot: string,
  sessionId: string,
  patch: { [K in keyof SessionCaptureState]?: SessionCaptureState[K] | null },
): Promise<boolean> {
  const read = await readStateFile(repoRoot);
  if (read.kind !== "ok") {
    return false; // never write through a file we could not parse.
  }

  const state = read.state;
  const sessions: Record<string, unknown> = { ...sessionsOf(state) };
  const existing = isRecord(sessions[sessionId]) ? { ...(sessions[sessionId] as Record<string, unknown>) } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete existing[key];
    } else if (value !== undefined) {
      existing[key] = value;
    }
  }
  existing["updated_at"] = new Date().toISOString();
  sessions[sessionId] = existing;

  const next: Record<string, unknown> = { ...state, sessions: pruneSessions(sessions) };

  try {
    const path = statePath(repoRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

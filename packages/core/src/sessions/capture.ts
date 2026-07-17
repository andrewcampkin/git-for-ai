// captureSession — the hook-driven capture orchestrator (ARCHITECTURE.md §10).
//
// Two events, both delivered by Claude Code PostToolUse hooks with the hook payload on
// stdin (parsed by the CLI layer, handed here as an object):
//
//   --event plan          ExitPlanMode fired. Buffer the plan text keyed by session_id
//                         (in .git-for-ai/state.json). No commit yet — just remember.
//
//   --event maybe-commit  A Bash tool call finished. Self-filter: was it a SUCCESSFUL
//                         `git commit`? If not, no-op. If yes: read HEAD, slice the
//                         transcript since the last captured commit, assemble
//                         OTel-GenAI spans (plan + tool trail + model turns), run the
//                         §13 redaction pass BEFORE any write (fail-closed), store the
//                         content-addressed session trace, resolve HEAD's change-id,
//                         and append a ledger entry carrying `session_ref`.
//
// THE CARDINAL RULE (§10.2/§16.6): capture must NEVER break the user's commit. This
// module's entry point does not throw — every failure path returns a structured result
// (`captured` / `buffered-plan` / `skipped` / `failed-soft`) for the CLI layer to log,
// and degradations (unreadable transcript, format drift, redaction failure) downgrade
// the capture rather than abort it:
//
//   - transcript unreadable / format drift  -> plan-only capture (fingerprint records it)
//   - redaction pass throws                 -> FAIL-CLOSED: session trace NOT written;
//                                              ledger entry still written, without
//                                              session_ref, with a redaction_note (§13)
//   - state.json unusable                   -> capture proceeds without slice markers

import { readFile } from "node:fs/promises";

import type { LedgerEntry, ScopeItem, SessionRecord, Span } from "@git-for-ai/schemas";

import { runGit, readHead } from "../git/index.js";
import { resolveChangeId } from "../identity/resolve.js";
import type { GitContext } from "../identity/changeMap.js";
import { appendLedgerEntry } from "../ledger/intentNotes.js";
import { readCaptureSettings } from "./captureConfig.js";
import {
  BUILTIN_REDACTION_RULES,
  patternRule,
  redactSpans,
  type RedactionRule,
} from "./redaction.js";
import { readSessionCaptureState, updateSessionCaptureState } from "./state.js";
import { writeSessionRecord } from "./store.js";
import {
  CLAUDE_CODE_TRANSCRIPT_FINGERPRINT,
  PLAN_ONLY_FINGERPRINT,
  parseTranscriptSlice,
  type TranscriptMeta,
} from "./transcript.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** The two hook events (ARCHITECTURE.md §10.1). */
export type CaptureEventKind = "plan" | "maybe-commit";

/**
 * The Claude Code hook payload, as parsed from stdin. Every field is optional because
 * the payload is OBSERVED DATA from an external tool — validation happens here, not at
 * the parse boundary, so a drifted payload degrades instead of crashing.
 */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

export interface CaptureSessionOptions extends GitContext {
  /**
   * Test hook: override the redaction ruleset (built-ins + config extra_patterns by
   * default). A rule that throws exercises the fail-closed path end to end.
   */
  redactionRules?: readonly RedactionRule[];
}

export type CaptureSessionResult =
  /** `--event plan`: the plan text was buffered for this session. */
  | { status: "buffered-plan"; sessionId: string }
  /** Deliberate no-op (not a commit, capture disabled, already captured, ...). */
  | { status: "skipped"; reason: string }
  /** A commit was captured. `sessionRef` is null when redaction failed closed. */
  | {
      status: "captured";
      commitSha: string;
      changeId: string;
      sessionRef: string | null;
      spanCount: number;
      redactedCount: number;
      /** `"plan-only"` when the transcript was unusable and only the plan was captured. */
      degraded: false | "plan-only";
      degradedReason?: string;
      /** Non-fatal problems worth surfacing (state not persisted, session dropped, ...). */
      warnings: string[];
    }
  /** Something went wrong; nothing (or only partial data) was written. Never thrown. */
  | { status: "failed-soft"; reason: string };

// ─── Payload plumbing ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown parsed-JSON value into a HookPayload view. Null when not an object. */
export function toHookPayload(value: unknown): HookPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const payload: HookPayload = { ...value };
  if (!isRecord(payload.tool_input)) {
    delete payload.tool_input;
  }
  for (const key of ["session_id", "transcript_path", "cwd", "hook_event_name", "tool_name"] as const) {
    if (typeof payload[key] !== "string") {
      delete payload[key];
    }
  }
  return payload;
}

// ─── The maybe-commit self-filter (ARCHITECTURE.md §10.2, §16.4) ─────────────

/** Split a shell command on unquoted `&&`, `||`, `;`, `|`, and newlines. */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote && command[i - 1] !== "\\") {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/** git global options that consume a separate following value. */
const GIT_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * Conservative test: does this Bash command actually RUN `git commit` (in any of its
 * `&&`/`;`/pipe segments)? Token-based, not substring-based, so `echo git commit`,
 * `git status`, and a "git commit" inside a quoted string never match. Global git
 * options between `git` and the subcommand (`-c x=y`, `-C dir`, ...) are skipped.
 */
export function isGitCommitCommand(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);

    // Skip leading environment assignments (`FOO=bar git commit`).
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
      i += 1;
    }

    const head = tokens[i];
    if (head === undefined) {
      continue;
    }
    const base = head
      .replace(/^["']|["']$/g, "")
      .replace(/^.*[\\/]/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase();
    if (base !== "git") {
      continue;
    }

    i += 1;
    while (i < tokens.length) {
      const token = tokens[i]!;
      if (token.startsWith("-")) {
        i += GIT_VALUE_OPTIONS.has(token) ? 2 : 1;
        continue;
      }
      if (token === "commit") {
        return true;
      }
      break; // some other subcommand — this segment is not a commit.
    }
  }
  return false;
}

/**
 * Conservative success check over the hook's `tool_response`. The Bash tool_response
 * shape is not contractual, so only EXPLICIT failure evidence blocks capture:
 * interruption flags, error flags, or a non-zero exit code under any of the field
 * names observed in the wild. An absent/unfamiliar response is treated as success —
 * the transcript slice is still worth capturing, and HEAD is verified independently.
 */
export function toolResponseIndicatesFailure(toolResponse: unknown): boolean {
  if (!isRecord(toolResponse)) {
    return false;
  }
  if (toolResponse["interrupted"] === true) {
    return true;
  }
  if (toolResponse["is_error"] === true || toolResponse["isError"] === true) {
    return true;
  }
  if (toolResponse["success"] === false) {
    return true;
  }
  for (const key of ["exit_code", "exitCode", "code"]) {
    const value = toolResponse[key];
    if (typeof value === "number" && value !== 0) {
      return true;
    }
  }
  return false;
}

// ─── Small git helpers ───────────────────────────────────────────────────────

async function resolveRepoRoot(dir: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, allowFailure: true });
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

async function readParentSha(sha: string, ctx: GitContext): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${sha}^`], {
    ...ctx,
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

async function readCommitSubject(sha: string, ctx: GitContext): Promise<string> {
  const result = await runGit(["log", "-1", "--format=%s", sha], { ...ctx, allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function readUserEmail(ctx: GitContext): Promise<string | null> {
  const result = await runGit(["config", "--get", "user.email"], { ...ctx, allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

/**
 * Build the ledger `scope` from what the commit actually touched: `git diff-tree`
 * paths with their post-image blob SHAs (deletions have no post-image blob and are
 * skipped — Agent-Trace scope ties ranges to content that exists at `revision`).
 */
async function scopeFromCommit(sha: string, ctx: GitContext): Promise<ScopeItem[]> {
  const result = await runGit(["diff-tree", "-r", "--root", "--no-commit-id", sha], {
    ...ctx,
    allowFailure: true,
  });
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return [];
  }
  const scope: ScopeItem[] = [];
  for (const line of result.stdout.split("\n")) {
    // Format: ":<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>"
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const meta = line.slice(0, tab).split(" ");
    const newSha = meta[3];
    const path = line.slice(tab + 1);
    if (newSha === undefined || !/^[0-9a-f]{40}$/.test(newSha) || /^0{40}$/.test(newSha) || path === "") {
      continue;
    }
    scope.push({ path: path.replace(/\\/g, "/"), blob: newSha });
  }
  return scope;
}

// ─── The orchestrator ────────────────────────────────────────────────────────

/**
 * Handle one capture-session hook invocation. NEVER THROWS — every outcome, including
 * internal bugs, comes back as a structured {@link CaptureSessionResult} for the CLI
 * layer to log (the CLI always exits 0; the user's commit is sacred).
 */
export async function captureSession(
  payloadValue: unknown,
  event: CaptureEventKind,
  options: CaptureSessionOptions = {},
): Promise<CaptureSessionResult> {
  try {
    const payload = toHookPayload(payloadValue);
    if (payload === null) {
      return { status: "skipped", reason: "hook payload is not a JSON object" };
    }
    if (event === "plan") {
      return await handlePlanEvent(payload, options);
    }
    return await handleMaybeCommitEvent(payload, options);
  } catch (error) {
    return {
      status: "failed-soft",
      reason: `unexpected capture error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handlePlanEvent(
  payload: HookPayload,
  options: CaptureSessionOptions,
): Promise<CaptureSessionResult> {
  const sessionId = payload.session_id;
  if (sessionId === undefined) {
    return { status: "skipped", reason: "payload has no session_id" };
  }
  const plan = payload.tool_input?.["plan"];
  if (typeof plan !== "string" || plan.trim() === "") {
    return { status: "skipped", reason: "payload has no plan text" };
  }

  const repoRoot = await resolveRepoRoot(payload.cwd ?? options.cwd ?? process.cwd());
  if (repoRoot === null) {
    return { status: "skipped", reason: "not inside a git repository" };
  }

  const settings = await readCaptureSettings(repoRoot);
  if (!settings.enabled) {
    return { status: "skipped", reason: "capture is disabled in .git-for-ai/config.toml" };
  }

  const persisted = await updateSessionCaptureState(repoRoot, sessionId, {
    plan,
    plan_buffered_at: new Date().toISOString(),
  });
  if (!persisted) {
    return { status: "failed-soft", reason: "could not persist plan buffer to .git-for-ai/state.json" };
  }
  return { status: "buffered-plan", sessionId };
}

async function handleMaybeCommitEvent(
  payload: HookPayload,
  options: CaptureSessionOptions,
): Promise<CaptureSessionResult> {
  // ── The self-filter: only a SUCCESSFUL `git commit` proceeds (§10.2). ──
  if (payload.tool_name !== undefined && payload.tool_name !== "Bash") {
    return { status: "skipped", reason: `not a Bash tool event (tool_name=${payload.tool_name})` };
  }
  const command = payload.tool_input?.["command"];
  if (typeof command !== "string") {
    return { status: "skipped", reason: "payload has no Bash command" };
  }
  if (!isGitCommitCommand(command)) {
    return { status: "skipped", reason: "command is not a git commit" };
  }
  if (toolResponseIndicatesFailure(payload.tool_response)) {
    return { status: "skipped", reason: "git commit did not succeed (tool_response reports failure)" };
  }

  const sessionId = payload.session_id;
  if (sessionId === undefined) {
    return { status: "skipped", reason: "payload has no session_id" };
  }

  const repoRoot = await resolveRepoRoot(payload.cwd ?? options.cwd ?? process.cwd());
  if (repoRoot === null) {
    return { status: "skipped", reason: "not inside a git repository" };
  }
  const ctx: GitContext = { ...(options.env !== undefined ? { env: options.env } : {}), cwd: repoRoot };

  const settings = await readCaptureSettings(repoRoot);
  if (!settings.enabled) {
    return { status: "skipped", reason: "capture is disabled in .git-for-ai/config.toml" };
  }

  // ── The commit to attach to. ──
  let head: string;
  try {
    head = await readHead(ctx);
  } catch {
    return { status: "skipped", reason: "repository has no HEAD commit" };
  }

  const state = await readSessionCaptureState(repoRoot, sessionId);
  if (state.last_captured_commit === head) {
    return { status: "skipped", reason: `commit ${head.slice(0, 8)} already captured for this session` };
  }

  const warnings: string[] = [];

  // ── Slice the transcript (degrade to plan-only on any trouble, §10.2). ──
  let spans: Span[] = [];
  let meta: TranscriptMeta = {};
  let degraded: false | "plan-only" = false;
  let degradedReason: string | undefined;
  let consumedLines: number | undefined;

  if (payload.transcript_path === undefined) {
    degraded = "plan-only";
    degradedReason = "hook payload has no transcript_path";
  } else {
    let transcriptContent: string | null = null;
    try {
      transcriptContent = await readFile(payload.transcript_path, "utf8");
    } catch (error) {
      degraded = "plan-only";
      degradedReason = `transcript unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (transcriptContent !== null) {
      const parsed = parseTranscriptSlice(transcriptContent, {
        ...(state.last_captured_line !== undefined ? { sinceLine: state.last_captured_line } : {}),
      });
      if (parsed.ok) {
        spans = parsed.spans;
        meta = parsed.meta;
        consumedLines = parsed.totalLines;
        if (parsed.skippedLines > 0) {
          warnings.push(`${parsed.skippedLines} unparseable transcript line(s) skipped`);
        }
      } else {
        degraded = "plan-only";
        degradedReason = parsed.reason;
        consumedLines = parsed.totalLines;
      }
    }
  }

  // ── Fold in the buffered plan (only when the slice didn't already capture one). ──
  const hasPlanSpan = spans.some((span) => span.kind === "agent.plan");
  if (!hasPlanSpan && state.plan !== undefined) {
    const planSpan: Span = {
      span_id: "plan-buffered",
      kind: "agent.plan",
      ...(state.plan_buffered_at !== undefined
        ? { start: state.plan_buffered_at, end: state.plan_buffered_at }
        : {}),
      body: { plan: state.plan },
    };
    spans = [planSpan, ...spans];
  }
  const planBody = spans.find((span) => span.kind === "agent.plan")?.body?.["plan"];
  const planText = typeof planBody === "string" ? planBody : undefined;

  // ── Redaction BEFORE any write — fail-closed (§13). ──
  let sessionRef: string | null = null;
  let redactedCount = 0;
  let redactionNote: string | undefined;
  let record: SessionRecord | null = null;

  try {
    // Rules are assembled INSIDE the fail-closed region: a broken user-supplied
    // extra_pattern regex is a redaction error, so the trace is dropped, not written
    // unscanned.
    const rules: readonly RedactionRule[] =
      options.redactionRules ??
      [
        ...BUILTIN_REDACTION_RULES,
        ...settings.extraPatterns.map((source, index) =>
          patternRule(`extra-pattern-${index + 1}`, new RegExp(source, "g")),
        ),
      ];

    const redacted = redactSpans(spans, {
      rules,
      ignoreGlobs: settings.neverCapture,
      maxSpanBytes: settings.maxSpanBytes,
    });
    redactedCount = redacted.redaction.redacted_count;

    const since = state.last_captured_commit ?? (await readParentSha(head, ctx)) ?? head;
    const subject = await readCommitSubject(head, ctx);

    record = {
      schema: "git-for-ai/session@1",
      session_id: sessionId,
      agent: {
        tool: "claude-code",
        version: meta.version ?? "unknown",
        model: meta.model ?? "unknown",
      },
      captured_at: new Date().toISOString(),
      commit_range: { since, until: head },
      redaction: redacted.redaction,
      source_fingerprint:
        degraded === "plan-only" ? PLAN_ONLY_FINGERPRINT : CLAUDE_CODE_TRANSCRIPT_FINGERPRINT,
      spans: redacted.spans,
      summary: buildSessionSummary(redacted.spans, subject),
    };
  } catch (error) {
    // FAIL-CLOSED: better to lose a trace than write a secret into a syncable object.
    record = null;
    redactionNote = `session trace dropped: redaction pass failed (${
      error instanceof Error ? error.message : String(error)
    })`;
    warnings.push(redactionNote);
  }

  if (record !== null) {
    try {
      const written = await writeSessionRecord(record, ctx);
      sessionRef = written.sessionRef;
    } catch (error) {
      // Trace couldn't be stored — degrade to a ledger entry without session_ref.
      redactionNote = `session trace dropped: store write failed (${
        error instanceof Error ? error.message : String(error)
      })`;
      warnings.push(redactionNote);
      sessionRef = null;
    }
  }

  // ── Identity + ledger. ──
  let changeId: string;
  try {
    const resolution = await resolveChangeId(head, ctx);
    changeId = resolution.changeId;
  } catch (error) {
    return {
      status: "failed-soft",
      reason: `could not resolve change-id for ${head.slice(0, 8)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    const subject = await readCommitSubject(head, ctx);
    const human = await readUserEmail(ctx);
    const scope = await scopeFromCommit(head, ctx);

    const entry: LedgerEntry = {
      schema: "git-for-ai/ledger-entry@1",
      change_id: changeId,
      revision: head,
      created_at: new Date().toISOString(),
      author: {
        type: "agent",
        tool: "claude-code",
        ...(meta.model !== undefined ? { model: meta.model } : {}),
        ...(human !== null ? { human } : {}),
      },
      scope,
      summary: subject !== "" ? subject : "(no commit subject)",
      ...(planText !== undefined ? { reasoning: { intent: firstLine(planText) } } : {}),
      session_ref: sessionRef,
      provenance: "agent-captured",
      ...(redactionNote !== undefined ? { redaction_note: redactionNote } : {}),
    };
    await appendLedgerEntry(changeId, entry, { cwd: repoRoot });
  } catch (error) {
    return {
      status: "failed-soft",
      reason: `could not write ledger entry for ${head.slice(0, 8)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // ── Advance the slice markers and clear the consumed plan (best-effort). ──
  const persisted = await updateSessionCaptureState(repoRoot, sessionId, {
    last_captured_commit: head,
    ...(consumedLines !== undefined ? { last_captured_line: consumedLines } : {}),
    plan: null,
    plan_buffered_at: null,
  });
  if (!persisted) {
    warnings.push("capture state not persisted (state.json unusable) — next capture may re-slice");
  }

  return {
    status: "captured",
    commitSha: head,
    changeId,
    sessionRef,
    spanCount: record?.spans.length ?? 0,
    redactedCount,
    degraded,
    ...(degradedReason !== undefined ? { degradedReason } : {}),
    warnings,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "");
  return (line ?? text).trim();
}

/** Small human summary for the record (embedded later — ARCHITECTURE.md §11.1). */
function buildSessionSummary(spans: readonly Span[], commitSubject: string): string {
  const planCount = spans.filter((s) => s.kind === "agent.plan").length;
  const toolCount = spans.filter((s) => s.kind === "gen_ai.tool.execution").length;
  const completionCount = spans.filter((s) => s.kind === "gen_ai.completion").length;
  const parts = [
    planCount > 0 ? "plan" : null,
    `${toolCount} tool execution(s)`,
    `${completionCount} model turn(s)`,
  ].filter((p): p is string => p !== null);
  const suffix = commitSubject !== "" ? ` for commit "${commitSubject}"` : "";
  return `claude-code session: ${parts.join(", ")}${suffix}.`;
}

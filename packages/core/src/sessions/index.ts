// Agent session capture — architecture/ARCHITECTURE.md §10 (hook flow), §13 (redaction),
// DATA_MODEL.md §3 (record shape + content addressing). Milestone 7.
//
// Layout:
//   redaction.ts      the §13 fail-closed redaction pass (rules, ignore-globs, size caps)
//   transcript.ts     the VERSIONED Claude Code JSONL adapter (fails soft to plan-only)
//   store.ts          content-addressed session blobs behind refs/git-for-ai/sessions
//   state.ts          plan buffer + slice markers in .git-for-ai/state.json
//   captureConfig.ts  defensive read of config.toml's capture/redaction settings
//   capture.ts        the orchestrator: captureSession(payload, event) — never throws

export {
  BUILTIN_RULESET_VERSION,
  BUILTIN_REDACTION_RULES,
  DEFAULT_MAX_SPAN_BYTES,
  TRUNCATED_MARKER,
  redactionMarker,
  patternRule,
  matchesNeverCapture,
  redactSpans,
} from "./redaction.js";
export type { RedactionRule, RedactSpansOptions, RedactSpansResult } from "./redaction.js";

export {
  CLAUDE_CODE_TRANSCRIPT_FINGERPRINT,
  PLAN_ONLY_FINGERPRINT,
  parseTranscriptSlice,
} from "./transcript.js";
export type {
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptMeta,
} from "./transcript.js";

export {
  SESSIONS_REF,
  sessionShardPath,
  contentAddressSessionRecord,
  readSessionsCommit,
  writeSessionRecord,
  readSessionRecord,
} from "./store.js";
export type { WriteSessionRecordResult } from "./store.js";

export {
  STATE_FILE_RELPATH,
  readSessionCaptureState,
  updateSessionCaptureState,
} from "./state.js";
export type { SessionCaptureState } from "./state.js";

export { DEFAULT_CAPTURE_SETTINGS, readCaptureSettings } from "./captureConfig.js";
export type { CaptureSettings } from "./captureConfig.js";

export {
  captureSession,
  toHookPayload,
  isGitCommitCommand,
  toolResponseIndicatesFailure,
} from "./capture.js";
export type {
  CaptureEventKind,
  CaptureSessionOptions,
  CaptureSessionResult,
  HookPayload,
} from "./capture.js";

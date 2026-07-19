// Zod schemas + inferred TypeScript types for the git-for-ai record formats
// (ledger entry, session record, change-map entry, repo config).
// See ../../../architecture/DATA_MODEL.md for the spec this implements, and
// ../../../architecture/CLI_PLAN.md Milestone 1 for the build-out plan.

export {
  changeIdSchema,
  gitShaSchema,
  timestampSchema,
  sessionRefSchema,
  relatedRefSchema,
} from "./common.js";
export type {
  ChangeId,
  GitSha,
  Timestamp,
  SessionRef,
  RelatedRef,
} from "./common.js";

export {
  scopeItemSchema,
  authorSchema,
  rejectedAlternativeSchema,
  reasoningSchema,
  provenanceSchema,
  ledgerEntrySchema,
  ledgerNoteSchema,
  ledgerNoteLineSchema,
  LEDGER_NOTE_JSONL_SCHEMA,
} from "./ledger.js";
export type {
  ScopeItem,
  Author,
  RejectedAlternative,
  Reasoning,
  Provenance,
  LedgerEntry,
  LedgerNote,
  LedgerNoteLine,
} from "./ledger.js";

export {
  spanKindSchema,
  spanSchema,
  sessionAgentSchema,
  commitRangeSchema,
  redactionInfoSchema,
  sessionRecordSchema,
} from "./session.js";
export type {
  SpanKind,
  Span,
  SessionAgent,
  CommitRange,
  RedactionInfo,
  SessionRecord,
} from "./session.js";

export {
  changeMapOriginSchema,
  changeMapEntrySchema,
} from "./change-map.js";
export type { ChangeMapOrigin, ChangeMapEntry } from "./change-map.js";

export {
  embedderProviderSchema,
  embedderConfigSchema,
  captureConfigSchema,
  redactionConfigSchema,
  indexConfigSchema,
  repoConfigSchema,
} from "./repo-config.js";
export type {
  EmbedderProvider,
  EmbedderConfig,
  CaptureConfig,
  RedactionConfig,
  IndexConfig,
  RepoConfig,
} from "./repo-config.js";

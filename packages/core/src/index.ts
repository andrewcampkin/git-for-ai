// Public API surface for @git-for-ai/core.
//
// Currently exposes the Milestone 2 git access layer (architecture/ARCHITECTURE.md §4.1),
// the Milestone 3 identity assignment/resolution module (§7), the Milestone 4 ledger
// read/write module (§6.1, §12.2), the Milestone 7 session-capture module (§10, §13),
// and the Milestone 9 embedding pipeline + vector store (§11), which the CLI package
// builds on. Later milestones add: query(question), reindex(), sync({ push | fetch }).
// See ../../../architecture/CLI_PLAN.md for the milestone-by-milestone build order.
//
// NOTE: the test-only `createFixtureRepo` helper is deliberately NOT exported here — it is
// published under the `@git-for-ai/core/testing` subpath (see package.json `exports`) so
// consuming packages' test suites can use it without it leaking into the production API.

export { runGit, GitError } from "./git/index.js";
export type { RunGitOptions, GitResult } from "./git/index.js";

export { readHead, readCommitMessage, catFile, listRefs, revParse, lsTree } from "./git/index.js";
export type { RefInfo, TreeEntry } from "./git/index.js";

export { notesShow, notesAppend, notesMerge } from "./git/index.js";
export type { NotesMergeStrategy, NotesMergeOptions } from "./git/index.js";

export { hashObject, mktree, commitTree, updateRef } from "./git/index.js";
export type {
  GitObjectType,
  HashObjectOptions,
  MktreeEntry,
  CommitTreeOptions,
  UpdateRefOptions,
} from "./git/index.js";

// Milestone 3 — identity assignment + resolution (ARCHITECTURE.md §7).
export {
  mintChangeId,
  normalizeChangeId,
  parseChangeIdTrailer,
  formatChangeIdTrailer,
  CHANGE_MAP_REF,
  shardPathFor,
  readChangeMapCommit,
  readChangeMapEntry,
  readAllChangeMapEntries,
  findEntryByCommitSha,
  upsertChangeMapEntries,
  assignChangeId,
  resolveChangeId,
  DEFAULT_INFER_SIMILARITY_THRESHOLD,
  onPostRewrite,
  parsePostRewriteInput,
  INTENT_NOTES_REF,
} from "./identity/index.js";
export type {
  GitContext,
  UpsertChangeMapOptions,
  AssignChangeIdResult,
  ResolutionBranch,
  ResolveChangeIdOptions,
  ResolveChangeIdResult,
  RewritePair,
  PostRewriteResult,
} from "./identity/index.js";

// Milestone 4 — ledger intent read/write (ARCHITECTURE.md §6.1, §12.2).
// (ledger/index.js also exports an INTENT_NOTES_REF constant identical in value to the
// identity one re-exported above; it is deliberately not re-exported again here to avoid
// a name collision at the package root.)
export {
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerNote,
  readLedgerEntries,
  resolveEffectiveEntry,
  canonicalJsonStringify,
} from "./ledger/index.js";
export type { LedgerNoteOptions } from "./ledger/index.js";

// Milestone 7 — agent session capture (ARCHITECTURE.md §10, §13; DATA_MODEL.md §3).
export {
  BUILTIN_RULESET_VERSION,
  BUILTIN_REDACTION_RULES,
  DEFAULT_MAX_SPAN_BYTES,
  TRUNCATED_MARKER,
  redactionMarker,
  patternRule,
  matchesNeverCapture,
  redactSpans,
  CLAUDE_CODE_TRANSCRIPT_FINGERPRINT,
  PLAN_ONLY_FINGERPRINT,
  parseTranscriptSlice,
  SESSIONS_REF,
  sessionShardPath,
  contentAddressSessionRecord,
  readSessionsCommit,
  writeSessionRecord,
  readSessionRecord,
  STATE_FILE_RELPATH,
  readSessionCaptureState,
  updateSessionCaptureState,
  DEFAULT_CAPTURE_SETTINGS,
  readCaptureSettings,
  captureSession,
  toHookPayload,
  isGitCommitCommand,
  toolResponseIndicatesFailure,
} from "./sessions/index.js";
export type {
  RedactionRule,
  RedactSpansOptions,
  RedactSpansResult,
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptMeta,
  WriteSessionRecordResult,
  SessionCaptureState,
  CaptureSettings,
  CaptureEventKind,
  CaptureSessionOptions,
  CaptureSessionResult,
  HookPayload,
} from "./sessions/index.js";

// Milestone 9 — embedding pipeline + vector store (ARCHITECTURE.md §11; DATA_MODEL.md §5).
export {
  modelFingerprint,
  chunkSourceFile,
  languageForPath,
  TransformersEmbedder,
  TRANSFORMERS_MODELS,
  VoyageEmbedder,
  VoyageConsentError,
  VoyageApiError,
  createEmbedderFromConfig,
  SqliteVectorStore,
  IndexFingerprintError,
  VEC_SCHEMA_VERSION,
  toFtsQuery,
  EmbeddingCache,
  embedChunksWithCache,
  INDEX_STATE_SCHEMA,
  IndexStateFormatError,
  indexStatePath,
  readIndexState,
  updateIndexState,
} from "./embeddings/index.js";
export type {
  Chunk,
  Embedder,
  ChunkLanguage,
  ChunkKind,
  CodeChunk,
  ChunkSourceFileOptions,
  TransformersEmbedderOptions,
  TransformersModelSpec,
  VoyageEmbedderOptions,
  CreateEmbedderOptions,
  VectorStore,
  VectorStoreItem,
  StoredChunk,
  VectorMatch,
  KeywordMatch,
  IndexedKind,
  OpenVectorStoreOptions,
  EmbeddingCacheOptions,
  CacheableChunk,
  EmbedWithCacheResult,
  IndexState,
  IndexStateFields,
} from "./embeddings/index.js";

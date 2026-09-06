// Public API surface for @git-for-ai/core.
//
// Exposes the git access layer (architecture/ARCHITECTURE.md §4.1), the identity
// assignment/resolution module (§7), the ledger read/write module (§6.1, §12.2), the
// session-capture module (§10, §13), the embedding pipeline + vector store (§11), and the
// query engine (§9.1, §11.4), which the CLI package builds on.
//
// NOTE: the test-only `createFixtureRepo` helper is deliberately NOT exported here — it is
// published under the `@git-for-ai/core/testing` subpath (see package.json `exports`) so
// consuming packages' test suites can use it without it leaking into the production API.

export { runGit, GitError } from "./git/index.js";
export type { RunGitOptions, GitResult } from "./git/index.js";

export { readHead, readCommitMessage, catFile, catFileBatch, listRefs, revParse, lsTree } from "./git/index.js";
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

// Identity assignment + resolution (ARCHITECTURE.md §7).
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
  readChangeMapSnapshot,
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
  ChangeMapSnapshot,
  AssignChangeIdResult,
  ResolutionBranch,
  ResolveChangeIdOptions,
  ResolveChangeIdResult,
  RewritePair,
  PostRewriteResult,
} from "./identity/index.js";

// Ledger intent read/write (ARCHITECTURE.md §6.1, §12.2).
// (ledger/index.js also exports an INTENT_NOTES_REF constant identical in value to the
// identity one re-exported above; it is deliberately not re-exported again here to avoid
// a name collision at the package root.)
export {
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerNote,
  readLedgerNoteWithFormat,
  readLedgerEntries,
  readLedgerNotesForCommits,
  parseLedgerNoteBody,
  serializeLedgerNote,
  resolveEffectiveEntry,
  canonicalJsonStringify,
} from "./ledger/index.js";
export type {
  LedgerNoteOptions,
  LedgerNoteStoredFormat,
  LedgerNoteReadResult,
} from "./ledger/index.js";

// Agent session capture (ARCHITECTURE.md §10, §13; DATA_MODEL.md §3).
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
  readSessionRecords,
  mergeSessionsFrom,
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
  SessionsMergeAction,
  SessionsMergeResult,
  SessionCaptureState,
  CaptureSettings,
  CaptureEventKind,
  CaptureSessionOptions,
  CaptureSessionResult,
  HookPayload,
} from "./sessions/index.js";

// Embedding pipeline + vector store (ARCHITECTURE.md §11; DATA_MODEL.md §5).
export {
  modelFingerprint,
  chunkSourceFile,
  languageForPath,
  TransformersEmbedder,
  TRANSFORMERS_MODELS,
  resolveTransformersDevice,
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
  TransformersDevice,
  TransformersDtype,
  ResolvedTransformersDevice,
  ResolveTransformersDeviceOptions,
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

// Query engine: hybrid retrieval + synthesis (ARCHITECTURE.md §9.1, §11.4).
// `askQuestion`/`explainLine` are the two entry points the CLI's
// `ask` and `blame --why` commands wrap; retrieval is fully local, synthesis calls the
// Anthropic API only when ANTHROPIC_API_KEY is configured (ranked-raw-sources fallback
// otherwise, never an error).
export {
  DEFAULT_RRF_K,
  DEFAULT_TOP_K,
  retrieveSources,
  fuseMatches,
  toRetrievalPosition,
  createQueryEmbedderFromConfig,
  enrichSources,
  readChangeLedger,
  resolveChangeIdReadOnly,
  followFoldedInto,
  blameLineCommit,
  findLaterTouches,
  DEFAULT_SYNTHESIS_MODEL,
  DEFAULT_MAX_TOOL_ITERATIONS,
  SYNTHESIS_MODEL_ENV,
  SYNTHESIS_KEY_ENV,
  buildSynthesisPrompt,
  extractCitations,
  synthesizeAnswer,
  askQuestion,
  explainLine,
} from "./query/index.js";
export type {
  RetrievalPosition,
  RetrieveOptions,
  ChangeLedger,
  SynthesisOptions,
  SynthesisPrompt,
  SynthesisTool,
  AskDeps,
  AskOptions,
  BlameWhyDeps,
  BlameWhyOptions,
  MatchSide,
  PositionBoost,
  RankedSource,
  EnrichedSource,
  SynthesisSkipReason,
  SynthesisToolCall,
  SynthesisResult,
  AskResult,
  BlamePosition,
  RelatedChangeRef,
  BlameWhyResult,
} from "./query/index.js";

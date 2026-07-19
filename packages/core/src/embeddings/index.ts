// Embedding pipeline + vector store — architecture/ARCHITECTURE.md §11 (Milestone 9).
//
// Four cooperating pieces:
// - chunking.ts             tree-sitter (WASM) chunker at function/class granularity (§11.1)
// - types.ts / transformersEmbedder.ts / voyageEmbedder.ts / factory.ts
//                           the pluggable Embedder interface (§11.3): offline
//                           transformers.js default + consent-gated Voyage AI opt-in
// - store.ts                VectorStore over node:sqlite + sqlite-vec, with an FTS5
//                           keyword mirror for hybrid retrieval (§11.4)
// - cache.ts / state.ts     blob-hash embedding cache (embcache/, §8.2/§11.2) and
//                           state.json bookkeeping (DATA_MODEL.md §5.1)

export { modelFingerprint } from "./types.js";
export type { Chunk, Embedder } from "./types.js";

export { chunkSourceFile, languageForPath } from "./chunking.js";
export type { ChunkLanguage, ChunkKind, CodeChunk, ChunkSourceFileOptions } from "./chunking.js";

export {
  TransformersEmbedder,
  TRANSFORMERS_MODELS,
  resolveTransformersDevice,
} from "./transformersEmbedder.js";
export type {
  TransformersEmbedderOptions,
  TransformersModelSpec,
  TransformersDevice,
  TransformersDtype,
  ResolvedTransformersDevice,
  ResolveTransformersDeviceOptions,
} from "./transformersEmbedder.js";

export { VoyageEmbedder, VoyageConsentError, VoyageApiError } from "./voyageEmbedder.js";
export type { VoyageEmbedderOptions } from "./voyageEmbedder.js";

export { createEmbedderFromConfig } from "./factory.js";
export type { CreateEmbedderOptions } from "./factory.js";

export { SqliteVectorStore, IndexFingerprintError, VEC_SCHEMA_VERSION, toFtsQuery } from "./store.js";
export type {
  VectorStore,
  VectorStoreItem,
  StoredChunk,
  VectorMatch,
  KeywordMatch,
  IndexedKind,
  OpenVectorStoreOptions,
} from "./store.js";

export { EmbeddingCache, embedChunksWithCache } from "./cache.js";
export type { EmbeddingCacheOptions, CacheableChunk, EmbedWithCacheResult } from "./cache.js";

export {
  INDEX_STATE_SCHEMA,
  IndexStateFormatError,
  indexStatePath,
  readIndexState,
  updateIndexState,
} from "./state.js";
export type { IndexState, IndexStateFields } from "./state.js";

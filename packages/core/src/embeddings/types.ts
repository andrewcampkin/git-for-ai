// The pluggable embedding-provider interface — architecture/ARCHITECTURE.md §11.3.
//
// The `Embedder` interface below matches §11.3's TypeScript shape exactly (id / dim /
// maxTokens / isOffline / embed). The one thing §11.3 left open is what a `Chunk` is:
// code chunks come from the tree-sitter chunker (./chunking.ts), but ledger entries and
// session summaries are embedded too (§11.1 — "three content kinds, one space"), so the
// base `Chunk` here is deliberately minimal: anything with a `text`. `CodeChunk`
// (chunking.ts) extends it with path/line/node-path metadata.

/**
 * The minimal unit an embedder consumes. Code chunks, ledger-entry text, and session
 * summaries all satisfy this — the embedder only ever looks at `text`.
 */
export interface Chunk {
  readonly text: string;
}

/**
 * Pluggable embedding provider (ARCHITECTURE.md §11.3, verbatim shape).
 *
 * Implementations in this package:
 * - {@link import("./transformersEmbedder.js").TransformersEmbedder} — the offline
 *   default (@xenova/transformers, in-process ONNX).
 * - {@link import("./voyageEmbedder.js").VoyageEmbedder} — opt-in Voyage AI API,
 *   hard-gated behind the `voyage_consent` config flag.
 */
export interface Embedder {
  /** e.g. `"transformers-jina-v2-code"`, `"voyage-code-3"`. */
  readonly id: string;
  /** Output vector dimensionality. Part of the model fingerprint. */
  readonly dim: number;
  /** Max input tokens the model accepts per chunk. */
  readonly maxTokens: number;
  /** Gates the "offline by default" guarantee (ARCHITECTURE.md §2.1). */
  readonly isOffline: boolean;
  /** Embed each chunk's text; result[i] corresponds to chunks[i], each of length `dim`. */
  embed(chunks: Chunk[]): Promise<Float32Array[]>;
}

/**
 * The `model_fingerprint` recorded in `.git-for-ai/state.json` (DATA_MODEL.md §5.1):
 * `<provider>/<dim>`, e.g. `"jina-v2-code/768"`. Uses the *config provider name* (the
 * `embedder.provider` enum), not the embedder implementation id, matching what
 * `git for-ai init` (M5) already writes. Vectors from different fingerprints are never
 * mixed in one index (ARCHITECTURE.md §11.3 — "model change ⇒ reindex").
 */
export function modelFingerprint(provider: string, dim: number): string {
  return `${provider}/${dim}`;
}

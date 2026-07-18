// The default, offline, in-process embedder — architecture/ARCHITECTURE.md §11.3.
//
// Runs an open-weight code embedding model as ONNX entirely inside the Node process via
// @xenova/transformers (transformers.js). No Python, no server, no network call after the
// model has been downloaded once (transformers.js caches weights on disk and serves every
// later run from that cache).
//
// ── Judgment calls ──
// 1. Model resolution: the repo config's provider enum (`jina-v2-code`) maps to the
//    Hugging Face model id `jinaai/jina-embeddings-v2-base-code` (dim 768, 8192-token
//    ALiBi window) — the exact model DATA_MODEL.md §5 pins as the default. Jina publishes
//    ONNX weights (including a quantized variant) in that repo specifically for
//    transformers.js, so no conversion step is needed. `nomic-embed-code` is in the
//    provider enum but its published model is a 7B-parameter LLM — far beyond what an
//    in-process CLI embedder should load — so constructing it here throws an honest
//    "not supported" error rather than pretending. (Voyage is the separate API-backed
//    implementation in ./voyageEmbedder.ts.)
// 2. Lazy loading: the model pipeline is created on first `embed()`, not in the
//    constructor, so metadata (id/dim/isOffline) is inspectable — and testable — without
//    triggering a multi-hundred-MB first-run download.
// 3. Mean pooling + L2 normalization, matching the model card's usage. Normalized
//    vectors make cosine similarity and (sqlite-vec's default) L2 distance rank
//    identically, so the store can use plain L2.
// 4. Batching: inputs are fed to the pipeline in batches of 16 to bound peak memory on
//    large reindex runs; transformers.js pads within a batch.
// 5. Dimensionality is asserted against the model's actual output on first embed — a
//    mismatch throws instead of silently writing wrong-shaped vectors into the index.

import type { Chunk, Embedder } from "./types.js";

/** Providers the in-process transformers.js embedder can actually run. */
export interface TransformersModelSpec {
  /** Hugging Face model id. */
  model: string;
  dim: number;
  maxTokens: number;
}

export const TRANSFORMERS_MODELS: Record<string, TransformersModelSpec> = {
  "jina-v2-code": {
    model: "jinaai/jina-embeddings-v2-base-code",
    dim: 768,
    maxTokens: 8192,
  },
};

export interface TransformersEmbedderOptions {
  /** Config provider name. Default `"jina-v2-code"` (the repo default, DATA_MODEL.md §5). */
  provider?: string;
  /** Override the Hugging Face model id (e.g. to pin a mirror). */
  model?: string;
  /** Override the on-disk model cache directory (transformers.js `env.cacheDir`). */
  cacheDir?: string;
  /** Load the quantized ONNX weights (smaller download, minor quality cost). Default true. */
  quantized?: boolean;
  /** Batch size fed to the pipeline per forward pass. Default 16. */
  batchSize?: number;
}

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>;

export class TransformersEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  readonly maxTokens: number;
  readonly isOffline = true;
  /** Config provider name this instance implements (for model fingerprinting). */
  readonly provider: string;
  /** Hugging Face model id actually loaded. */
  readonly model: string;

  private readonly quantized: boolean;
  private readonly batchSize: number;
  private readonly cacheDir: string | undefined;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(options: TransformersEmbedderOptions = {}) {
    const provider = options.provider ?? "jina-v2-code";
    const spec = TRANSFORMERS_MODELS[provider];
    if (spec === undefined) {
      throw new Error(
        `embedding provider "${provider}" is not supported by the in-process transformers.js ` +
          `embedder (supported: ${Object.keys(TRANSFORMERS_MODELS).join(", ")}). ` +
          `For voyage-code-3 use the VoyageEmbedder (explicit opt-in required).`,
      );
    }
    this.provider = provider;
    this.model = options.model ?? spec.model;
    this.id = `transformers-${provider}`;
    this.dim = spec.dim;
    this.maxTokens = spec.maxTokens;
    this.quantized = options.quantized ?? true;
    this.batchSize = options.batchSize ?? 16;
    this.cacheDir = options.cacheDir;
  }

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= (async () => {
      const transformers = await import("@xenova/transformers");
      if (this.cacheDir !== undefined) {
        transformers.env.cacheDir = this.cacheDir;
      }
      const extractor = await transformers.pipeline("feature-extraction", this.model, {
        quantized: this.quantized,
      });
      return extractor as unknown as FeatureExtractionPipeline;
    })();
    return this.pipelinePromise;
  }

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    if (chunks.length === 0) {
      return [];
    }
    const extractor = await this.loadPipeline();
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < chunks.length; offset += this.batchSize) {
      const batch = chunks.slice(offset, offset + this.batchSize).map((c) => c.text);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const [rows, dim] = [output.dims[0], output.dims[output.dims.length - 1]];
      if (rows !== batch.length || dim !== this.dim) {
        throw new Error(
          `model "${this.model}" returned shape [${output.dims.join(", ")}] for a batch of ` +
            `${batch.length}; expected [${batch.length}, ${this.dim}]. ` +
            `The configured dim and the actual model disagree — fix the config or reindex --full.`,
        );
      }
      for (let row = 0; row < batch.length; row += 1) {
        // Copy each row out of the flat batch buffer so vectors don't alias each other.
        vectors.push(output.data.slice(row * this.dim, (row + 1) * this.dim));
      }
    }
    return vectors;
  }
}

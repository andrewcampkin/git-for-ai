// The default, offline, in-process embedder — architecture/ARCHITECTURE.md §11.3,
// GPU path per architecture/ROADMAP.md Tier 0 item 1 (owner-chosen, 2026-07-19).
//
// Runs an open-weight code embedding model as ONNX entirely inside the Node process via
// @huggingface/transformers (transformers.js v3 — the maintained successor of
// @xenova/transformers v2, migrated here for its modern onnxruntime-node with GPU
// execution providers). No Python, no server, no network call after the model has been
// downloaded once (weights are cached on disk and served from that cache afterwards).
//
// ── Judgment calls ──
// 1. Model resolution: the repo config's provider enum (`jina-v2-code`) maps to the
//    Hugging Face model id `jinaai/jina-embeddings-v2-base-code` (dim 768, 8192-token
//    ALiBi window) — the exact model DATA_MODEL.md §5 pins as the default. Jina publishes
//    ONNX weights (fp32 `model.onnx`, fp16 `model_fp16.onnx`, int8 `model_quantized.onnx`)
//    in that repo specifically for transformers.js, so no conversion step is needed.
//    `nomic-embed-code` is in the provider enum but its published model is a 7B-parameter
//    LLM — far beyond what an in-process CLI embedder should load — so constructing it
//    here throws an honest "not supported" error rather than pretending. (Voyage is the
//    separate API-backed implementation in ./voyageEmbedder.ts.)
// 2. Device/precision resolution (ROADMAP Tier 0): `resolveTransformersDevice()` is PURE
//    and deterministic — no probing, no model load — because the resolved precision folds
//    into the model fingerprint and the fingerprint must be computable before the store is
//    opened. "auto" (the default) selects DirectML + fp16 on win32 and CPU + int8
//    elsewhere; GIT_FOR_AI_DEVICE / GIT_FOR_AI_DTYPE (or the constructor options) override
//    explicitly. If DirectML then fails at actual model load, that is a HARD error with an
//    actionable message (set GIT_FOR_AI_DEVICE=cpu) — NEVER a silent CPU fallback, because
//    by then the fingerprint has already been fixed and int8 vectors must not land in an
//    fp16-labelled index (§11.3 "never mix").
// 3. Precision naming: int8/q8 is the historical default and maps to the LEGACY bare
//    fingerprint (`jina-v2-code/768`), so existing CPU-built indexes and embcaches stay
//    valid across this migration. fp16/fp32 append a suffix (`jina-v2-code/768/fp16`),
//    which forces the designed IndexFingerprintError → `reindex --full` migration when a
//    machine switches to GPU. See modelFingerprint() in ./types.ts.
// 4. Lazy loading: the pipeline is created on first `embed()`, not in the constructor, so
//    metadata (id/dim/device/precision) is inspectable — and testable — without triggering
//    a multi-hundred-MB first-run download.
// 5. Mean pooling + L2 normalization, matching the model card's usage. Normalized vectors
//    make cosine similarity and (sqlite-vec's default) L2 distance rank identically.
// 6. Batching: inputs are fed to the pipeline in batches of 16 to bound peak memory;
//    transformers.js pads within a batch.
// 7. ORT memory bounding (ROADMAP Tier 0 item 3): the observed native OOM ("bad
//    allocation") after ~700 chunks pointed at allocator growth across one long-lived
//    session, so the inference session is disposed and recreated every
//    `recreateAfterChunks` embedded chunks (default 512 — below the observed failure
//    point; a reload from the disk cache costs seconds).
// 8. Dimensionality is asserted against the model's actual output on first embed — a
//    mismatch throws instead of silently writing wrong-shaped vectors into the index.
//    fp16 exports normally keep fp32 tensor I/O; if an output tensor ever arrives as a
//    non-float32 array we attempt Tensor.to("float32") and otherwise fail loudly rather
//    than reinterpret raw fp16 bits as numbers.
// 9. DML batch packing (found the hard way on the first real GPU run): DirectML caps a
//    single tensor at 2^32 elements, and the attention-score tensor for a padded batch
//    is rows × heads × maxTokens² — a batch of 13 chunks padded to 5711 tokens blew it
//    ("FusedMatMul ... The parameter is incorrect", error 0x80070057). On the dml device
//    batches are therefore packed by REAL tokenized length (the pipeline's own
//    tokenizer) so rows × maxTokens² stays under DML_BATCH_COST_BUDGET. Vectors are
//    bit-identical to unpacked ones — only batch boundaries move, nothing is truncated.
//    CPU keeps plain fixed-size batching.

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

/** Devices the embedder can resolve to. `"auto"` is accepted as a REQUEST, never a result. */
export type TransformersDevice = "dml" | "cpu";

/** Weight precisions we load. `"q8"` is the historical int8 default (CPU). */
export type TransformersDtype = "fp16" | "fp32" | "q8";

/** The outcome of device/precision resolution — pure, computed before any model load. */
export interface ResolvedTransformersDevice {
  device: TransformersDevice;
  dtype: TransformersDtype;
  /** Human-readable one-liner explaining WHY (for honest progress logs). */
  reason: string;
}

const VALID_DEVICES = new Set(["auto", "dml", "cpu"]);
const VALID_DTYPES = new Set<string>(["fp16", "fp32", "q8"]);

export interface ResolveTransformersDeviceOptions {
  /** Requested device: `"auto"` (default) | `"dml"` | `"cpu"`. Overrides GIT_FOR_AI_DEVICE. */
  device?: string | undefined;
  /** Requested precision: `"fp16"` | `"fp32"` | `"q8"`. Overrides GIT_FOR_AI_DTYPE. */
  dtype?: string | undefined;
  /** Injectable for tests. Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests. Default `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve which device + weight precision the embedder will use. Deterministic and
 * side-effect free (judgment call #2): callers fold the result into the model
 * fingerprint BEFORE any model is loaded, so resolution must never depend on probing.
 *
 * Precedence: explicit option > GIT_FOR_AI_DEVICE / GIT_FOR_AI_DTYPE env > "auto".
 * "auto" = DirectML + fp16 on win32 (int8 does not accelerate on GPU), CPU + int8
 * elsewhere, with the reason recorded for logging. Invalid values throw honestly.
 */
export function resolveTransformersDevice(
  options: ResolveTransformersDeviceOptions = {},
): ResolvedTransformersDevice {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const rawDevice = (options.device ?? env["GIT_FOR_AI_DEVICE"] ?? "auto").trim().toLowerCase();
  if (!VALID_DEVICES.has(rawDevice)) {
    throw new Error(
      `invalid embedder device "${rawDevice}" (from ${options.device !== undefined ? "options" : "GIT_FOR_AI_DEVICE"}); ` +
        `valid values: auto, dml, cpu`,
    );
  }
  const rawDtype = (options.dtype ?? env["GIT_FOR_AI_DTYPE"] ?? "").trim().toLowerCase();
  if (rawDtype !== "" && !VALID_DTYPES.has(rawDtype)) {
    throw new Error(
      `invalid embedder dtype "${rawDtype}" (from ${options.dtype !== undefined ? "options" : "GIT_FOR_AI_DTYPE"}); ` +
        `valid values: fp16, fp32, q8`,
    );
  }
  const dtypeOverride = rawDtype === "" ? undefined : (rawDtype as TransformersDtype);

  if (rawDevice === "cpu") {
    return {
      device: "cpu",
      dtype: dtypeOverride ?? "q8",
      reason: "explicitly requested CPU",
    };
  }
  if (rawDevice === "dml") {
    if (platform !== "win32") {
      throw new Error(
        `GIT_FOR_AI_DEVICE=dml requested but DirectML is Windows-only (platform: ${platform}); ` +
          `use GIT_FOR_AI_DEVICE=cpu or auto`,
      );
    }
    return {
      device: "dml",
      dtype: dtypeOverride ?? "fp16",
      reason: "explicitly requested DirectML",
    };
  }
  // "auto"
  if (platform === "win32") {
    return {
      device: "dml",
      dtype: dtypeOverride ?? "fp16",
      reason: "auto-selected DirectML on win32 (set GIT_FOR_AI_DEVICE=cpu to override)",
    };
  }
  return {
    device: "cpu",
    dtype: dtypeOverride ?? "q8",
    reason: `DirectML is unavailable on ${platform}; using CPU int8`,
  };
}

export interface TransformersEmbedderOptions {
  /** Config provider name. Default `"jina-v2-code"` (the repo default, DATA_MODEL.md §5). */
  provider?: string;
  /** Override the Hugging Face model id (e.g. to pin a mirror). */
  model?: string;
  /** Override the on-disk model cache directory (transformers.js `env.cacheDir`). */
  cacheDir?: string;
  /** Device request: `"auto"` (default) | `"dml"` | `"cpu"`. Overrides GIT_FOR_AI_DEVICE. */
  device?: string;
  /** Weight precision: `"fp16"` | `"fp32"` | `"q8"`. Overrides GIT_FOR_AI_DTYPE. */
  dtype?: string;
  /**
   * DEPRECATED (v2 legacy): `quantized: true` ⇒ dtype "q8", `false` ⇒ dtype "fp32".
   * Ignored when `dtype` is given.
   */
  quantized?: boolean;
  /** Batch size fed to the pipeline per forward pass. Default 16. */
  batchSize?: number;
  /**
   * Dispose + recreate the ONNX inference session after this many embedded chunks, to
   * bound ORT allocator growth (judgment call #7). Default 512; 0 disables recreation.
   */
  recreateAfterChunks?: number;
}

interface OutputTensor {
  dims: number[];
  data: Float32Array | ArrayLike<number>;
  to?: (dtype: string) => OutputTensor;
}

interface TokenizerEncoding {
  input_ids: { dims: number[] };
}

type FeatureExtractionPipeline = ((
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<OutputTensor>) & {
  dispose?: () => Promise<void>;
  /** The pipeline's own tokenizer — used for DML batch packing (judgment call #9). */
  tokenizer?: (text: string) => TokenizerEncoding | Promise<TokenizerEncoding>;
};

/**
 * DML packing budget for rows × maxTokens² per batch (judgment call #9). Two limits
 * bind, measured on the RTX 3060 during the first real GPU runs:
 *  - DirectML caps one tensor at 2^32 ELEMENTS (rows × 12 heads × maxTokens² — a batch
 *    of 13 × 5711² blew it with 0x80070057 "parameter is incorrect");
 *  - VRAM: the fp16 attention-score tensor costs rows × 12 × maxTokens² × 2 bytes, and
 *    ORT holds several buffers of that order — 6 × 5711² (≈4.7 GB scores alone) OOMed
 *    with 0x8007000E on the 12 GB card.
 * 40e6 keeps the scores tensor ≤ ~1 GB (12 heads × 2 B × 40e6). Typical 500-token
 * chunks still pack 16 wide (16 × 500² = 4e6). A single sequence is always allowed
 * regardless of budget — the model max (8192² = 67e6) exceeds it by design.
 */
const DML_BATCH_COST_BUDGET = 40_000_000;

export class TransformersEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  readonly maxTokens: number;
  readonly isOffline = true;
  /** Config provider name this instance implements (for model fingerprinting). */
  readonly provider: string;
  /** Hugging Face model id actually loaded. */
  readonly model: string;
  /** Resolved execution device (never "auto" — resolution happened in the constructor). */
  readonly device: TransformersDevice;
  /** Resolved weight precision; also exposed as {@link precision} for fingerprinting. */
  readonly dtype: TransformersDtype;
  /** Why this device/precision was chosen — surface this in progress logs. */
  readonly deviceReason: string;
  /**
   * Precision tag folded into the model fingerprint (Embedder.precision).
   * "q8" maps to the legacy bare fingerprint — see modelFingerprint() in ./types.ts.
   */
  readonly precision: string;

  private readonly batchSize: number;
  private readonly recreateAfterChunks: number;
  private readonly cacheDir: string | undefined;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private chunksSinceLoad = 0;

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

    const legacyDtype =
      options.dtype === undefined && options.quantized !== undefined
        ? options.quantized
          ? "q8"
          : "fp32"
        : undefined;
    const resolved = resolveTransformersDevice({
      device: options.device,
      dtype: options.dtype ?? legacyDtype,
    });
    this.device = resolved.device;
    this.dtype = resolved.dtype;
    this.deviceReason = resolved.reason;
    this.precision = resolved.dtype;

    this.batchSize = options.batchSize ?? 16;
    this.recreateAfterChunks = options.recreateAfterChunks ?? 512;
    this.cacheDir = options.cacheDir;
  }

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= (async () => {
      const transformers = await import("@huggingface/transformers");
      if (this.cacheDir !== undefined) {
        transformers.env.cacheDir = this.cacheDir;
      }
      try {
        const extractor = await transformers.pipeline("feature-extraction", this.model, {
          dtype: this.dtype,
          device: this.device,
        });
        return extractor as unknown as FeatureExtractionPipeline;
      } catch (error) {
        // NEVER silently fall back to CPU here: the fingerprint (device/precision) was
        // fixed at construction, and int8-CPU vectors must not land in an fp16 index.
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `failed to load embedding model "${this.model}" (device: ${this.device}, ` +
            `dtype: ${this.dtype}): ${cause}` +
            (this.device === "dml"
              ? " — if DirectML is unavailable on this machine, set GIT_FOR_AI_DEVICE=cpu " +
                "(then run `git for-ai reindex --full`, since precision folds into the index fingerprint)"
              : ""),
        );
      }
    })();
    return this.pipelinePromise;
  }

  /** Dispose the current inference session (if any); the next embed() recreates it. */
  private async disposePipeline(): Promise<void> {
    const pending = this.pipelinePromise;
    this.pipelinePromise = null;
    this.chunksSinceLoad = 0;
    if (pending !== null) {
      try {
        const extractor = await pending;
        await extractor.dispose?.();
      } catch {
        // A failed load has nothing to dispose; embed() will surface the real error.
      }
    }
  }

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    if (chunks.length === 0) {
      return [];
    }
    const vectors: Float32Array[] = [];
    let offset = 0;
    while (offset < chunks.length) {
      // Session recreation between batches bounds ORT allocator growth (judgment #7).
      if (
        this.recreateAfterChunks > 0 &&
        this.pipelinePromise !== null &&
        this.chunksSinceLoad >= this.recreateAfterChunks
      ) {
        await this.disposePipeline();
      }
      const extractor = await this.loadPipeline();
      const batch = await this.nextBatch(chunks, offset, extractor);
      const output = toFloat32Tensor(await extractor(batch, { pooling: "mean", normalize: true }), this.model);
      const [rows, dim] = [output.dims[0], output.dims[output.dims.length - 1]];
      if (rows !== batch.length || dim !== this.dim) {
        throw new Error(
          `model "${this.model}" returned shape [${output.dims.join(", ")}] for a batch of ` +
            `${batch.length}; expected [${batch.length}, ${this.dim}]. ` +
            `The configured dim and the actual model disagree — fix the config or reindex --full.`,
        );
      }
      const data = output.data as Float32Array;
      for (let row = 0; row < batch.length; row += 1) {
        // Copy each row out of the flat batch buffer so vectors don't alias each other.
        vectors.push(data.slice(row * this.dim, (row + 1) * this.dim));
      }
      offset += batch.length;
      this.chunksSinceLoad += batch.length;
    }
    return vectors;
  }

  /**
   * Take the next batch of texts starting at `offset`. CPU: plain fixed-size batches.
   * DML: pack by real tokenized length so rows × maxTokens² stays under the DirectML
   * tensor-size budget (judgment call #9). Always returns at least one text.
   */
  private async nextBatch(
    chunks: Chunk[],
    offset: number,
    extractor: FeatureExtractionPipeline,
  ): Promise<string[]> {
    const window = chunks.slice(offset, offset + this.batchSize);
    if (this.device !== "dml") {
      return window.map((c) => c.text);
    }
    const texts: string[] = [];
    let maxTokens = 0;
    for (const chunk of window) {
      const tokens = await this.tokenCount(chunk.text, extractor);
      const nextMax = Math.max(maxTokens, tokens);
      const rows = texts.length + 1;
      if (texts.length > 0 && rows * nextMax * nextMax > DML_BATCH_COST_BUDGET) {
        break;
      }
      texts.push(chunk.text);
      maxTokens = nextMax;
    }
    return texts;
  }

  /** Tokenized length of one text via the pipeline's own tokenizer; conservative fallback. */
  private async tokenCount(text: string, extractor: FeatureExtractionPipeline): Promise<number> {
    const tokenizer = extractor.tokenizer;
    if (typeof tokenizer === "function") {
      try {
        const encoded = await tokenizer(text);
        const dims = encoded.input_ids.dims;
        const length = dims[dims.length - 1];
        if (typeof length === "number" && length > 0) {
          return Math.min(length, this.maxTokens);
        }
      } catch {
        // fall through to the estimate
      }
    }
    // No tokenizer surface: assume the worst observed ratio (~3 tokens/char) so the
    // packing stays safe even for token-dense content (hashes, exotic unicode).
    return Math.min(text.length * 3, this.maxTokens);
  }
}

/** Ensure a pipeline output tensor carries real float32 data (judgment call #8). */
function toFloat32Tensor(output: OutputTensor, model: string): OutputTensor {
  if (output.data instanceof Float32Array) {
    return output;
  }
  if (typeof output.to === "function") {
    const cast = output.to("float32");
    if (cast.data instanceof Float32Array) {
      return cast;
    }
  }
  throw new Error(
    `model "${model}" returned a non-float32 output tensor that could not be cast — ` +
      `try GIT_FOR_AI_DTYPE=fp32 (and \`git for-ai reindex --full\`)`,
  );
}

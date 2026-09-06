// Config → Embedder dispatch, for `reindex` and the query path.
//
// Takes the parsed repo config (`.git-for-ai/config.toml`, DATA_MODEL.md §5) and
// returns the configured provider. The voyage consent gate lives HERE and in the
// VoyageEmbedder constructor (defense in depth): voyage-code-3 is only ever constructed
// when the config's `voyage_consent` flag is literally true (ARCHITECTURE.md §16.14).

import type { RepoConfig } from "@git-for-ai/schemas";

import type { Embedder } from "./types.js";
import { TransformersEmbedder } from "./transformersEmbedder.js";
import { VoyageEmbedder, VoyageApiError } from "./voyageEmbedder.js";

export interface CreateEmbedderOptions {
  /** Voyage API key — required only when the configured provider is voyage-code-3. */
  voyageApiKey?: string;
  /** Model cache directory override for the transformers.js provider. */
  transformersCacheDir?: string;
  /**
   * Device request for the transformers.js provider: `"auto"` (default) | `"dml"` |
   * `"cpu"`. When absent, GIT_FOR_AI_DEVICE / GIT_FOR_AI_DTYPE env vars apply — see
   * resolveTransformersDevice() in ./transformersEmbedder.ts.
   */
  device?: string;
  /** Weight-precision request for the transformers.js provider: `"fp16"` | `"fp32"` | `"q8"`. */
  dtype?: string;
}

/**
 * Build the embedder the repo config asks for. Throws {@link VoyageConsentError} when
 * voyage-code-3 is configured without `voyage_consent = true`, and a plain Error for
 * providers the in-process embedder cannot run (nomic-embed-code, see
 * transformersEmbedder.ts).
 */
export function createEmbedderFromConfig(
  config: RepoConfig,
  options: CreateEmbedderOptions = {},
): Embedder {
  const { provider, dim, voyage_consent } = config.embedder;
  if (provider === "voyage-code-3") {
    if (options.voyageApiKey === undefined || options.voyageApiKey === "") {
      throw new VoyageApiError(
        "voyage-code-3 is configured but no API key was provided (set VOYAGE_API_KEY)",
      );
    }
    return new VoyageEmbedder({
      consent: voyage_consent,
      apiKey: options.voyageApiKey,
      dim,
    });
  }
  return new TransformersEmbedder({
    provider,
    ...(options.transformersCacheDir !== undefined
      ? { cacheDir: options.transformersCacheDir }
      : {}),
    ...(options.device !== undefined ? { device: options.device } : {}),
    ...(options.dtype !== undefined ? { dtype: options.dtype } : {}),
  });
}

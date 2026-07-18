// Opt-in Voyage AI embedder — architecture/ARCHITECTURE.md §11.3, §16 (judgment call 14).
//
// voyage-code-3 is the opt-in API provider (Anthropic has no first-party embeddings API
// and recommends Voyage). Using it sends chunk text — i.e. the user's code — off the
// machine, so it is hard-gated: this class cannot be constructed, let alone called,
// unless the caller passes `consent: true`, which must come from the repo config's
// explicit `embedder.voyage_consent = true` flag (DATA_MODEL.md §5). There is no
// environment-variable or default that bypasses the gate.
//
// Implementation is a thin `fetch` — deliberately no SDK dependency (§11.3). The fetch
// function is injectable so tests can exercise the request/response contract without
// network access (per CLI_PLAN.md's M11 note, mocking the *external API* — unlike git —
// is the appropriate kind of test double).
//
// ── Judgment calls ──
// 1. dim defaults to 1024 (voyage-code-3's default output dimension, and what M5's init
//    records for this provider); `output_dimension` is always sent explicitly so the
//    index dim never silently depends on a remote default changing.
// 2. maxTokens 32000 per the voyage-code-3 model card (32k context).
// 3. Batching: at most 128 inputs per request (Voyage's documented per-request limit
//    for embedding inputs).
// 4. `input_type` defaults to "document" (indexing side); M11's query path should pass
//    "query" when embedding questions.

import type { Chunk, Embedder } from "./types.js";

/** Thrown when a VoyageEmbedder is constructed without the explicit consent flag. */
export class VoyageConsentError extends Error {
  constructor() {
    super(
      "voyage-code-3 sends code to the Voyage AI API and requires explicit opt-in: " +
        "set `voyage_consent = true` under [embedder] in .git-for-ai/config.toml. " +
        "It is never enabled by default (ARCHITECTURE.md §11.3).",
    );
    this.name = "VoyageConsentError";
  }
}

/** Thrown when the Voyage API returns a non-2xx response or a malformed body. */
export class VoyageApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VoyageApiError";
    this.status = status;
  }
}

export interface VoyageEmbedderOptions {
  /**
   * MUST be literally `true`, sourced from the repo config's `embedder.voyage_consent`
   * flag. Anything else throws {@link VoyageConsentError}.
   */
  consent: boolean;
  /** Voyage AI API key. */
  apiKey: string;
  /** Default `"voyage-code-3"`. */
  model?: string;
  /** Output dimension. Default 1024. */
  dim?: number;
  /** `"document"` (indexing, default) or `"query"` (question embedding, M11). */
  inputType?: "document" | "query";
  /** Injectable fetch for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** API endpoint override. */
  endpoint?: string;
}

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const MAX_INPUTS_PER_REQUEST = 128;

interface VoyageResponseBody {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export class VoyageEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  readonly maxTokens = 32000;
  readonly isOffline = false;
  /** Config provider name (for model fingerprinting). */
  readonly provider: string;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly inputType: "document" | "query";
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: VoyageEmbedderOptions) {
    if (options.consent !== true) {
      throw new VoyageConsentError();
    }
    if (options.apiKey === "") {
      throw new VoyageApiError("a Voyage AI API key is required (options.apiKey was empty)");
    }
    this.model = options.model ?? "voyage-code-3";
    this.provider = this.model;
    this.id = this.model;
    this.dim = options.dim ?? 1024;
    this.inputType = options.inputType ?? "document";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? VOYAGE_ENDPOINT;
    this.apiKey = options.apiKey;
  }

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < chunks.length; offset += MAX_INPUTS_PER_REQUEST) {
      const batch = chunks.slice(offset, offset + MAX_INPUTS_PER_REQUEST).map((c) => c.text);
      vectors.push(...(await this.embedBatch(batch)));
    }
    return vectors;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: this.inputType,
        output_dimension: this.dim,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new VoyageApiError(
        `Voyage API request failed (${response.status}): ${body.slice(0, 500) || "(no body)"}`,
        response.status,
      );
    }
    const body = (await response.json()) as VoyageResponseBody;
    if (!Array.isArray(body.data) || body.data.length !== texts.length) {
      throw new VoyageApiError(
        `Voyage API returned ${body.data?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    // The API documents `data` in input order, but each row carries an `index` — honor it.
    const ordered = new Array<Float32Array>(texts.length);
    for (let i = 0; i < body.data.length; i += 1) {
      const row = body.data[i];
      if (row === undefined || !Array.isArray(row.embedding)) {
        throw new VoyageApiError(`Voyage API response row ${i} has no embedding array`);
      }
      if (row.embedding.length !== this.dim) {
        throw new VoyageApiError(
          `Voyage API returned a ${row.embedding.length}-dim embedding; expected ${this.dim}`,
        );
      }
      ordered[row.index ?? i] = Float32Array.from(row.embedding);
    }
    return ordered;
  }
}

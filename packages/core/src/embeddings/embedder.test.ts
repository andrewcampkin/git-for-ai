// Embedder tests (CLI_PLAN.md M9): the Voyage consent gate (never called without the
// explicit config flag), the fetch-level request/response contract via an injected fetch
// (the one place a test double is appropriate — an external HTTP API, not git), the
// config → embedder factory, and the transformers embedder's metadata. The REAL model
// download/inference test lives in transformersEmbedder.real.test.ts (gated — slow).

import { describe, expect, it } from "vitest";

import type { RepoConfig } from "@git-for-ai/schemas";

import { modelFingerprint } from "./types.js";
import { TransformersEmbedder } from "./transformersEmbedder.js";
import { VoyageApiError, VoyageConsentError, VoyageEmbedder } from "./voyageEmbedder.js";
import { createEmbedderFromConfig } from "./factory.js";

function repoConfig(embedder: Partial<RepoConfig["embedder"]>): RepoConfig {
  return {
    schema: "git-for-ai/config@1",
    embedder: {
      provider: "jina-v2-code",
      dim: 768,
      offline: true,
      voyage_consent: false,
      ...embedder,
    },
    capture: { enabled: true, never_capture: [], max_span_bytes: 16384 },
    redaction: { ruleset: "builtin@1", extra_patterns: [] },
    index: { hybrid: true },
  };
}

type FetchCall = { url: string; init: RequestInit };

/** Fake fetch capturing requests and replaying canned Voyage-shaped responses. */
function fakeFetch(
  respond: (call: FetchCall, callIndex: number) => { status?: number; body: unknown },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const { status = 200, body } = respond(call, calls.length - 1);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function voyageBody(vectors: number[][], indexes?: number[]): unknown {
  return { data: vectors.map((embedding, i) => ({ embedding, index: indexes?.[i] ?? i })) };
}

describe("VoyageEmbedder — the consent gate", () => {
  it("cannot be constructed without consent === true", () => {
    expect(() => new VoyageEmbedder({ consent: false, apiKey: "k" })).toThrow(VoyageConsentError);
    expect(
      () => new VoyageEmbedder({ consent: undefined as unknown as boolean, apiKey: "k" }),
    ).toThrow(VoyageConsentError);
  });

  it("requires an API key even with consent", () => {
    expect(() => new VoyageEmbedder({ consent: true, apiKey: "" })).toThrow(VoyageApiError);
  });

  it("factory refuses voyage-code-3 without the config voyage_consent flag", () => {
    expect(() =>
      createEmbedderFromConfig(
        repoConfig({ provider: "voyage-code-3", dim: 1024, offline: false, voyage_consent: false }),
        { voyageApiKey: "k" },
      ),
    ).toThrow(VoyageConsentError);
  });
});

describe("VoyageEmbedder — request/response contract (injected fetch)", () => {
  it("sends the documented request shape and returns Float32Arrays in input order", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: voyageBody([
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ]),
    }));
    const embedder = new VoyageEmbedder({ consent: true, apiKey: "secret-key", dim: 4, fetchImpl });

    expect(embedder.id).toBe("voyage-code-3");
    expect(embedder.isOffline).toBe(false);

    const vectors = await embedder.embed([{ text: "function a() {}" }, { text: "def b(): pass" }]);
    expect(vectors).toHaveLength(2);
    expect(vectors.every((v) => v instanceof Float32Array && v.length === 4)).toBe(true);
    expect(Array.from(vectors[0] as Float32Array).map((n) => n.toFixed(1))).toEqual(["0.1", "0.2", "0.3", "0.4"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.voyageai.com/v1/embeddings");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      model: "voyage-code-3",
      input: ["function a() {}", "def b(): pass"],
      input_type: "document",
      output_dimension: 4,
    });
  });

  it("honors per-row index fields when the API returns rows out of order", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: voyageBody(
        [
          [9, 9, 9, 9],
          [1, 1, 1, 1],
        ],
        [1, 0],
      ),
    }));
    const embedder = new VoyageEmbedder({ consent: true, apiKey: "k", dim: 4, fetchImpl });
    const vectors = await embedder.embed([{ text: "first" }, { text: "second" }]);
    expect(Array.from(vectors[0] as Float32Array)).toEqual([1, 1, 1, 1]);
    expect(Array.from(vectors[1] as Float32Array)).toEqual([9, 9, 9, 9]);
  });

  it("splits more than 128 inputs across multiple requests", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      const inputs = (JSON.parse(call.init.body as string) as { input: string[] }).input;
      return { body: voyageBody(inputs.map(() => [0, 0, 0, 0])) };
    });
    const embedder = new VoyageEmbedder({ consent: true, apiKey: "k", dim: 4, fetchImpl });
    const vectors = await embedder.embed(Array.from({ length: 130 }, (_, i) => ({ text: `chunk ${i}` })));
    expect(vectors).toHaveLength(130);
    expect(calls).toHaveLength(2);
    expect((JSON.parse(calls[0]?.init.body as string) as { input: string[] }).input).toHaveLength(128);
    expect((JSON.parse(calls[1]?.init.body as string) as { input: string[] }).input).toHaveLength(2);
  });

  it("surfaces API errors with status and body", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { detail: "bad key" } }));
    const embedder = new VoyageEmbedder({ consent: true, apiKey: "k", dim: 4, fetchImpl });
    await expect(embedder.embed([{ text: "x" }])).rejects.toThrow(/401.*bad key/s);
  });

  it("rejects a wrong-dimensional embedding from the API", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: voyageBody([[1, 2]]) }));
    const embedder = new VoyageEmbedder({ consent: true, apiKey: "k", dim: 4, fetchImpl });
    await expect(embedder.embed([{ text: "x" }])).rejects.toThrow(/2-dim.*expected 4/);
  });
});

describe("TransformersEmbedder — metadata (no model download)", () => {
  it("exposes the §11.3 metadata for the default jina-v2-code provider", () => {
    const embedder = new TransformersEmbedder();
    expect(embedder.id).toBe("transformers-jina-v2-code");
    expect(embedder.provider).toBe("jina-v2-code");
    expect(embedder.model).toBe("jinaai/jina-embeddings-v2-base-code");
    expect(embedder.dim).toBe(768);
    expect(embedder.maxTokens).toBe(8192);
    expect(embedder.isOffline).toBe(true);
    expect(modelFingerprint(embedder.provider, embedder.dim)).toBe("jina-v2-code/768");
  });

  it("embedding an empty chunk list resolves without loading the model", async () => {
    await expect(new TransformersEmbedder().embed([])).resolves.toEqual([]);
  });

  it("refuses providers the in-process embedder cannot run", () => {
    expect(() => new TransformersEmbedder({ provider: "nomic-embed-code" })).toThrow(/not supported/);
  });

  it("is what the factory builds for the default config", () => {
    const embedder = createEmbedderFromConfig(repoConfig({}));
    expect(embedder).toBeInstanceOf(TransformersEmbedder);
    expect(embedder.isOffline).toBe(true);
  });
});

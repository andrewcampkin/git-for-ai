// REAL-MODEL embedder test: the one place the real model is loaded, so it is run once
// for real rather than assumed to work.
//
// This downloads the actual jina-embeddings-v2-base-code ONNX weights on first run
// (~100+ MB, cached under the transformers.js cache dir afterwards) and runs real
// inference. Because that is slow and needs network on the first run, the suite is
// GATED behind an env var and skipped otherwise:
//
//     GIT_FOR_AI_REAL_EMBEDDER=1 pnpm vitest run src/embeddings/transformersEmbedder.real.test.ts
//
// It was executed for real during development on this machine.

import { describe, expect, it } from "vitest";

import { TransformersEmbedder } from "./transformersEmbedder.js";

const RUN_REAL = process.env["GIT_FOR_AI_REAL_EMBEDDER"] === "1";

describe.runIf(RUN_REAL)("TransformersEmbedder — real model (gated)", () => {
  // One embedder instance across tests so the model loads once.
  const embedder = new TransformersEmbedder();

  const INPUTS = [
    "export function add(a: number, b: number): number { return a + b; }",
    "def subtract(a, b):\n    return a - b",
    "Rejected a Redis session store to avoid an infra dependency.",
  ];

  it(
    "downloads/loads the model and returns vectors of the documented dimensionality",
    { timeout: 600_000 },
    async () => {
      const vectors = await embedder.embed(INPUTS.map((text) => ({ text })));
      expect(vectors).toHaveLength(INPUTS.length);
      for (const vector of vectors) {
        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(768);
        // Mean-pooled + normalized: unit L2 norm.
        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
        expect(norm).toBeGreaterThan(0.99);
        expect(norm).toBeLessThan(1.01);
      }
    },
  );

  it("identical input produces identical output (cache-hit correctness)", { timeout: 600_000 }, async () => {
    const [first] = await embedder.embed([{ text: INPUTS[0] as string }]);
    const [second] = await embedder.embed([{ text: INPUTS[0] as string }]);
    expect(Array.from(first as Float32Array)).toEqual(Array.from(second as Float32Array));
  });

  it("ranks related code closer than unrelated prose", { timeout: 600_000 }, async () => {
    const [addTs, addRs, prose] = await embedder.embed([
      { text: "function add(a, b) { return a + b; }" },
      { text: "fn add(a: i64, b: i64) -> i64 { a + b }" },
      { text: "The quarterly marketing report is due on Friday." },
    ]);
    const dot = (x: Float32Array, y: Float32Array): number =>
      x.reduce((sum, v, i) => sum + v * (y[i] as number), 0);
    expect(dot(addTs as Float32Array, addRs as Float32Array)).toBeGreaterThan(
      dot(addTs as Float32Array, prose as Float32Array),
    );
  });
});

describe.runIf(!RUN_REAL)("TransformersEmbedder — real model (gated)", () => {
  it.skip("set GIT_FOR_AI_REAL_EMBEDDER=1 to run the real model download/inference test", () => {});
});

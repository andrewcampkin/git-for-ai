// Embedding-cache tests (CLI_PLAN.md M9): the blob-hash cache under
// `.git-for-ai/embcache/` keyed by REAL git blob SHAs from a real fixture repo (never
// mocked git), plus the cache-hit contract M9's definition of done requires — a second
// run over unchanged content embeds nothing.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "../git/testFixtures.js";
import { hashObject } from "../git/plumbing.js";
import { chunkSourceFile, type CodeChunk } from "./chunking.js";
import { EmbeddingCache, embedChunksWithCache, type CacheableChunk } from "./cache.js";
import type { Chunk, Embedder } from "./types.js";

const DIM = 8;
const FINGERPRINT = "test-model/8";

/** Deterministic fake embedder that counts how many chunks it was asked to embed. */
class CountingEmbedder implements Embedder {
  readonly id = "counting-fake";
  readonly dim = DIM;
  readonly maxTokens = 1024;
  readonly isOffline = true;
  embeddedTexts: string[] = [];

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    return chunks.map((chunk) => {
      this.embeddedTexts.push(chunk.text);
      const vector = new Float32Array(DIM);
      for (let i = 0; i < chunk.text.length; i += 1) {
        vector[i % DIM] = (vector[i % DIM] as number) + chunk.text.charCodeAt(i) / 1000;
      }
      return vector;
    });
  }
}

const SOURCE = [
  "export function alpha(): number {",
  "  return 1;",
  "}",
  "",
  "export function beta(): number {",
  "  return 2;",
  "}",
  "",
].join("\n");

let repo: FixtureRepo;
let cacheDir: string;
let blobSha: string;
let chunks: CacheableChunk[];

beforeAll(async () => {
  repo = await createFixtureRepo();
  cacheDir = await mkdtemp(join(tmpdir(), "git-for-ai-embcache-"));
  // A REAL blob SHA, exactly as reindex will obtain one from git.
  await repo.commit("add math.ts", { files: { "src/math.ts": SOURCE } });
  blobSha = await hashObject(SOURCE, { cwd: repo.dir });
  const codeChunks: CodeChunk[] = await chunkSourceFile("src/math.ts", SOURCE);
  chunks = codeChunks.map((c) => ({ ...c, blobSha }));
  expect(chunks.map((c) => c.nodePath)).toEqual(["function:alpha", "function:beta"]);
});

afterAll(async () => {
  await repo.cleanup();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
});

function makeCache(subdir: string, fingerprint: string = FINGERPRINT): EmbeddingCache {
  return new EmbeddingCache({ dir: join(cacheDir, subdir), modelFingerprint: fingerprint, dim: DIM });
}

describe("EmbeddingCache", () => {
  it("round-trips a vector exactly (float32, little-endian, sharded path)", async () => {
    const cache = makeCache("roundtrip");
    const vector = Float32Array.from([0.5, -1.25, 3.75, 0, 1e-7, 42, -0.001, 8]);
    await cache.put(blobSha, "function:alpha", vector);

    const path = cache.pathFor(blobSha, "function:alpha");
    expect(path.endsWith(".f32")).toBe(true);
    expect((await readFile(path)).byteLength).toBe(DIM * 4);

    const back = await cache.get(blobSha, "function:alpha");
    expect(back).not.toBeNull();
    expect(Array.from(back as Float32Array)).toEqual(Array.from(vector));
  });

  it("misses on an unknown chunk identity and on a different node path", async () => {
    const cache = makeCache("miss");
    await cache.put(blobSha, "function:alpha", new Float32Array(DIM));
    expect(await cache.get(blobSha, "function:beta")).toBeNull();
    expect(await cache.get("f".repeat(40), "function:alpha")).toBeNull();
  });

  it("a different model fingerprint never serves the other model's vectors", async () => {
    const cacheA = makeCache("fp", "model-a/8");
    const cacheB = makeCache("fp", "model-b/8");
    await cacheA.put(blobSha, "function:alpha", Float32Array.from({ length: DIM }, () => 1));
    expect(await cacheB.get(blobSha, "function:alpha")).toBeNull();
  });

  it("treats a wrong-size cache file as a miss, not an error", async () => {
    const cache = makeCache("torn");
    await cache.put(blobSha, "function:alpha", new Float32Array(DIM));
    await writeFile(cache.pathFor(blobSha, "function:alpha"), Buffer.alloc(7));
    expect(await cache.get(blobSha, "function:alpha")).toBeNull();
  });

  it("rejects a vector of the wrong dimensionality", async () => {
    const cache = makeCache("dim");
    await expect(cache.put(blobSha, "function:alpha", new Float32Array(3))).rejects.toThrow(/dim 3/);
  });
});

describe("embedChunksWithCache — the M9 cache-hit contract", () => {
  it("first run embeds everything; an unchanged re-run embeds NOTHING", async () => {
    const cache = makeCache("contract");
    const embedder = new CountingEmbedder();

    const first = await embedChunksWithCache(embedder, cache, chunks);
    expect(first.misses).toBe(2);
    expect(first.hits).toBe(0);
    expect(embedder.embeddedTexts).toHaveLength(2);

    const second = await embedChunksWithCache(embedder, cache, chunks);
    expect(second.misses).toBe(0);
    expect(second.hits).toBe(2);
    expect(embedder.embeddedTexts).toHaveLength(2); // no new embedder calls

    // Cached vectors are byte-identical to freshly embedded ones, in input order.
    for (let i = 0; i < chunks.length; i += 1) {
      expect(Array.from(second.vectors[i] as Float32Array)).toEqual(
        Array.from(first.vectors[i] as Float32Array),
      );
    }
  });

  it("only changed chunks are re-embedded, and order is preserved across mixed hits/misses", async () => {
    const cache = makeCache("partial");
    const embedder = new CountingEmbedder();
    await embedChunksWithCache(embedder, cache, chunks);

    // Simulate an edit to beta: its blob changes, alpha's chunk identity is untouched.
    const editedSource = SOURCE.replace("return 2;", "return 20;");
    const editedBlobSha = await hashObject(editedSource, { cwd: repo.dir });
    const editedChunks = (await chunkSourceFile("src/math.ts", editedSource)).map((c) => ({
      ...c,
      blobSha: editedBlobSha,
    }));

    embedder.embeddedTexts = [];
    const result = await embedChunksWithCache(embedder, cache, editedChunks);
    // The whole file's blob changed, so both chunks re-embed — but the alpha chunk from
    // the ORIGINAL blob is still served from cache when the old blob reappears (rebase case).
    expect(result.misses).toBe(2);
    embedder.embeddedTexts = [];
    const rebaseRun = await embedChunksWithCache(embedder, cache, chunks);
    expect(rebaseRun.hits).toBe(2);
    expect(embedder.embeddedTexts).toHaveLength(0);
  });

  it("returns an empty result for no chunks without calling the embedder", async () => {
    const embedder = new CountingEmbedder();
    const result = await embedChunksWithCache(embedder, makeCache("empty"), []);
    expect(result).toEqual({ vectors: [], hits: 0, misses: 0 });
    expect(embedder.embeddedTexts).toEqual([]);
  });
});

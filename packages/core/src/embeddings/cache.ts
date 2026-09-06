// The blob-hash → embedding cache — architecture/ARCHITECTURE.md §8.2, §11.2.
//
// Lives at `.git-for-ai/embcache/` (created empty by `init`). Purpose: a chunk whose
// content (git blob) is unchanged is NEVER re-embedded — the cache contract — and a
// chunk that reappears unchanged after a rebase is free (§11.2 "incremental,
// blob-hash-keyed").
//
// ── Design (judgment calls — the docs specify the directory and the key concept only) ──
// 1. Cache key = sha256(model_fingerprint ‖ blob_sha ‖ node_path), NUL-separated. Chunk
//    identity per §11.2 is `(blob_hash, node_path)`; folding the model fingerprint into
//    the key means switching embedders can never serve stale cross-model vectors, and a
//    `reindex --full` after a model change simply repopulates alongside (doctor/GC can
//    prune later — cache files are derived and disposable like everything under
//    `.git-for-ai/`).
// 2. One file per vector: `embcache/<aa>/<rest-of-key>.f32`, sharded by first key byte
//    (same sharding idiom as the sessions store), containing exactly `dim * 4` bytes of
//    little-endian float32. A file with the wrong size (torn write, dim change) is
//    treated as a miss, never an error.
// 3. Writes are atomic (temp file + rename) so a crashed reindex can't leave a
//    half-written vector that later reads as valid.
// 4. `embedChunksWithCache()` is the composition `reindex` calls: partition chunks into
//    cache hits and misses, embed only the misses, write them back, and return vectors
//    in input order plus hit/miss counts for reporting.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Chunk, Embedder } from "./types.js";

export interface EmbeddingCacheOptions {
  /** The cache directory — `.git-for-ai/embcache/`. Created on first write. */
  dir: string;
  /** `<provider>/<dim>` — part of every cache key (never mix models, §11.3). */
  modelFingerprint: string;
  /** Expected vector dimensionality; files of any other size read as misses. */
  dim: number;
}

/** A chunk that carries the two halves of §11.2's chunk identity, so it is cacheable. */
export interface CacheableChunk extends Chunk {
  /** Git blob SHA of the file content this chunk was cut from. */
  readonly blobSha: string;
  /** Tree-sitter node path within that blob (see chunking.ts). */
  readonly nodePath: string;
}

export class EmbeddingCache {
  private readonly dir: string;
  private readonly modelFingerprint: string;
  private readonly dim: number;

  constructor(options: EmbeddingCacheOptions) {
    this.dir = options.dir;
    this.modelFingerprint = options.modelFingerprint;
    this.dim = options.dim;
  }

  /** The on-disk file path for one chunk identity (exposed for tests/doctor). */
  pathFor(blobSha: string, nodePath: string): string {
    const key = createHash("sha256")
      .update(this.modelFingerprint)
      .update("\0")
      .update(blobSha)
      .update("\0")
      .update(nodePath)
      .digest("hex");
    return join(this.dir, key.slice(0, 2), `${key.slice(2)}.f32`);
  }

  /** Read a cached vector, or null on miss (absent file, wrong size, unreadable). */
  async get(blobSha: string, nodePath: string): Promise<Float32Array | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(blobSha, nodePath));
    } catch {
      return null;
    }
    if (bytes.byteLength !== this.dim * 4) {
      return null;
    }
    // Copy out of the Buffer pool into an aligned, owned ArrayBuffer.
    const vector = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) {
      vector[i] = bytes.readFloatLE(i * 4);
    }
    return vector;
  }

  /** Atomically store a vector (temp file + rename). */
  async put(blobSha: string, nodePath: string, vector: Float32Array): Promise<void> {
    if (vector.length !== this.dim) {
      throw new Error(`vector has dim ${vector.length}; this cache is dim ${this.dim}`);
    }
    const path = this.pathFor(blobSha, nodePath);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const bytes = Buffer.alloc(vector.length * 4);
    for (let i = 0; i < vector.length; i += 1) {
      bytes.writeFloatLE(vector[i] as number, i * 4);
    }
    await writeFile(tmp, bytes);
    try {
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}

export interface EmbedWithCacheResult {
  /** vectors[i] corresponds to chunks[i]. */
  vectors: Float32Array[];
  /** How many chunks were served from the cache (no embedder call). */
  hits: number;
  /** How many chunks were actually embedded (and written back to the cache). */
  misses: number;
}

/**
 * Embed chunks through the cache: serve unchanged chunks from disk, embed only the
 * misses in one batched embedder call, and persist the new vectors. Re-running over
 * unchanged content embeds nothing (the cache contract).
 */
export async function embedChunksWithCache(
  embedder: Embedder,
  cache: EmbeddingCache,
  chunks: CacheableChunk[],
): Promise<EmbedWithCacheResult> {
  const vectors = new Array<Float32Array | null>(chunks.length).fill(null);
  const missIndexes: number[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as CacheableChunk;
    const cached = await cache.get(chunk.blobSha, chunk.nodePath);
    if (cached !== null) {
      vectors[i] = cached;
    } else {
      missIndexes.push(i);
    }
  }

  if (missIndexes.length > 0) {
    const embedded = await embedder.embed(missIndexes.map((i) => chunks[i] as CacheableChunk));
    if (embedded.length !== missIndexes.length) {
      throw new Error(
        `embedder "${embedder.id}" returned ${embedded.length} vectors for ${missIndexes.length} chunks`,
      );
    }
    for (let j = 0; j < missIndexes.length; j += 1) {
      const index = missIndexes[j] as number;
      const vector = embedded[j] as Float32Array;
      const chunk = chunks[index] as CacheableChunk;
      await cache.put(chunk.blobSha, chunk.nodePath, vector);
      vectors[index] = vector;
    }
  }

  return {
    vectors: vectors as Float32Array[],
    hits: chunks.length - missIndexes.length,
    misses: missIndexes.length,
  };
}

// M11 hybrid retrieval tests — ranking against a REAL SqliteVectorStore built with
// SYNTHETIC vectors from the deterministic BagOfWordsEmbedder (the real embedding
// model is never loaded), plus pure-function tests of the RRF merge and the
// blame-position boosting.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteVectorStore,
  type KeywordMatch,
  type StoredChunk,
  type VectorMatch,
} from "../embeddings/store.js";
import { DEFAULT_RRF_K, fuseMatches, retrieveSources } from "./retrieval.js";
import { BagOfWordsEmbedder, storeItem } from "./testSupport.js";

const embedder = new BagOfWordsEmbedder();

let dir: string;
let store: SqliteVectorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "git-for-ai-query-"));
  store = SqliteVectorStore.open({
    path: join(dir, "index.db"),
    dim: embedder.dim,
    modelFingerprint: `${embedder.id}/${embedder.dim}`,
  });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

const CHANGE_ID = "9f2c1a7b9f2c1a7b9f2c1a7b9f2c1a7b";

function seedRepoIndex(): void {
  store.upsert([
    storeItem(
      embedder,
      `ledger:${CHANGE_ID}`,
      "ledger",
      "Move session state to signed cookie tokens\n" +
        "Intent: allow multiple replicas without sticky sessions\n" +
        "Rejected: a Redis session store — avoid adding an infra dependency",
      { changeId: CHANGE_ID, sessionRef: "sha256:" + "1f".repeat(32) },
    ),
    storeItem(
      embedder,
      "blob1:src/auth/session.ts#0",
      "code",
      "export function signSessionCookie(token) { return hmac(token) }",
      { path: "src/auth/session.ts", blobSha: "a".repeat(40), nodePath: "#0", startLine: 40, endLine: 118 },
    ),
    storeItem(
      embedder,
      "blob2:src/config/toml.ts#0",
      "code",
      "export function parseTomlScalar(raw) { /* quoted strings and integers */ }",
      { path: "src/config/toml.ts", blobSha: "b".repeat(40), nodePath: "#0", startLine: 1, endLine: 30 },
    ),
  ]);
}

describe("retrieveSources (hybrid, real store, synthetic vectors)", () => {
  it("ranks the known-relevant source above known-irrelevant content", async () => {
    seedRepoIndex();
    const sources = await retrieveSources(
      store,
      embedder,
      "why don't we use redis for sessions",
    );

    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(sources[0]!.chunk.key).toBe(`ledger:${CHANGE_ID}`);
    expect(sources[0]!.rank).toBe(1);
    // The relevant hit is confirmed by both halves of the hybrid index.
    expect(sources[0]!.matchedBy).toEqual(
      expect.arrayContaining(["vector", "keyword"]),
    );
    expect(sources[0]!.vectorDistance).toBeTypeOf("number");
    expect(sources[0]!.keywordScore).toBeTypeOf("number");
    // The unrelated TOML parser never outranks the auth material.
    const tomlRank = sources.find((s) => s.chunk.key.includes("toml"))?.rank;
    expect(tomlRank === undefined || tomlRank > 1).toBe(true);

    // The QUERY (not the documents) was embedded, exactly once per call.
    expect(embedder.lastTexts).toEqual(["why don't we use redis for sessions"]);
  });

  it("returns [] from an empty store without erroring", async () => {
    const sources = await retrieveSources(store, embedder, "anything at all");
    expect(sources).toEqual([]);
  });

  it("honors the kinds filter", async () => {
    seedRepoIndex();
    const sources = await retrieveSources(store, embedder, "session cookie token", {
      kinds: ["code"],
    });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.chunk.kind === "code")).toBe(true);
  });

  it("honors k", async () => {
    seedRepoIndex();
    const sources = await retrieveSources(store, embedder, "session", { k: 1 });
    expect(sources).toHaveLength(1);
  });
});

// ─── fuseMatches (pure RRF-merge behavior) ───────────────────────────────────

function chunk(key: string, extra: Partial<StoredChunk> = {}): StoredChunk {
  return {
    key,
    kind: "code",
    text: `text of ${key}`,
    path: null,
    blobSha: null,
    nodePath: null,
    startLine: null,
    endLine: null,
    changeId: null,
    sessionRef: null,
    ...extra,
  };
}

const vec = (key: string, distance: number, extra: Partial<StoredChunk> = {}): VectorMatch => ({
  ...chunk(key, extra),
  distance,
});
const kw = (key: string, score: number, extra: Partial<StoredChunk> = {}): KeywordMatch => ({
  ...chunk(key, extra),
  score,
});

describe("fuseMatches (RRF)", () => {
  it("an item found by both halves outranks single-half items, and is deduped", () => {
    const fused = fuseMatches(
      [vec("b", 0.1), vec("a", 0.2)], // vector: b first, a second
      [kw("c", -5), kw("a", -4)], //     keyword: c first, a second
    );

    // a appears once (deduped by key) and wins: 1/(K+2) + 1/(K+2) > 1/(K+1).
    expect(fused.map((s) => s.chunk.key)).toEqual(["a", "b", "c"]);
    expect(fused[0]!.score).toBeCloseTo(2 / (DEFAULT_RRF_K + 2), 10);
    expect(fused[0]!.matchedBy).toEqual(["vector", "keyword"]);
    expect(fused[0]!.vectorDistance).toBe(0.2);
    expect(fused[0]!.keywordScore).toBe(-4);
    // b and c tie at 1/(K+1); the key tiebreak keeps ordering deterministic.
    expect(fused[1]!.score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
    expect(fused[1]!.matchedBy).toEqual(["vector"]);
    expect(fused[2]!.matchedBy).toEqual(["keyword"]);
    expect(fused.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it("limits to k after fusion", () => {
    const fused = fuseMatches([vec("a", 0.1), vec("b", 0.2), vec("c", 0.3)], [], { k: 2 });
    expect(fused.map((s) => s.chunk.key)).toEqual(["a", "b"]);
  });

  it("kind filtering removes items without consuming rank slots", () => {
    const fused = fuseMatches(
      [vec("code-hit", 0.1), vec("ledger-hit", 0.2, { kind: "ledger" })],
      [],
      { kinds: ["ledger"] },
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]!.chunk.key).toBe("ledger-hit");
    // Filtered-out code hit did not occupy rank 1: the ledger hit scores as rank 1.
    expect(fused[0]!.score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
  });

  it("boosts the chunk covering a blame position above better-ranked non-local hits", () => {
    const target = { path: "src/auth/session.ts", startLine: 10, endLine: 20 };
    const fused = fuseMatches(
      [
        vec("elsewhere", 0.1, { path: "src/other.ts", startLine: 1, endLine: 9 }),
        vec("path-only", 0.2, { path: "src/auth/session.ts", startLine: 100, endLine: 200 }),
        vec("covers-line", 0.3, target),
      ],
      [],
      { position: { path: "src/auth/session.ts", line: 12 } },
    );

    expect(fused.map((s) => s.chunk.key)).toEqual(["covers-line", "path-only", "elsewhere"]);
    expect(fused[0]!.positionBoost).toBe("line");
    expect(fused[1]!.positionBoost).toBe("path");
    expect(fused[2]!.positionBoost).toBeUndefined();
  });

  it("path-only positions (no line) boost path matches", () => {
    const fused = fuseMatches(
      [
        vec("elsewhere", 0.1, { path: "src/other.ts" }),
        vec("same-path", 0.2, { path: "src/auth/session.ts", startLine: 1, endLine: 5 }),
      ],
      [],
      { position: { path: "src/auth/session.ts" } },
    );
    expect(fused[0]!.chunk.key).toBe("same-path");
    expect(fused[0]!.positionBoost).toBe("path");
  });
});

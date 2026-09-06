// SqliteVectorStore tests: synthetic vectors against the REAL
// node:sqlite + sqlite-vec + FTS5 stack (no mocked database) — insert/query round-trips,
// KNN ordering, the FTS5 keyword mirror, upsert/delete consistency across all three
// tables, persistence across reopen, and the model-fingerprint gate.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IndexFingerprintError,
  SqliteVectorStore,
  toFtsQuery,
  type VectorStoreItem,
} from "./store.js";

const DIM = 4;
const FINGERPRINT = "test-model/4";

function vec(...values: number[]): Float32Array {
  expect(values).toHaveLength(DIM);
  return Float32Array.from(values);
}

function item(key: string, vector: Float32Array, overrides: Partial<VectorStoreItem> = {}): VectorStoreItem {
  return {
    key,
    kind: "code",
    text: `text for ${key}`,
    vector,
    ...overrides,
  };
}

let dir: string;
let store: SqliteVectorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "git-for-ai-store-"));
  store = SqliteVectorStore.open({ path: join(dir, "index.db"), dim: DIM, modelFingerprint: FINGERPRINT });
});

afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed by the test
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("SqliteVectorStore — vector KNN", () => {
  it("returns nearest neighbors in distance order with metadata attached", () => {
    store.upsert([
      item("a", vec(1, 0, 0, 0), { path: "src/a.ts", blobSha: "a".repeat(40), nodePath: "function:a", startLine: 1, endLine: 5 }),
      item("b", vec(0, 1, 0, 0)),
      item("c", vec(0.9, 0.1, 0, 0)),
    ]);

    const matches = store.queryVector(vec(1, 0, 0, 0), 2);
    expect(matches.map((m) => m.key)).toEqual(["a", "c"]);
    expect(matches[0]?.distance).toBe(0);
    expect((matches[1]?.distance ?? 0) > 0).toBe(true);
    expect(matches[0]).toMatchObject({
      kind: "code",
      text: "text for a",
      path: "src/a.ts",
      blobSha: "a".repeat(40),
      nodePath: "function:a",
      startLine: 1,
      endLine: 5,
      changeId: null,
      sessionRef: null,
    });
  });

  it("rejects a query or item vector of the wrong dimensionality", () => {
    expect(() => store.queryVector(Float32Array.from([1, 2]), 3)).toThrow(/dim 2/);
    expect(() => store.upsert([item("bad", Float32Array.from([1]))])).toThrow(/dim 1/);
  });

  it("returns at most k results", () => {
    store.upsert([
      item("a", vec(1, 0, 0, 0)),
      item("b", vec(0, 1, 0, 0)),
      item("c", vec(0, 0, 1, 0)),
    ]);
    expect(store.queryVector(vec(1, 0, 0, 0), 2)).toHaveLength(2);
    expect(store.queryVector(vec(1, 0, 0, 0), 10)).toHaveLength(3);
  });
});

describe("SqliteVectorStore — FTS5 keyword mirror", () => {
  it("finds chunks by keyword with bm25 ranking", () => {
    store.upsert([
      item("redis", vec(1, 0, 0, 0), {
        kind: "ledger",
        text: "Rejected a Redis session store to avoid an infra dependency",
        changeId: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
      }),
      item("cookie", vec(0, 1, 0, 0), { text: "signed cookie token codec" }),
    ]);

    const matches = store.queryKeyword(toFtsQuery("why not redis"), 5);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      key: "redis",
      kind: "ledger",
      changeId: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
    });
    expect(matches[0]?.score).toBeLessThan(0);
  });

  it("toFtsQuery neutralizes FTS5 syntax in natural-language questions", () => {
    store.upsert([item("a", vec(1, 0, 0, 0), { text: "session store details" })]);
    // Raw apostrophes/operators would be a syntax error without escaping.
    const query = toFtsQuery("why don't we use redis for the session-store?");
    expect(() => store.queryKeyword(query, 3)).not.toThrow();
    expect(store.queryKeyword(query, 3).map((m) => m.key)).toEqual(["a"]);
    expect(store.queryKeyword(toFtsQuery("!!! ???"), 3)).toEqual([]);
    expect(store.queryKeyword("", 3)).toEqual([]);
  });
});

describe("SqliteVectorStore — upsert and delete consistency", () => {
  it("upserting an existing key replaces the vector, text, and metadata everywhere", () => {
    store.upsert([item("a", vec(1, 0, 0, 0), { text: "original words" })]);
    store.upsert([item("a", vec(0, 0, 0, 1), { text: "replacement words" })]);

    expect(store.count()).toBe(1);
    // Vector half reflects the replacement...
    const nearOld = store.queryVector(vec(1, 0, 0, 0), 1);
    expect(nearOld[0]?.distance).toBeGreaterThan(0);
    expect(store.queryVector(vec(0, 0, 0, 1), 1)[0]?.distance).toBe(0);
    // ...and so does the keyword half.
    expect(store.queryKeyword(toFtsQuery("original"), 5)).toEqual([]);
    expect(store.queryKeyword(toFtsQuery("replacement"), 5).map((m) => m.key)).toEqual(["a"]);
    expect(store.has("a")).toBe(true);
  });

  it("deleteByKeys removes the chunk from vector, keyword, and metadata tables", () => {
    store.upsert([item("a", vec(1, 0, 0, 0)), item("b", vec(0, 1, 0, 0))]);
    store.deleteByKeys(["a", "never-existed"]);

    expect(store.count()).toBe(1);
    expect(store.has("a")).toBe(false);
    expect(store.queryVector(vec(1, 0, 0, 0), 5).map((m) => m.key)).toEqual(["b"]);
    expect(store.queryKeyword(toFtsQuery("text"), 5).map((m) => m.key)).toEqual(["b"]);
  });

  it("empty upsert and delete calls are no-ops", () => {
    store.upsert([]);
    store.deleteByKeys([]);
    expect(store.count()).toBe(0);
  });
});

describe("SqliteVectorStore — persistence and fingerprint gate", () => {
  it("persists chunks across close and reopen", () => {
    store.upsert([item("a", vec(1, 0, 0, 0), { text: "durable content" })]);
    store.close();

    store = SqliteVectorStore.open({ path: join(dir, "index.db"), dim: DIM, modelFingerprint: FINGERPRINT });
    expect(store.count()).toBe(1);
    expect(store.queryVector(vec(1, 0, 0, 0), 1)[0]?.key).toBe("a");
    expect(store.queryKeyword(toFtsQuery("durable"), 1)[0]?.key).toBe("a");
  });

  it("refuses to open an index built under a different model fingerprint", () => {
    store.close();
    expect(() =>
      SqliteVectorStore.open({ path: join(dir, "index.db"), dim: DIM, modelFingerprint: "other-model/4" }),
    ).toThrow(IndexFingerprintError);
  });

  it("treats a precision suffix as a different model (GPU fp16 vs legacy int8, ROADMAP Tier 0)", () => {
    store.close();
    expect(() =>
      SqliteVectorStore.open({
        path: join(dir, "index.db"),
        dim: DIM,
        modelFingerprint: `${FINGERPRINT}/fp16`,
      }),
    ).toThrow(IndexFingerprintError);
  });

  it("opens the zero-byte index.db stub that `init` leaves behind", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "git-for-ai-stub-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      const stubPath = join(stubDir, "index.db");
      await writeFile(stubPath, "");
      const stubStore = SqliteVectorStore.open({ path: stubPath, dim: DIM, modelFingerprint: FINGERPRINT });
      stubStore.upsert([item("a", vec(1, 0, 0, 0))]);
      expect(stubStore.count()).toBe(1);
      stubStore.close();
    } finally {
      await rm(stubDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

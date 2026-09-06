// Tests for `git for-ai reindex` (./reindex.ts) against REAL fixture repos (the no-mocks
// rule) with a deterministic FAKE embedder injected through
// ReindexOptions.embedder — the real transformers.js model is never loaded in tests.
//
// Covered, per the reindex requirements:
//   - all three content kinds (code / ledger / session) landing in one store;
//   - the incremental no-op re-run embedding NOTHING (the cache contract);
//   - incremental change pickup + stale-key deletion;
//   - --full drop/rebuild reusing embcache;
//   - IndexFingerprintError on a model change, recovered by --full;
//   - the uninitialized-repo guard and --verify.

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IndexFingerprintError,
  SqliteVectorStore,
  readIndexState,
  toFtsQuery,
  writeSessionRecord,
  type Chunk,
  type Embedder,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";
import type { SessionRecord } from "@git-for-ai/schemas";

import { runInit } from "./init.js";
import { runAnnotate } from "./annotate.js";
import { runReindex } from "./reindex.js";

// ─── Deterministic fake embedder ─────────────────────────────────────────────

/** Hash-based, dim-configurable fake: same text ⇒ same vector; counts every model call. */
class FakeEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  readonly maxTokens = 8192;
  readonly isOffline = true;
  /** Optional precision tag — folds into the fingerprint like the real GPU embedder's. */
  readonly precision?: string;
  /** Number of embed() invocations that reached the "model". */
  embedCalls = 0;
  /** Every text actually embedded (i.e. every embcache miss). */
  embeddedTexts: string[] = [];

  constructor(id = "fake", dim = 8, precision?: string) {
    this.id = id;
    this.dim = dim;
    if (precision !== undefined) {
      this.precision = precision;
    }
  }

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    this.embedCalls += 1;
    return chunks.map((chunk) => {
      this.embeddedTexts.push(chunk.text);
      const digest = createHash("sha256").update(chunk.text, "utf8").digest();
      const vector = new Float32Array(this.dim);
      let sumSquares = 0;
      for (let i = 0; i < this.dim; i += 1) {
        vector[i] = (digest[i % digest.length]! + 1) / 256;
        sumSquares += vector[i]! * vector[i]!;
      }
      const norm = Math.sqrt(sumSquares) || 1;
      for (let i = 0; i < this.dim; i += 1) {
        vector[i] = vector[i]! / norm;
      }
      return vector;
    });
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const MATH_TS = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

/** Commit a small source tree and opt the repo in (`init` without Claude hooks). */
async function setUpIndexedRepo(): Promise<{ sha: string; changeId: string }> {
  const sha = await repo.commit("Add math module", {
    files: {
      "src/math.ts": MATH_TS,
      "README.md": "A tiny fixture project about arithmetic.\n",
    },
  });
  await runInit({ cwd: repo.dir, claudeHooks: false });
  const annotated = await runAnnotate("HEAD", {
    cwd: repo.dir,
    summary: "Introduce the math module",
    intent: "Provide pure arithmetic helpers for the calculator",
    rejected: ["bignum library::overkill for integer math"],
  });
  return { sha, changeId: annotated.changeId };
}

/** Store a valid session record in the sessions ref, returning its content hash. */
async function storeSession(sha: string, summary?: string): Promise<{ contentHash: string }> {
  const record: SessionRecord = {
    schema: "git-for-ai/session@1",
    session_id: "test-session-1",
    agent: { tool: "claude-code", version: "1.0.0", model: "claude-fable-5" },
    captured_at: "2026-07-18T00:00:00Z",
    commit_range: { since: sha, until: sha },
    redaction: { applied: true, rules: [], redacted_count: 0 },
    source_fingerprint: "test@1",
    spans: [{ span_id: "s1", kind: "agent.plan", name: "plan", body: { plan: "do math" } }],
    ...(summary !== undefined ? { summary } : {}),
  };
  const written = await writeSessionRecord(record, { cwd: repo.dir });
  return { contentHash: written.contentHash };
}

function openStore(embedder: FakeEmbedder): SqliteVectorStore {
  return SqliteVectorStore.open({
    path: `${repo.dir}/.git-for-ai/index.db`,
    dim: embedder.dim,
    modelFingerprint: `${embedder.id}/${embedder.dim}`,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runReindex — three content kinds, one space (ARCHITECTURE §11.1)", () => {
  it("indexes code chunks, the effective ledger entry, and session summaries", async () => {
    const { sha, changeId } = await setUpIndexedRepo();
    const { contentHash } = await storeSession(
      sha,
      "Chose pure functions over a bignum library for arithmetic",
    );
    const embedder = new FakeEmbedder();

    const { data, output } = await runReindex({ cwd: repo.dir, embedder });

    expect(data.mode).toBe("initial");
    expect(data.modelFingerprint).toBe("fake/8");
    expect(data.code.indexed).toBeGreaterThan(0);
    expect(data.code.embedded).toBe(data.code.indexed); // cold cache: everything embedded
    expect(data.ledger).toEqual({ indexed: 1, reused: 0, embedded: 1 });
    expect(data.sessions).toEqual({ indexed: 1, reused: 0, embedded: 1 });
    expect(data.totalChunks).toBe(data.code.indexed + 2);

    // The rendered transcript follows CLI_REFERENCE.md's shape.
    expect(output).toContain("Embedder fake/8.");
    expect(output).toContain("code chunks:");
    expect(output).toContain("ledger entries:");
    expect(output).toContain("session summaries:");
    expect(output).toContain("(last_indexed_commit");

    // All three kinds are actually in the store, under their documented keys.
    const store = openStore(embedder);
    try {
      expect(store.count()).toBe(data.totalChunks);
      expect(store.has(`ledger:${changeId}`)).toBe(true);
      expect(store.has(`session:${contentHash}`)).toBe(true);

      const codeHit = store.queryKeyword(toFtsQuery("function add arithmetic"), 10);
      expect(codeHit.some((m) => m.kind === "code" && m.path === "src/math.ts")).toBe(true);

      const ledgerHit = store.queryKeyword(toFtsQuery("bignum overkill"), 10);
      expect(ledgerHit.some((m) => m.kind === "ledger" && m.changeId === changeId)).toBe(true);

      const sessionHit = store.queryKeyword(toFtsQuery("bignum library arithmetic"), 10);
      expect(sessionHit.some((m) => m.kind === "session" && m.sessionRef === `sha256:${contentHash}`)).toBe(true);
    } finally {
      store.close();
    }

    // state.json bookkeeping (DATA_MODEL.md §5.1).
    const state = await readIndexState(`${repo.dir}/.git-for-ai`);
    expect(state).not.toBeNull();
    expect(state!.last_indexed_commit).toBe(sha);
    expect(state!.model_fingerprint).toBe("fake/8");
    expect(state!.chunk_count).toBe(data.totalChunks);
  });

  it("falls back to deterministic text for a session record without a summary", async () => {
    const { sha } = await setUpIndexedRepo();
    const { contentHash } = await storeSession(sha /* no summary */);
    const embedder = new FakeEmbedder();

    const { data } = await runReindex({ cwd: repo.dir, embedder });
    expect(data.sessions.indexed).toBe(1);

    const store = openStore(embedder);
    try {
      const hits = store.queryKeyword(toFtsQuery("claude-code claude-fable-5"), 10);
      expect(hits.some((m) => m.key === `session:${contentHash}`)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runReindex — incremental (the cache contract)", () => {
  it("re-embeds NOTHING on a no-change re-run", async () => {
    const { sha } = await setUpIndexedRepo();
    await storeSession(sha, "Session about math");
    await runReindex({ cwd: repo.dir, embedder: new FakeEmbedder() });

    const second = new FakeEmbedder();
    const { data, output } = await runReindex({ cwd: repo.dir, embedder: second });

    expect(data.mode).toBe("incremental");
    expect(data.baseCommit).toBe(sha);
    expect(data.upToDate).toBe(true);
    // Code is diff-driven: no diff ⇒ not even re-chunked, let alone re-embedded.
    expect(data.code).toEqual({
      indexed: 0,
      reused: 0,
      embedded: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      staleKeysDeleted: 0,
    });
    // Ledger + sessions are re-swept but every embedding is an embcache hit.
    expect(data.ledger.embedded).toBe(0);
    expect(data.sessions.embedded).toBe(0);
    // The fake model was never asked for a single vector.
    expect(second.embeddedTexts).toEqual([]);
    expect(output).toContain("index current");
  });

  it("touches only changed blobs and deletes stale keys for replaced content", async () => {
    const { sha: first } = await setUpIndexedRepo();
    await runReindex({ cwd: repo.dir, embedder: new FakeEmbedder() });

    const oldBlob = (await repo.run(["rev-parse", `${first}:src/math.ts`])).stdout;
    await repo.commit("Rework add, add mul", {
      files: {
        "src/math.ts": [
          "export function add(a: number, b: number): number {",
          "  return b + a; // commutativity!",
          "}",
          "",
        ].join("\n"),
        "src/mul.ts": "export function mul(a: number, b: number): number {\n  return a * b;\n}\n",
      },
    });

    const embedder = new FakeEmbedder();
    const { data } = await runReindex({ cwd: repo.dir, embedder });

    expect(data.mode).toBe("incremental");
    expect(data.baseCommit).toBe(first);
    expect(data.upToDate).toBe(false);
    expect(data.code.embedded).toBeGreaterThan(0);
    expect(data.code.staleKeysDeleted).toBeGreaterThan(0);
    // The unchanged README was never re-chunked or re-embedded.
    expect(embedder.embeddedTexts.some((t) => t.includes("arithmetic."))).toBe(false);

    const newBlob = (await repo.run(["rev-parse", "HEAD:src/math.ts"])).stdout;
    const store = openStore(embedder);
    try {
      expect(store.has(`${newBlob}:function:add`)).toBe(true);
      expect(store.has(`${oldBlob}:function:add`)).toBe(false); // stale row removed
      const mulHits = store.queryKeyword(toFtsQuery("mul"), 5);
      expect(mulHits.some((m) => m.path === "src/mul.ts")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runReindex — --full", () => {
  it("drops and rebuilds the index while reusing every cached embedding", async () => {
    const { sha } = await setUpIndexedRepo();
    await storeSession(sha, "Session about math");
    const firstRun = await runReindex({ cwd: repo.dir, embedder: new FakeEmbedder() });

    const embedder = new FakeEmbedder();
    const { data, output } = await runReindex({ cwd: repo.dir, full: true, embedder });

    expect(data.mode).toBe("full");
    expect(output).toContain("Re-embedding from scratch.");
    expect(output).toContain("index rebuilt at .git-for-ai/index.db");
    // Everything was re-indexed, but embcache made every vector free.
    expect(data.totalChunks).toBe(firstRun.data.totalChunks);
    expect(data.code.indexed).toBe(firstRun.data.code.indexed);
    expect(data.code.reused).toBe(data.code.indexed);
    expect(data.code.embedded).toBe(0);
    expect(data.ledger).toEqual({ indexed: 1, reused: 1, embedded: 0 });
    expect(data.sessions).toEqual({ indexed: 1, reused: 1, embedded: 0 });
    expect(embedder.embeddedTexts).toEqual([]);
  });
});

describe("runReindex — model fingerprint safety (ARCHITECTURE §11.3)", () => {
  it("refuses to mix models without --full, and --full recovers", async () => {
    await setUpIndexedRepo();
    await runReindex({ cwd: repo.dir, embedder: new FakeEmbedder("fake-a") });

    // Same dim, different model id: vectors must never be mixed.
    await expect(
      runReindex({ cwd: repo.dir, embedder: new FakeEmbedder("fake-b") }),
    ).rejects.toThrow(IndexFingerprintError);

    // The documented recovery path.
    const { data } = await runReindex({ cwd: repo.dir, full: true, embedder: new FakeEmbedder("fake-b") });
    expect(data.modelFingerprint).toBe("fake-b/8");
    expect(data.code.embedded).toBe(data.code.indexed); // new model ⇒ old cache never reused

    const state = await readIndexState(`${repo.dir}/.git-for-ai`);
    expect(state!.model_fingerprint).toBe("fake-b/8");
  });

  it("a precision change alone is a model change (fp16 vs int8, ROADMAP Tier 0)", async () => {
    await setUpIndexedRepo();
    // Legacy int8-era index: no precision tag ⇒ bare fingerprint.
    await runReindex({ cwd: repo.dir, embedder: new FakeEmbedder("fake-a") });

    // Same id, same dim, but fp16 weights: vectors must never mix without --full.
    await expect(
      runReindex({ cwd: repo.dir, embedder: new FakeEmbedder("fake-a", 8, "fp16") }),
    ).rejects.toThrow(IndexFingerprintError);

    // The designed migration path.
    const { data } = await runReindex({
      cwd: repo.dir,
      full: true,
      embedder: new FakeEmbedder("fake-a", 8, "fp16"),
    });
    expect(data.modelFingerprint).toBe("fake-a/8/fp16");
    // Precision is part of the embcache key too ⇒ nothing reused across precisions.
    expect(data.code.embedded).toBe(data.code.indexed);

    const state = await readIndexState(`${repo.dir}/.git-for-ai`);
    expect(state!.model_fingerprint).toBe("fake-a/8/fp16");

    // q8 maps to the LEGACY bare fingerprint (fake-a/8) — distinct from fp16, so it
    // mismatches the fp16 index; conversely an int8-era index would reopen cleanly.
    await expect(
      runReindex({ cwd: repo.dir, embedder: new FakeEmbedder("fake-a", 8, "q8") }),
    ).rejects.toThrow(IndexFingerprintError);
  });
});

describe("runReindex — guards and --verify", () => {
  it("requires `git for-ai init` to have run", async () => {
    await repo.commit("Initial", { files: { "a.txt": "hello\n" } });
    await expect(runReindex({ cwd: repo.dir, embedder: new FakeEmbedder() })).rejects.toThrow(
      /git for-ai init/,
    );
  });

  it("errors clearly on a repository with no commits", async () => {
    await runInit({ cwd: repo.dir, claudeHooks: false });
    await expect(runReindex({ cwd: repo.dir, embedder: new FakeEmbedder() })).rejects.toThrow(
      /no commits/,
    );
  });

  it("--verify reports a current index, then flags staleness after a new commit", async () => {
    await setUpIndexedRepo();
    const embedder = new FakeEmbedder();
    await runReindex({ cwd: repo.dir, embedder });

    const ok = await runReindex({ cwd: repo.dir, verify: true, embedder });
    expect(ok.data.mode).toBe("verify");
    expect(ok.data.verify).toEqual({ current: true, problems: [] });
    expect(ok.output).toContain("✓ index is consistent and current");

    await repo.commit("Another change", { files: { "b.txt": "more\n" } });
    const stale = await runReindex({ cwd: repo.dir, verify: true, embedder });
    expect(stale.data.verify!.current).toBe(false);
    expect(stale.data.verify!.problems.join("\n")).toContain("stale");
  });
});

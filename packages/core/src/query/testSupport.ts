// Test-only helpers for the M11 query-engine suite (same pattern as git/testFixtures.ts:
// a plain module with no test-runner imports, usable from any *.test.ts file).
//
// The centerpiece is BagOfWordsEmbedder: a DETERMINISTIC fake embedder whose vectors
// actually encode token overlap (hashed bag-of-words, L2-normalized), so ranking tests
// can assert "the semantically relevant chunk wins" against a REAL SqliteVectorStore
// with synthetic vectors — without ever loading the real model (M11 test constraint;
// the transformers model must never run here).

import { createHash } from "node:crypto";

import type { LedgerEntry, SessionRecord } from "@git-for-ai/schemas";

import type { VectorStoreItem, IndexedKind } from "../embeddings/store.js";
import type { Chunk, Embedder } from "../embeddings/types.js";

/** Deterministic token-overlap embedder: shared words ⇒ nearby vectors. */
export class BagOfWordsEmbedder implements Embedder {
  readonly id = "fake-bow";
  readonly dim: number;
  readonly maxTokens = 1_000_000;
  readonly isOffline = true;
  /** Number of embed() calls (query-path assertions). */
  calls = 0;
  /** Texts passed to the most recent embed() call. */
  lastTexts: string[] = [];

  constructor(dim = 32) {
    this.dim = dim;
  }

  vectorFor(text: string): Float32Array {
    const vector = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const token of tokens) {
      const digest = createHash("sha256").update(token, "utf8").digest();
      const bucket = digest[0]! % this.dim;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    let sumSquares = 0;
    for (let i = 0; i < this.dim; i += 1) {
      sumSquares += vector[i]! * vector[i]!;
    }
    if (sumSquares === 0) {
      vector[0] = 1;
      sumSquares = 1;
    }
    const norm = Math.sqrt(sumSquares);
    for (let i = 0; i < this.dim; i += 1) {
      vector[i] = vector[i]! / norm;
    }
    return vector;
  }

  async embed(chunks: Chunk[]): Promise<Float32Array[]> {
    this.calls += 1;
    this.lastTexts = chunks.map((chunk) => chunk.text);
    return chunks.map((chunk) => this.vectorFor(chunk.text));
  }
}

/** Build a store item whose vector comes from the fake embedder. */
export function storeItem(
  embedder: BagOfWordsEmbedder,
  key: string,
  kind: IndexedKind,
  text: string,
  extra: Partial<Omit<VectorStoreItem, "key" | "kind" | "text" | "vector">> = {},
): VectorStoreItem {
  return { key, kind, text, vector: embedder.vectorFor(text), ...extra };
}

/** A schema-valid ledger entry with sensible defaults, overridable per test. */
export function makeLedgerEntry(params: {
  changeId: string;
  revision: string;
  createdAt: string;
  summary: string;
  scopePath: string;
  scopeBlob: string;
  sessionRef?: string;
  intent?: string;
  rejectedOption?: string;
  rejectedWhy?: string;
  confidence?: number;
}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: params.changeId,
    revision: params.revision,
    created_at: params.createdAt,
    author: { type: "agent", tool: "claude-code", model: "claude-opus-4-8" },
    scope: [{ path: params.scopePath, range: [1, 5] as [number, number], blob: params.scopeBlob }],
    summary: params.summary,
    reasoning: {
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
      ...(params.rejectedOption !== undefined
        ? { rejected: [{ option: params.rejectedOption, why: params.rejectedWhy ?? "rejected" }] }
        : {}),
      ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
    },
    ...(params.sessionRef !== undefined ? { session_ref: params.sessionRef } : {}),
    provenance: "agent-captured",
  };
}

/** A schema-valid session record with one span. */
export function makeSessionRecord(params: {
  sessionId: string;
  capturedAt: string;
  sinceSha: string;
  untilSha: string;
  summary?: string;
}): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: params.sessionId,
    agent: { tool: "claude-code", version: "1.0.0", model: "claude-opus-4-8" },
    captured_at: params.capturedAt,
    commit_range: { since: params.sinceSha, until: params.untilSha },
    redaction: { applied: true, rules: [], redacted_count: 0 },
    source_fingerprint: "test-fixture@1",
    spans: [
      {
        span_id: "span-1",
        kind: "agent.plan",
        name: "plan",
        body: { plan: "test plan" },
      },
    ],
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
  };
}

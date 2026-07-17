// Integration tests for the content-addressed session store (./store.ts) against REAL
// temporary git repos (createFixtureRepo, never mocked): records land as blobs in a
// sharded tree behind refs/git-for-ai/sessions, the sha256 content address is
// recomputable from what is stored (DATA_MODEL.md §3.1), reads round-trip through the
// schema, and identical writes are idempotent by construction.

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionRecordSchema, type SessionRecord } from "@git-for-ai/schemas";

import { createFixtureRepo, lsTree, type FixtureRepo } from "../git/index.js";
import { canonicalJsonStringify } from "../ledger/effective.js";
import {
  SESSIONS_REF,
  contentAddressSessionRecord,
  readSessionRecord,
  readSessionsCommit,
  sessionShardPath,
  writeSessionRecord,
} from "./store.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function sampleRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: "b1e2c3d4-5678-90ab-cdef-1234567890ab",
    agent: { tool: "claude-code", version: "2.0.13", model: "claude-opus-4-8" },
    captured_at: "2026-07-17T09:22:41Z",
    commit_range: {
      since: "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334",
      until: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
    },
    redaction: { applied: true, rules: [], redacted_count: 0, truncated_count: 0 },
    source_fingerprint: "claude-code-jsonl@1",
    spans: [
      { span_id: "s1", kind: "agent.plan", body: { plan: "1. do the thing\n2. test it" } },
      {
        span_id: "s2",
        kind: "gen_ai.tool.execution",
        name: "Edit",
        attributes: { file: "src/auth/session.ts" },
      },
    ],
    summary: "test session record",
    ...overrides,
  };
}

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

describe("writeSessionRecord / readSessionRecord", () => {
  it("stores the record as a sharded blob behind refs/git-for-ai/sessions", async () => {
    const record = sampleRecord();
    const written = await writeSessionRecord(record, { cwd: repo.dir });

    expect(written.created).toBe(true);
    expect(written.sessionRef).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The ref exists and its tree holds exactly the sharded path.
    const commit = await readSessionsCommit({ cwd: repo.dir });
    expect(commit).not.toBeNull();
    const entries = await lsTree(commit!, { cwd: repo.dir, recursive: true });
    const blobs = entries.filter((e) => e.type === "blob");
    expect(blobs.map((b) => b.path)).toEqual([sessionShardPath(written.contentHash)]);
    expect(blobs[0]!.path).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{62}\.json$/);
  });

  it("round-trips through the schema and the content address is recomputable", async () => {
    const record = sampleRecord();
    const written = await writeSessionRecord(record, { cwd: repo.dir });

    const readBack = await readSessionRecord(written.sessionRef, { cwd: repo.dir });
    expect(readBack).not.toBeNull();
    expect(sessionRecordSchema.parse(readBack)).toEqual(record);

    // Recompute the hash from what was actually read back (DATA_MODEL.md §3.1):
    // canonical serialization -> sha256 must equal the address it was stored under.
    const recomputed = createHash("sha256")
      .update(canonicalJsonStringify(readBack), "utf8")
      .digest("hex");
    expect(`sha256:${recomputed}`).toBe(written.sessionRef);
    expect(contentAddressSessionRecord(readBack!).sessionRef).toBe(written.sessionRef);
  });

  it("content addressing is key-order-independent (canonicalization)", () => {
    const a = sampleRecord();
    // Same fields, different insertion order.
    const b = Object.fromEntries(Object.entries(a).reverse()) as SessionRecord;
    expect(Object.keys(b)).not.toEqual(Object.keys(a));
    expect(contentAddressSessionRecord(a).sessionRef).toBe(contentAddressSessionRecord(b).sessionRef);
  });

  it("writing identical content twice is idempotent (same ref, no new commit)", async () => {
    const record = sampleRecord();
    const first = await writeSessionRecord(record, { cwd: repo.dir });
    const commitAfterFirst = await readSessionsCommit({ cwd: repo.dir });

    const second = await writeSessionRecord(record, { cwd: repo.dir });
    expect(second.created).toBe(false);
    expect(second.sessionRef).toBe(first.sessionRef);
    expect(second.blobSha).toBe(first.blobSha);
    expect(await readSessionsCommit({ cwd: repo.dir })).toBe(commitAfterFirst);
  });

  it("different content gets a different address; both remain readable", async () => {
    const first = await writeSessionRecord(sampleRecord(), { cwd: repo.dir });
    const second = await writeSessionRecord(
      sampleRecord({ summary: "a different session" }),
      { cwd: repo.dir },
    );
    expect(second.sessionRef).not.toBe(first.sessionRef);
    expect(await readSessionRecord(first.sessionRef, { cwd: repo.dir })).not.toBeNull();
    expect(await readSessionRecord(second.sessionRef, { cwd: repo.dir })).not.toBeNull();
  });

  it("readSessionRecord returns null for unknown hashes and missing ref", async () => {
    const missing = `sha256:${"0".repeat(64)}`;
    expect(await readSessionRecord(missing, { cwd: repo.dir })).toBeNull(); // no ref yet
    await writeSessionRecord(sampleRecord(), { cwd: repo.dir });
    expect(await readSessionRecord(missing, { cwd: repo.dir })).toBeNull(); // ref, no blob
  });

  it("rejects a malformed session ref loudly", async () => {
    await expect(readSessionRecord("sha256:nope", { cwd: repo.dir })).rejects.toThrow(
      "invalid session ref",
    );
  });

  it("refuses to write a record that fails schema validation", async () => {
    const invalid = { ...sampleRecord(), schema: "git-for-ai/session@2" } as unknown as SessionRecord;
    await expect(writeSessionRecord(invalid, { cwd: repo.dir })).rejects.toThrow();
    expect(await readSessionsCommit({ cwd: repo.dir })).toBeNull(); // nothing was written
  });

  it("SESSIONS_REF is the documented ref name", () => {
    expect(SESSIONS_REF).toBe("refs/git-for-ai/sessions");
  });
});

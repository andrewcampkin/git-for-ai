import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeMapEntry } from "@git-for-ai/schemas";

// Real git subprocess chains per test; the 5s default is too tight on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { createFixtureRepo, lsTree, revParse, type FixtureRepo } from "../git/index.js";
import {
  CHANGE_MAP_REF,
  shardPathFor,
  readChangeMapCommit,
  readChangeMapEntry,
  readAllChangeMapEntries,
  findEntryByCommitSha,
  upsertChangeMapEntries,
} from "./changeMap.js";

function makeEntry(changeId: string, head: string, overrides: Partial<ChangeMapEntry> = {}): ChangeMapEntry {
  return {
    schema: "git-for-ai/change-map-entry@1",
    change_id: changeId,
    head,
    history: [head],
    trailer_seen: false,
    origin: "post-commit",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const CID_A = "9f2c1a7b6e4d0f83c5a1b2d3e4f50617";
const CID_B = "3d1f0a2b4c6d8e0f1a2b3c4d5e6f7081";
const CID_A2 = "9f00000000000000000000000000abcd"; // same 9f/ shard dir as CID_A
const SHA_1 = "a0f1c2d3e4f5061728394a5b6c7d8e9f00112233";
const SHA_2 = "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70";
const SHA_3 = "3d4e5f60718293a4b5c6d7e8f900112233445566";

describe("change-map storage layer (refs/git-for-ai/change-map)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.commit("initial", { files: { "README.md": "hello\n" } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("shardPathFor shards by the first 2 hex chars (DATA_MODEL.md §4.1)", () => {
    expect(shardPathFor(CID_A)).toBe("9f/2c1a7b6e4d0f83c5a1b2d3e4f50617.json");
  });

  it("reads return empty/null before the ref exists", async () => {
    expect(await readChangeMapCommit({ cwd: repo.dir })).toBeNull();
    expect(await readChangeMapEntry(CID_A, { cwd: repo.dir })).toBeNull();
    expect(await readAllChangeMapEntries({ cwd: repo.dir })).toEqual([]);
    expect(await findEntryByCommitSha(SHA_1, { cwd: repo.dir })).toBeNull();
  });

  it("round-trips an entry and lays it out as a sharded tree under the ref", async () => {
    const entry = makeEntry(CID_A, SHA_1);
    await upsertChangeMapEntries([entry], { cwd: repo.dir });

    const readBack = await readChangeMapEntry(CID_A, { cwd: repo.dir });
    expect(readBack).toEqual(entry);

    // The ref exists and its tree carries exactly the sharded layout from DATA_MODEL.md §4.1.
    const refSha = await revParse(CHANGE_MAP_REF, { cwd: repo.dir });
    expect(refSha).toMatch(/^[0-9a-f]{40}$/);
    const treeEntries = await lsTree(CHANGE_MAP_REF, { cwd: repo.dir, recursive: true });
    expect(treeEntries.map((e) => e.path)).toEqual(["9f/2c1a7b6e4d0f83c5a1b2d3e4f50617.json"]);
  });

  it("upserting a second entry preserves the first and chains commits on the ref", async () => {
    await upsertChangeMapEntries([makeEntry(CID_A, SHA_1)], { cwd: repo.dir });
    await upsertChangeMapEntries([makeEntry(CID_B, SHA_2)], { cwd: repo.dir });

    expect(await readChangeMapEntry(CID_A, { cwd: repo.dir })).not.toBeNull();
    expect(await readChangeMapEntry(CID_B, { cwd: repo.dir })).not.toBeNull();
    expect(await readAllChangeMapEntries({ cwd: repo.dir })).toHaveLength(2);

    // Each upsert is one commit, parented on the previous map state.
    const countResult = await repo.run(["rev-list", "--count", CHANGE_MAP_REF]);
    expect(countResult.stdout).toBe("2");
  });

  it("two change-ids sharing a shard directory coexist in one subtree", async () => {
    await upsertChangeMapEntries([makeEntry(CID_A, SHA_1), makeEntry(CID_A2, SHA_2)], {
      cwd: repo.dir,
    });
    const treeEntries = await lsTree(CHANGE_MAP_REF, { cwd: repo.dir, recursive: true });
    expect(treeEntries.map((e) => e.path).sort()).toEqual([
      "9f/00000000000000000000000000abcd.json",
      "9f/2c1a7b6e4d0f83c5a1b2d3e4f50617.json",
    ]);
  });

  it("upserting an existing change-id replaces its shard in place", async () => {
    await upsertChangeMapEntries([makeEntry(CID_A, SHA_1)], { cwd: repo.dir });
    const updated = makeEntry(CID_A, SHA_2, { history: [SHA_1, SHA_2], origin: "post-rewrite" });
    await upsertChangeMapEntries([updated], { cwd: repo.dir });

    const readBack = await readChangeMapEntry(CID_A, { cwd: repo.dir });
    expect(readBack).toEqual(updated);
    expect(await readAllChangeMapEntries({ cwd: repo.dir })).toHaveLength(1);
  });

  it("findEntryByCommitSha matches by head and by any history member", async () => {
    const entry = makeEntry(CID_A, SHA_2, { history: [SHA_1, SHA_2] });
    await upsertChangeMapEntries([entry], { cwd: repo.dir });

    expect((await findEntryByCommitSha(SHA_2, { cwd: repo.dir }))?.change_id).toBe(CID_A);
    expect((await findEntryByCommitSha(SHA_1, { cwd: repo.dir }))?.change_id).toBe(CID_A);
    expect(await findEntryByCommitSha(SHA_3, { cwd: repo.dir })).toBeNull();
  });

  it("rejects writing an entry that fails schema validation", async () => {
    const bad = makeEntry(CID_A, "not-a-sha");
    await expect(upsertChangeMapEntries([bad], { cwd: repo.dir })).rejects.toThrow();
  });
});

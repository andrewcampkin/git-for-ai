// Tests for `git for-ai relink` and `reconcile` against REAL fixture repos, including a
// reproduction of the misattribution shape that
// `relink --detach` exists to repair.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLedgerEntry,
  assignChangeId,
  findEntryByCommitSha,
  readChangeMapEntry,
  readLedgerNote,
  resolveChangeId,
} from "@git-for-ai/core";
import type { LedgerEntry } from "@git-for-ai/schemas";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runRelink } from "./relink.js";
import { runReconcile } from "./reconcile.js";

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

function entryFor(changeId: string, revision: string, summary: string): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: changeId,
    revision,
    created_at: new Date().toISOString(),
    author: { type: "agent", tool: "claude-code" },
    scope: [],
    summary,
    provenance: "agent-captured",
  };
}

describe("relink", () => {
  it("re-points a change's head to a named commit", async () => {
    const shaA = await repo.commit("first", { files: { "a.txt": "1\n" } });
    const { changeId } = await assignChangeId(shaA, { cwd: repo.dir });
    const shaB = await repo.commit("second", { files: { "a.txt": "2\n" } });

    const result = await runRelink([changeId, shaB], { cwd: repo.dir });
    expect(result.mode).toBe("repoint");

    const entry = await readChangeMapEntry(changeId, { cwd: repo.dir });
    expect(entry?.head).toBe(shaB);
    expect(entry?.history).toEqual([shaA, shaB]);
  });

  it("--detach repairs the misattribution shape end-to-end", async () => {
    // Reproduce the live bug: two unrelated commits glued into one change, the second's
    // ledger entry superseding the first's.
    const shaM7 = await repo.commit("the real change", { files: { "code.ts": "x\n" } });
    const { changeId } = await assignChangeId(shaM7, { cwd: repo.dir });
    await appendLedgerEntry(changeId, entryFor(changeId, shaM7, "The real intent"), {
      cwd: repo.dir,
    });

    const shaDoc = await repo.commit("unrelated doc commit", { files: { "doc.md": "d\n" } });
    // Simulate the old R4 misfire: doc commit absorbed into the same change.
    await runRelink([changeId, shaDoc], { cwd: repo.dir });
    await appendLedgerEntry(changeId, entryFor(changeId, shaDoc, "Doc intent (wrongly attributed)"), {
      cwd: repo.dir,
    });

    const result = await runRelink([shaDoc], { cwd: repo.dir, detach: true });
    expect(result.mode).toBe("detach");
    expect(result.changeId).toBe(changeId);
    expect(result.newChangeId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.newChangeId).not.toBe(changeId);
    expect(result.restoredHead).toBe(shaM7);
    expect(result.noteRewritten).toBe(true);

    // The original change is whole again.
    const original = await readChangeMapEntry(changeId, { cwd: repo.dir });
    expect(original?.head).toBe(shaM7);
    expect(original?.history).toEqual([shaM7]);

    // The doc commit has its own identity, and its note envelope was re-anchored.
    const docOwner = await findEntryByCommitSha(shaDoc, { cwd: repo.dir });
    expect(docOwner?.change_id).toBe(result.newChangeId);
    const docNote = await readLedgerNote(shaDoc, { cwd: repo.dir });
    expect(docNote?.change_id).toBe(result.newChangeId);
    expect(docNote?.entries[0]?.change_id).toBe(result.newChangeId);
    expect(docNote?.entries[0]?.summary).toBe("Doc intent (wrongly attributed)");
  });

  it("--detach refuses to empty a single-commit change", async () => {
    const sha = await repo.commit("only commit", { files: { "a.txt": "1\n" } });
    await assignChangeId(sha, { cwd: repo.dir });
    await expect(runRelink([sha], { cwd: repo.dir, detach: true })).rejects.toThrow(
      /refusing to detach/,
    );
  });
});

describe("reconcile", () => {
  it("heals trailer-carrying commits the map doesn't know; leaves trailerless alone", async () => {
    // A commit with a trailer the map has never seen (cherry-pick shape), and one without.
    const withTrailer = await repo.commit(
      "picked commit\n\nChange-Id: Iaaaabbbbccccddddeeeeffff00001111",
      { files: { "p.txt": "p\n" } },
    );
    const without = await repo.commit("no trailer", { files: { "q.txt": "q\n" } });

    const result = await runReconcile({ cwd: repo.dir });
    expect(result.healed).toEqual([
      { sha: withTrailer, changeId: "aaaabbbbccccddddeeeeffff00001111", branch: "R3" },
    ]);
    expect(result.unlinked).toBe(1);
    expect(result.output).toContain("healed 1 commit");
    expect(await findEntryByCommitSha(without, { cwd: repo.dir })).toBeNull();
  });

  it("--rebuild-map reconstructs heads correctly (newest commit of a change wins)", async () => {
    // Two commits of the SAME change (amend-style trailer reuse) plus one other change.
    const old = await repo.commit("v1\n\nChange-Id: I11112222333344445555666677778888", {
      files: { "r.txt": "1\n" },
    });
    const newer = await repo.commit("v2 of same change\n\nChange-Id: I11112222333344445555666677778888", {
      files: { "r.txt": "2\n" },
    });
    const other = await repo.commit("other\n\nChange-Id: I99990000aaaabbbbccccddddeeeeffff", {
      files: { "s.txt": "s\n" },
    });

    const result = await runReconcile({ cwd: repo.dir, rebuildMap: true });
    expect(result.healed).toHaveLength(3);

    const same = await readChangeMapEntry("11112222333344445555666677778888", { cwd: repo.dir });
    expect(same?.head).toBe(newer); // newest-first walk registers the newest as head
    expect(same?.history).toContain(old);
    const otherEntry = await findEntryByCommitSha(other, { cwd: repo.dir });
    expect(otherEntry?.change_id).toBe("99990000aaaabbbbccccddddeeeeffff");
  });

  it("re-running after healing is a no-op", async () => {
    await repo.commit("stable\n\nChange-Id: Ifeedfacefeedfacefeedfacefeedface", {
      files: { "t.txt": "t\n" },
    });
    await runReconcile({ cwd: repo.dir });
    const second = await runReconcile({ cwd: repo.dir });
    expect(second.healed).toEqual([]);
  });
});

describe("relink+reconcile shared guards", () => {
  it("relink fails cleanly on unknown change or commit", async () => {
    await repo.commit("base", { files: { "u.txt": "u\n" } });
    await expect(
      runRelink(["ffffffffffffffffffffffffffffffff", "HEAD"], { cwd: repo.dir }),
    ).rejects.toThrow(/not found in the change-map/);

    const sha = await repo.commit("known", { files: { "v.txt": "v\n" } });
    const { changeId } = await assignChangeId(sha, { cwd: repo.dir });
    await expect(runRelink([changeId, "nope"], { cwd: repo.dir })).rejects.toThrow(
      /cannot resolve 'nope'/,
    );
  });

  it("detach then resolve gives the detached commit a stable identity (self-heals to R1)", async () => {
    const shaA = await repo.commit("a", { files: { "w.txt": "1\n" } });
    const { changeId } = await assignChangeId(shaA, { cwd: repo.dir });
    const shaB = await repo.commit("b", { files: { "w.txt": "2\n" } });
    await runRelink([changeId, shaB], { cwd: repo.dir });

    const detached = await runRelink([shaB], { cwd: repo.dir, detach: true });
    const resolved = await resolveChangeId(shaB, { cwd: repo.dir });
    expect(resolved.branch).toBe("R1");
    expect(resolved.changeId).toBe(detached.newChangeId);
  });
});

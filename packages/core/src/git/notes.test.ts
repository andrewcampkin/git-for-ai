import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "./testFixtures.js";
import { notesShow, notesAppend, notesMerge } from "./notes.js";

const LEDGER_REF = "refs/notes/git-for-ai/intent";

describe("git notes operations", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("notesShow returns null when no note exists for a commit", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
    const note = await notesShow(LEDGER_REF, sha, { cwd: repo.dir });
    expect(note).toBeNull();
  });

  it("notesAppend then notesShow round-trips the exact body, including JSON", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
    const entry = JSON.stringify({ schema: "git-for-ai/ledger-entry@1", change_id: "abc123", summary: "did a thing" });

    await notesAppend(LEDGER_REF, sha, entry, { cwd: repo.dir });
    const note = await notesShow(LEDGER_REF, sha, { cwd: repo.dir });

    expect(note).toBe(entry);
  });

  it("notesAppend called twice appends rather than overwrites", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });

    await notesAppend(LEDGER_REF, sha, "entry-one", { cwd: repo.dir });
    await notesAppend(LEDGER_REF, sha, "entry-two", { cwd: repo.dir });

    const note = await notesShow(LEDGER_REF, sha, { cwd: repo.dir });
    expect(note).toContain("entry-one");
    expect(note).toContain("entry-two");
    // git notes append separates paragraphs with a blank line; both must still be present
    // in commit order so an append-only reader can split and parse each one.
    expect(note?.indexOf("entry-one")).toBeLessThan(note?.indexOf("entry-two") ?? -1);
  });

  it("notesMerge actually invokes real `git notes merge` to union two independently-appended notes", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });

    const refA = "refs/notes/git-for-ai/merge-test-a";
    const refB = "refs/notes/git-for-ai/merge-test-b";

    await notesAppend(refA, sha, "from-a", { cwd: repo.dir });
    await notesAppend(refB, sha, "from-b", { cwd: repo.dir });

    await notesMerge(refA, refB, { cwd: repo.dir, strategy: "cat_sort_uniq" });

    const merged = await notesShow(refA, sha, { cwd: repo.dir });
    expect(merged).toContain("from-a");
    expect(merged).toContain("from-b");
  });

  it("notesMerge respects the union strategy without dropping either side's content", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });

    const refA = "refs/notes/git-for-ai/union-test-a";
    const refB = "refs/notes/git-for-ai/union-test-b";

    await notesAppend(refA, sha, "line-alpha", { cwd: repo.dir });
    await notesAppend(refB, sha, "line-beta", { cwd: repo.dir });

    await notesMerge(refA, refB, { cwd: repo.dir, strategy: "union" });

    const merged = await notesShow(refA, sha, { cwd: repo.dir });
    expect(merged).toContain("line-alpha");
    expect(merged).toContain("line-beta");
  });
});

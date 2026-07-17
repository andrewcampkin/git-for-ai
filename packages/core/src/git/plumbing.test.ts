import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "./testFixtures.js";
import { hashObject, mktree, commitTree, updateRef } from "./plumbing.js";
import { readCommitMessage, catFile, lsTree, revParse } from "./read.js";

describe("git plumbing primitives", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("hashObject computes the real git blob SHA without writing it (dry run)", async () => {
    const sha = await hashObject("hello world\n", { cwd: repo.dir });
    // Known git blob SHA-1 for "hello world\n" — same value `git hash-object` gives for this content.
    expect(sha).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");

    // Not written yet: cat-file should fail against a repo with no commits/objects containing it.
    await expect(catFile(sha, { cwd: repo.dir })).rejects.toThrow();
  });

  it("hashObject with write:true actually stores the object, readable via catFile", async () => {
    const content = "stored via hash-object -w\n";
    const sha = await hashObject(content, { cwd: repo.dir, write: true });
    const readBack = await catFile(sha, { cwd: repo.dir });
    expect(readBack).toBe(content);
  });

  it("builds a commit entirely from plumbing primitives and points a ref at it", async () => {
    const blobSha = await hashObject("hello from mktree\n", { cwd: repo.dir, write: true });

    const treeSha = await mktree(
      [{ mode: "100644", type: "blob", sha: blobSha, path: "hello.txt" }],
      { cwd: repo.dir },
    );

    const commitSha = await commitTree(treeSha, { cwd: repo.dir, message: "built via plumbing" });

    await updateRef("refs/heads/plumbing-test", commitSha, { cwd: repo.dir });

    expect(await revParse("refs/heads/plumbing-test", { cwd: repo.dir })).toBe(commitSha);
    expect(await readCommitMessage(commitSha, { cwd: repo.dir })).toBe("built via plumbing");

    const entries = await lsTree(treeSha, { cwd: repo.dir });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ mode: "100644", type: "blob", sha: blobSha, path: "hello.txt" });
  });

  it("commitTree wires up parents so the resulting commit has real history", async () => {
    const blobSha = await hashObject("v1\n", { cwd: repo.dir, write: true });
    const treeSha = await mktree([{ mode: "100644", type: "blob", sha: blobSha, path: "f.txt" }], {
      cwd: repo.dir,
    });
    const rootCommit = await commitTree(treeSha, { cwd: repo.dir, message: "root" });

    const blobSha2 = await hashObject("v2\n", { cwd: repo.dir, write: true });
    const treeSha2 = await mktree([{ mode: "100644", type: "blob", sha: blobSha2, path: "f.txt" }], {
      cwd: repo.dir,
    });
    const childCommit = await commitTree(treeSha2, {
      cwd: repo.dir,
      message: "child",
      parents: [rootCommit],
    });

    await updateRef("refs/heads/history-test", childCommit, { cwd: repo.dir });

    expect(await revParse("refs/heads/history-test~1", { cwd: repo.dir })).toBe(rootCommit);
  });

  it("updateRef supports a compare-and-swap oldSha guard", async () => {
    const blobSha = await hashObject("x\n", { cwd: repo.dir, write: true });
    const treeSha = await mktree([{ mode: "100644", type: "blob", sha: blobSha, path: "x.txt" }], {
      cwd: repo.dir,
    });
    const commitA = await commitTree(treeSha, { cwd: repo.dir, message: "a" });
    const commitB = await commitTree(treeSha, { cwd: repo.dir, message: "b", parents: [commitA] });

    await updateRef("refs/heads/cas-test", commitA, { cwd: repo.dir });

    // Wrong oldSha should be rejected by git itself.
    await expect(
      updateRef("refs/heads/cas-test", commitB, { cwd: repo.dir, oldSha: commitB }),
    ).rejects.toThrow();
    expect(await revParse("refs/heads/cas-test", { cwd: repo.dir })).toBe(commitA);

    // Correct oldSha succeeds.
    await updateRef("refs/heads/cas-test", commitB, { cwd: repo.dir, oldSha: commitA });
    expect(await revParse("refs/heads/cas-test", { cwd: repo.dir })).toBe(commitB);
  });
});

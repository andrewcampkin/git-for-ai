import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "./testFixtures.js";
import { readHead, readCommitMessage, catFile, listRefs, revParse, lsTree } from "./read.js";

describe("git read operations", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("readHead resolves to the current commit SHA after a real commit", async () => {
    const sha = await repo.commit("first commit", { files: { "readme.md": "hello\n" } });
    const head = await readHead({ cwd: repo.dir });
    expect(head).toBe(sha);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("readCommitMessage returns the exact message of a real commit", async () => {
    const message = "Add readme\n\nExplains what this repo is for.";
    const sha = await repo.commit(message, { files: { "readme.md": "hello\n" } });
    const readBack = await readCommitMessage(sha, { cwd: repo.dir });
    expect(readBack).toBe(message);
  });

  it("catFile returns the exact blob content, including a trailing newline", async () => {
    const content = "line one\nline two\n";
    await repo.commit("add file", { files: { "a.txt": content } });
    const entries = await lsTree("HEAD", { cwd: repo.dir, recursive: true });
    const entry = entries.find((e) => e.path === "a.txt");
    expect(entry).toBeDefined();
    const blob = await catFile(entry!.sha, { cwd: repo.dir });
    expect(blob).toBe(content);
  });

  it("catFile does not silently strip a trailing newline from blob content", async () => {
    const content = "no trailing newline is intentional here";
    await repo.commit("add file without trailing newline", { files: { "b.txt": content } });
    const entries = await lsTree("HEAD", { cwd: repo.dir, recursive: true });
    const entry = entries.find((e) => e.path === "b.txt");
    const blob = await catFile(entry!.sha, { cwd: repo.dir });
    expect(blob).toBe(content);
  });

  it("listRefs lists branches created by real commits", async () => {
    await repo.commit("first commit", { files: { "a.txt": "a" } });
    const refs = await listRefs("refs/heads/*", { cwd: repo.dir });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.ref).toBe("refs/heads/main");
    expect(refs[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("listRefs finds notes refs alongside branches", async () => {
    const sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
    await repo.run(["notes", "--ref=refs/notes/git-for-ai/intent", "add", "-m", "note body", sha]);
    const refs = await listRefs(undefined, { cwd: repo.dir });
    const refNames = refs.map((r) => r.ref);
    expect(refNames).toContain("refs/heads/main");
    expect(refNames).toContain("refs/notes/git-for-ai/intent");
  });

  it("revParse resolves HEAD, branch names, and relative expressions", async () => {
    const first = await repo.commit("first", { files: { "a.txt": "1" } });
    const second = await repo.commit("second", { files: { "a.txt": "2" } });

    expect(await revParse("HEAD", { cwd: repo.dir })).toBe(second);
    expect(await revParse("main", { cwd: repo.dir })).toBe(second);
    expect(await revParse("HEAD~1", { cwd: repo.dir })).toBe(first);
  });

  it("revParse throws a GitError for an unresolvable revision", async () => {
    await repo.commit("first", { files: { "a.txt": "1" } });
    await expect(revParse("refs/heads/does-not-exist", { cwd: repo.dir })).rejects.toThrow();
  });

  it("lsTree lists real committed files with correct mode/type/sha/path", async () => {
    await repo.commit("add files", {
      files: {
        "top.txt": "top",
        "nested/inner.txt": "inner",
      },
    });

    const rootEntries = await lsTree("HEAD", { cwd: repo.dir });
    const paths = rootEntries.map((e) => e.path).sort();
    expect(paths).toEqual(["nested", "top.txt"]);
    const topEntry = rootEntries.find((e) => e.path === "top.txt");
    expect(topEntry?.type).toBe("blob");
    expect(topEntry?.mode).toBe("100644");

    const recursiveEntries = await lsTree("HEAD", { cwd: repo.dir, recursive: true });
    const recursivePaths = recursiveEntries.map((e) => e.path).sort();
    expect(recursivePaths).toEqual(["nested/inner.txt", "top.txt"]);
    expect(recursiveEntries.every((e) => e.type === "blob")).toBe(true);
  });
});

// Tests for the review server's plain-git read helpers (DESKTOP.md §5 step 2), against
// REAL temporary repositories driven through the real git binary — never mocked, per the
// repo's first hard rule. Real branches, real merges, real renames, real binary files.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { listBranches, readCommitDiff } from "./reviewGit.js";

describe("listBranches (local branches only — DESKTOP.md §1 metadata refs stay invisible)", () => {
  let repo: FixtureRepo;
  let mainTip: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    mainTip = await repo.commit("first", { files: { "a.txt": "one\n" } });
    await repo.run(["checkout", "-b", "feature/login"]);
    await repo.commit("feature work", { files: { "b.txt": "two\n" } });
    await repo.run(["checkout", "main"]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("lists local branches newest-first, marking the checked-out one", async () => {
    const data = await listBranches({ cwd: repo.dir });

    expect(data.current).toBe("main");
    expect(data.detached).toBe(false);
    expect(data.headSha).toBe(mainTip);
    expect(data.branches.map((b) => b.name).sort()).toEqual(["feature/login", "main"]);
    // Newest committer date first: the feature branch was committed last.
    expect(data.branches[0]!.name).toBe("feature/login");

    const main = data.branches.find((b) => b.name === "main")!;
    expect(main.current).toBe(true);
    expect(main.ref).toBe("refs/heads/main");
    expect(main.sha).toBe(mainTip);
    expect(main.shortSha.length).toBeGreaterThan(0);
    expect(main.subject).toBe("first");
    expect(main.committerDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // No upstream configured: honest nulls, never a fabricated 0/0.
    expect(main.upstream).toBeNull();
    expect(main.ahead).toBeNull();
    expect(main.behind).toBeNull();

    expect(data.branches.find((b) => b.name === "feature/login")!.current).toBe(false);
  });

  it("never surfaces refs/git-for-ai/* or refs/notes/* as branches", async () => {
    // Write a metadata-shaped ref and a note ref exactly where our storage lives.
    await repo.run(["update-ref", "refs/git-for-ai/change-map", mainTip]);
    await repo.run(["notes", "--ref=git-for-ai/intent", "add", "-f", "-m", "note", mainTip]);

    const data = await listBranches({ cwd: repo.dir });
    const refs = data.branches.map((b) => b.ref);
    expect(refs.every((ref) => ref.startsWith("refs/heads/"))).toBe(true);
    expect(refs).not.toContain("refs/git-for-ai/change-map");
    expect(refs.some((ref) => ref.startsWith("refs/notes/"))).toBe(false);
  });

  it("reports a detached HEAD honestly rather than guessing a branch", async () => {
    await repo.run(["checkout", "--detach", mainTip]);
    try {
      const data = await listBranches({ cwd: repo.dir });
      expect(data.current).toBeNull();
      expect(data.detached).toBe(true);
      expect(data.headSha).toBe(mainTip);
      expect(data.branches.every((b) => !b.current)).toBe(true);
    } finally {
      await repo.run(["checkout", "main"]);
    }
  });

  it("reports ahead/behind against a real upstream", async () => {
    const remote = await createFixtureRepo({ bare: true });
    try {
      await repo.run(["remote", "add", "origin", remote.dir]);
      await repo.run(["push", "-u", "origin", "main"]);

      const inSync = await listBranches({ cwd: repo.dir });
      const tracked = inSync.branches.find((b) => b.name === "main")!;
      expect(tracked.upstream).toBe("origin/main");
      expect(tracked.ahead).toBe(0);
      expect(tracked.behind).toBe(0);

      await repo.commit("local only", { files: { "c.txt": "three\n" } });
      const ahead = await listBranches({ cwd: repo.dir });
      expect(ahead.branches.find((b) => b.name === "main")!.ahead).toBe(1);
      expect(ahead.branches.find((b) => b.name === "main")!.behind).toBe(0);
    } finally {
      await remote.cleanup();
    }
  });

  it("fails loudly outside a git repository", async () => {
    await expect(listBranches({ cwd: process.env.TEMP ?? "/tmp" })).rejects.toThrow();
  });
});

describe("readCommitDiff (real commits: root, modify, rename, delete, binary, merge)", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo();
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("renders a root commit as all-added, diffed against nothing", async () => {
    const sha = await repo.commit("root", { files: { "src/a.txt": "one\ntwo\nthree\n" } });
    const diff = await readCommitDiff(sha, { cwd: repo.dir });

    expect(diff.sha).toBe(sha);
    expect(diff.subject).toBe("root");
    expect(diff.parents).toEqual([]);
    expect(diff.against).toBeNull();
    expect(diff.isMerge).toBe(false);
    expect(diff.files).toHaveLength(1);

    const file = diff.files[0]!;
    expect(file.path).toBe("src/a.txt");
    expect(file.status).toBe("added");
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(0);
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]!.newStart).toBe(1);
    expect(file.hunks[0]!.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(file.hunks[0]!.lines.every((l) => l.kind === "add" && l.oldLine === null)).toBe(true);
    expect(diff.totals).toEqual({ files: 1, additions: 3, deletions: 0 });
    expect(diff.truncated).toBe(false);
  });

  it("numbers context/add/del lines against the pre- and post-image", async () => {
    const sha = await repo.commit("modify", {
      files: { "src/a.txt": "one\nTWO\nthree\nfour\n" },
    });
    const diff = await readCommitDiff(sha, { cwd: repo.dir });
    const file = diff.files[0]!;

    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);

    const lines = file.hunks[0]!.lines;
    const del = lines.find((l) => l.kind === "del")!;
    expect(del.text).toBe("two");
    expect(del.oldLine).toBe(2);
    expect(del.newLine).toBeNull();

    const added = lines.filter((l) => l.kind === "add").map((l) => l.text);
    expect(added).toEqual(["TWO", "four"]);
    const context = lines.filter((l) => l.kind === "context");
    expect(context[0]!.text).toBe("one");
    expect(context[0]!.oldLine).toBe(1);
    expect(context[0]!.newLine).toBe(1);
  });

  it("detects renames and reports both paths", async () => {
    await repo.run(["mv", "src/a.txt", "src/renamed.txt"]);
    const sha = await repo.commit("rename it");
    const diff = await readCommitDiff(sha, { cwd: repo.dir });

    expect(diff.files).toHaveLength(1);
    const file = diff.files[0]!;
    expect(file.status).toBe("renamed");
    expect(file.path).toBe("src/renamed.txt");
    expect(file.oldPath).toBe("src/a.txt");
    expect(file.similarity).toBe(100);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("renders a deletion with the deleted path and no post-image lines", async () => {
    await repo.run(["rm", "src/renamed.txt"]);
    const sha = await repo.commit("delete it");
    const diff = await readCommitDiff(sha, { cwd: repo.dir });

    const file = diff.files[0]!;
    expect(file.status).toBe("deleted");
    expect(file.path).toBe("src/renamed.txt");
    expect(file.deletions).toBe(4);
    expect(file.hunks[0]!.lines.every((l) => l.kind === "del" && l.newLine === null)).toBe(true);
  });

  it("labels a binary file instead of pretending it has hunks", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(repo.dir, "logo.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
    const sha = await repo.commit("add a binary");
    const diff = await readCommitDiff(sha, { cwd: repo.dir });

    const file = diff.files.find((f) => f.path === "logo.bin")!;
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
    expect(file.status).toBe("added");
  });

  it("shows a merge against its first parent, and says so out loud", async () => {
    await repo.run(["checkout", "-b", "topic"]);
    await repo.commit("topic change", { files: { "topic.txt": "from the topic branch\n" } });
    await repo.run(["checkout", "main"]);
    await repo.commit("main change", { files: { "mainline.txt": "from main\n" } });
    await repo.run(["merge", "--no-ff", "-m", "merge topic", "topic"]);
    const sha = await repo.revParse("HEAD");

    const diff = await readCommitDiff(sha, { cwd: repo.dir });
    expect(diff.isMerge).toBe(true);
    expect(diff.parents).toHaveLength(2);
    expect(diff.against).toBe(diff.parents[0]);
    // The honest part: a merge's diff is NOT empty, and the framing is stated.
    expect(diff.files.map((f) => f.path)).toContain("topic.txt");
    expect(diff.warnings.join(" ")).toMatch(/first parent/);
  });

  it("honors the context-lines knob", async () => {
    const sha = await repo.commit("wide context", {
      files: { "ctx.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" },
    });
    await repo.writeFile("ctx.txt", "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n");
    const changed = await repo.commit("touch the middle");

    const tight = await readCommitDiff(changed, { cwd: repo.dir, contextLines: 0 });
    const wide = await readCommitDiff(changed, { cwd: repo.dir, contextLines: 4 });
    expect(sha).not.toBe(changed);
    expect(tight.files[0]!.hunks[0]!.lines.filter((l) => l.kind === "context")).toHaveLength(0);
    expect(
      wide.files[0]!.hunks[0]!.lines.filter((l) => l.kind === "context").length,
    ).toBeGreaterThan(4);
  });

  it("resolves short SHAs and branch names, and throws on an unresolvable target", async () => {
    const head = await repo.revParse("HEAD");
    const byShort = await readCommitDiff(head.slice(0, 8), { cwd: repo.dir });
    expect(byShort.sha).toBe(head);
    const byBranch = await readCommitDiff("main", { cwd: repo.dir });
    expect(byBranch.sha).toBe(head);

    await expect(readCommitDiff("no-such-rev", { cwd: repo.dir })).rejects.toThrow();
  });

  it("keeps +/- counts complete when a huge file body is truncated", async () => {
    // 3000 lines > MAX_LINES_PER_FILE (2000): the body clips, the stats must not.
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const sha = await repo.commit("a very large file", { files: { "big.txt": `${big}\n` } });
    const diff = await readCommitDiff(sha, { cwd: repo.dir });

    const file = diff.files.find((f) => f.path === "big.txt")!;
    expect(file.additions).toBe(3000);
    expect(file.truncated).toBe(true);
    expect(file.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThan(3000);
    expect(diff.truncated).toBe(true);
    expect(diff.warnings.join(" ")).toMatch(/truncated/);
  });
});

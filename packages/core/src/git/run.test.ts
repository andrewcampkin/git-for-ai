import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit, GitError } from "./run.js";
import { createFixtureRepo, type FixtureRepo } from "./testFixtures.js";
import { readCommitMessage } from "./read.js";

describe("runGit", () => {
  it("runs a plain git command and returns trimmed stdout", async () => {
    const result = await runGit(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version/);
  });

  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("throws a GitError with the failing args and stderr on non-zero exit", async () => {
    await expect(runGit(["not-a-real-git-subcommand"], { cwd: repo.dir })).rejects.toMatchObject({
      name: "GitError",
      args: ["not-a-real-git-subcommand"],
    });
  });

  it("is an instance of GitError specifically, not just Error", async () => {
    try {
      await runGit(["not-a-real-git-subcommand"], { cwd: repo.dir });
      expect.unreachable("expected runGit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).exitCode).not.toBe(0);
    }
  });

  it("does not throw on non-zero exit when allowFailure is set, and reports the real exit code", async () => {
    const result = await runGit(["not-a-real-git-subcommand"], { cwd: repo.dir, allowFailure: true });
    expect(result.exitCode).not.toBe(0);
  });

  it("passes arguments as a real array with no shell interpretation (no quoting hazard)", async () => {
    // A commit message containing shell metacharacters must survive completely unmangled —
    // this is the whole point of execa's argument-array spawning per ARCHITECTURE.md §4.1.
    const dangerousMessage = "fix: don't break; $(echo pwned) && rm -rf / || true";
    const sha = await repo.commit(dangerousMessage, { allowEmpty: true });
    const readBack = await readCommitMessage(sha, { cwd: repo.dir });
    expect(readBack).toBe(dangerousMessage);
  });

  it("feeds `input` to the subprocess's stdin", async () => {
    const result = await runGit(["hash-object", "--stdin"], { cwd: repo.dir, input: "hello world\n" });
    // Known git blob SHA-1 for "hello world\n".
    expect(result.stdout).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });
});

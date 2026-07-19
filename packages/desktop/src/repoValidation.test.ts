// repoValidation — the picker's classification of a chosen folder, exercised against REAL
// repositories (createFixtureRepo, the no-mocks rule) and the REAL `runInit` the picker's
// Initialize button invokes. Path comparisons go through realpathSync.native because
// Windows temp dirs can surface 8.3 short names (the known blame-test lesson).

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";
import { runInit } from "git-for-ai/dist/commands/init.js";

import { validateRepo } from "./repoValidation.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function fixture(): Promise<FixtureRepo> {
  const repo = await createFixtureRepo();
  cleanups.push(() => repo.cleanup());
  return repo;
}

function canonical(path: string): string {
  return realpathSync.native(path);
}

describe("validateRepo", () => {
  it("rejects a path that does not exist", async () => {
    const result = await validateRepo(join(tmpdir(), "git-for-ai-desktop-no-such-dir"));
    expect(result.status).toBe("invalid");
  });

  it("rejects a plain directory that is not a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-for-ai-desktop-plain-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const result = await validateRepo(dir);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("not a git repository");
    }
  });

  it("classifies a real repo without .git-for-ai/ as uninitialized", async () => {
    const repo = await fixture();
    await repo.commit("initial", { files: { "a.txt": "hello\n" } });
    const result = await validateRepo(repo.dir);
    expect(result.status).toBe("uninitialized");
    if (result.status === "uninitialized") {
      expect(canonical(result.repoRoot)).toBe(canonical(repo.dir));
    }
  });

  it("classifies a repo as ok after the real runInit (the picker's Initialize path)", async () => {
    const repo = await fixture();
    await repo.commit("initial", { files: { "a.txt": "hello\n" } });
    await runInit({ cwd: repo.dir });
    const result = await validateRepo(repo.dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(canonical(result.repoRoot)).toBe(canonical(repo.dir));
    }
  });

  it("resolves a subdirectory inside a repo to the repo's toplevel", async () => {
    const repo = await fixture();
    await repo.commit("initial", { files: { "sub/dir/file.txt": "nested\n" } });
    await runInit({ cwd: repo.dir });
    const result = await validateRepo(join(repo.dir, "sub", "dir"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(canonical(result.repoRoot)).toBe(canonical(repo.dir));
    }
  });
});

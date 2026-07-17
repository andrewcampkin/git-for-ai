import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixtureRepo } from "./testFixtures.js";

describe("createFixtureRepo", () => {
  it("creates a real temp directory with a real .git directory inside it", async () => {
    const repo = await createFixtureRepo();
    try {
      await expect(access(repo.dir)).resolves.toBeUndefined();
      await expect(access(join(repo.dir, ".git"))).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("uses the requested initial branch name", async () => {
    const repo = await createFixtureRepo({ initialBranch: "trunk" });
    try {
      const result = await repo.run(["symbolic-ref", "--short", "HEAD"]);
      expect(result.stdout).toBe("trunk");
    } finally {
      await repo.cleanup();
    }
  });

  it("writeFile + commit produces a real, inspectable commit", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("add greeting", { files: { "greeting.txt": "hi\n" } });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(await repo.revParse("HEAD")).toBe(sha);

      const log = await repo.run(["log", "--format=%s", "-1"]);
      expect(log.stdout).toBe("add greeting");
    } finally {
      await repo.cleanup();
    }
  });

  it("scripts a real sequence of multiple commits", async () => {
    const repo = await createFixtureRepo();
    try {
      const first = await repo.commit("first", { files: { "f.txt": "1\n" } });
      const second = await repo.commit("second", { files: { "f.txt": "2\n" } });
      const third = await repo.commit("third", { files: { "f.txt": "3\n" } });

      const log = await repo.run(["log", "--format=%H"]);
      expect(log.stdout.split("\n")).toEqual([third, second, first]);
    } finally {
      await repo.cleanup();
    }
  });

  it("supports allowEmpty commits with no file changes", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("empty commit", { allowEmpty: true });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });

  it("cleanup removes the temp directory", async () => {
    const repo = await createFixtureRepo();
    await repo.commit("first", { files: { "f.txt": "1\n" } });
    await repo.cleanup();

    await expect(access(repo.dir)).rejects.toThrow();
  });

  it("isolates fixture repos from the machine's global git config identity requirements", async () => {
    // If the fixture didn't set a local user.name/user.email, committing would fail on a
    // machine/CI image with no global git identity configured. This proves it's self-contained.
    const repo = await createFixtureRepo();
    try {
      const result = await repo.run(["config", "--local", "user.email"]);
      expect(result.stdout).toBe("fixture@git-for-ai.test");
    } finally {
      await repo.cleanup();
    }
  });
});

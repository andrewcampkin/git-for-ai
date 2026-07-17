// Integration tests for `git for-ai init` against REAL temporary git repositories
// (createFixtureRepo — never mocked), per CLI_PLAN.md M5's definition of done:
// every file/hook/ref-config exists after a run; a second run is a no-op (idempotency,
// per CLI_REFERENCE.md); pre-existing unrelated hook content is never clobbered.

import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import {
  GIT_FOR_AI_REFSPECS,
  REFSPEC_CONFIG_KEY,
  formatInitResult,
  runInit,
  type InitResult,
} from "./init.js";

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

function hookPath(name: string): string {
  return join(repo.dir, ".git", "hooks", name);
}

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(join(repo.dir, relPath), "utf8");
}

describe("runInit — fresh repo", () => {
  let result: InitResult;

  beforeEach(async () => {
    result = await runInit({ cwd: repo.dir });
  });

  it("installs all three git hooks with the managed dispatch block", async () => {
    expect(result.hooks.map((h) => h.name)).toEqual(["post-commit", "post-rewrite", "commit-msg"]);
    for (const name of ["commit-msg", "post-commit", "post-rewrite"]) {
      const content = await readFile(hookPath(name), "utf8");
      expect(content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(content).toContain("# >>> git-for-ai >>>");
      expect(content).toContain(`git-for-ai internal-hook ${name} "$@" || true`);
      expect(content).toContain("# <<< git-for-ai <<<");
    }
    expect(result.hooks.every((h) => h.action === "created")).toBe(true);
    expect(result.hooksPathSource).toBe("default");
  });

  it("installed hooks never block a commit even though git-for-ai is not on PATH", async () => {
    // The managed block ends in `|| true`; a commit made through the real hooks must succeed.
    const sha = await repo.commit("post-init commit", { allowEmpty: true });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("writes .claude/settings.json with the exact ARCHITECTURE §10.1 hook shape", async () => {
    expect(result.claudeSettingsAction).toBe("created");
    const settings = JSON.parse(await readRepoFile(".claude/settings.json"));
    expect(settings.hooks.PostToolUse).toEqual([
      {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: "git for-ai capture-session --event plan" }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "git for-ai capture-session --event maybe-commit" }],
      },
    ]);
  });

  it("records the two refspecs under git-for-ai.refspec without touching remote fetch config", async () => {
    const configured = await repo.run(["config", "--get-all", REFSPEC_CONFIG_KEY]);
    expect(configured.stdout.split("\n")).toEqual([...GIT_FOR_AI_REFSPECS]);
    expect(result.refspecs.added).toEqual([...GIT_FOR_AI_REFSPECS]);

    // No auto-follow: nothing was added to any remote.<name>.fetch.
    const remoteFetch = await repo.run(["config", "--get-regexp", "^remote\\..*\\.fetch$"], {
      allowFailure: true,
    });
    expect(remoteFetch.exitCode).not.toBe(0); // key not set at all
  });

  it("creates .git-for-ai/ with config.toml, state.json, empty index.db and embcache/", async () => {
    const configToml = await readRepoFile(".git-for-ai/config.toml");
    expect(configToml).toContain('schema = "git-for-ai/config@1"');
    expect(configToml).toContain('provider = "jina-v2-code"');
    expect(configToml).toContain("dim = 768");
    expect(configToml).toContain("offline = true");
    expect(configToml).toContain("voyage_consent = false");
    expect(configToml).toContain("enabled = true");
    expect(configToml).toContain(
      'never_capture = [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"]',
    );
    expect(configToml).toContain("max_span_bytes = 16384");
    expect(configToml).toContain('ruleset = "builtin@1"');
    expect(configToml).toContain("hybrid = true");

    const state = JSON.parse(await readRepoFile(".git-for-ai/state.json"));
    expect(state).toMatchObject({
      schema: "git-for-ai/index-state@1",
      last_indexed_commit: null,
      model_fingerprint: "jina-v2-code/768",
      vec_schema_version: 1,
      chunk_count: 0,
    });

    expect(await readRepoFile(".git-for-ai/index.db")).toBe("");
    expect(existsSync(join(repo.dir, ".git-for-ai", "embcache"))).toBe(true);
  });

  it("excludes .git-for-ai/ via .git/info/exclude and git actually ignores it", async () => {
    const exclude = await readFile(join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".git-for-ai/");

    // Ask real git: the cache dir must not show up as untracked.
    const status = await repo.run(["status", "--porcelain"]);
    expect(status.stdout).not.toContain(".git-for-ai");
    const check = await repo.run(["check-ignore", ".git-for-ai/config.toml"], { allowFailure: true });
    expect(check.exitCode).toBe(0); // 0 = path IS ignored
  });

  it("reports changed=true and renders the CLI_REFERENCE console transcript", () => {
    expect(result.changed).toBe(true);
    const output = formatInitResult(result);
    expect(output).toContain("✓ git hooks installed (post-commit, post-rewrite, commit-msg)");
    expect(output).toContain("✓ Claude Code hooks written to .claude/settings.json");
    expect(output).toContain(
      "✓ refspecs configured for refs/notes/git-for-ai/*, refs/git-for-ai/*  (manual sync only)",
    );
    expect(output).toContain("✓ .git-for-ai/ created and excluded; sqlite-vec index initialized (empty)");
    expect(output).toContain("Embedder: jina-embeddings-v2-code (self-hosted, offline).");
    expect(output).toContain("Capture is ON for this repo. Data stays local until `git for-ai sync --push`.");
  });
});

describe("runInit — idempotency (CLI_REFERENCE: safe to re-run)", () => {
  it("a second run changes nothing: no duplication, no clobbering, byte-identical files", async () => {
    await runInit({ cwd: repo.dir });

    const snapshot = async () => ({
      commitMsg: await readFile(hookPath("commit-msg"), "utf8"),
      postCommit: await readFile(hookPath("post-commit"), "utf8"),
      postRewrite: await readFile(hookPath("post-rewrite"), "utf8"),
      claude: await readRepoFile(".claude/settings.json"),
      configToml: await readRepoFile(".git-for-ai/config.toml"),
      stateJson: await readRepoFile(".git-for-ai/state.json"),
      exclude: await readFile(join(repo.dir, ".git", "info", "exclude"), "utf8"),
      refspecs: (await repo.run(["config", "--get-all", REFSPEC_CONFIG_KEY])).stdout,
    });

    const before = await snapshot();
    const second = await runInit({ cwd: repo.dir });
    const after = await snapshot();

    expect(after).toEqual(before);
    expect(second.changed).toBe(false);
    expect(second.hooks.every((h) => h.action === "unchanged")).toBe(true);
    expect(second.claudeSettingsAction).toBe("unchanged");
    expect(second.refspecs.added).toEqual([]);
    expect(second.configTomlAction).toBe("unchanged");
    expect(second.stateJsonAction).toBe("unchanged");
    expect(second.indexDbAction).toBe("unchanged");
    expect(second.excludeAction).toBe("unchanged");

    // No duplicated refspec values.
    expect(after.refspecs.split("\n")).toHaveLength(GIT_FOR_AI_REFSPECS.length);
    // No duplicated Claude hook entries.
    const settings = JSON.parse(after.claude);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });
});

describe("runInit — never clobbers pre-existing content", () => {
  it("appends to a pre-existing unrelated hook, preserving the user's script", async () => {
    const userScript = "#!/bin/sh\n# my precious pre-existing hook\nnpx lint-staged\n";
    await writeFile(hookPath("post-commit"), userScript, "utf8");
    await chmod(hookPath("post-commit"), 0o755);

    const result = await runInit({ cwd: repo.dir });
    const postCommit = result.hooks.find((h) => h.name === "post-commit");
    expect(postCommit?.action).toBe("appended");

    const content = await readFile(hookPath("post-commit"), "utf8");
    // User content is intact and still first.
    expect(content.startsWith(userScript)).toBe(true);
    expect(content).toContain("npx lint-staged");
    // Our managed block follows it.
    expect(content).toContain('git-for-ai internal-hook post-commit "$@" || true');

    // And a re-run leaves the combined file alone (no second block).
    const before = await readFile(hookPath("post-commit"), "utf8");
    await runInit({ cwd: repo.dir });
    const after = await readFile(hookPath("post-commit"), "utf8");
    expect(after).toBe(before);
    expect(after.match(/internal-hook post-commit/g)).toHaveLength(1);
  });

  it("merges into a pre-existing .claude/settings.json, preserving other hooks and keys", async () => {
    await repo.writeFile(
      ".claude/settings.json",
      JSON.stringify(
        {
          permissions: { allow: ["Bash(npm run test)"] },
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "some-other-tool --log" }] },
            ],
          },
        },
        null,
        2,
      ),
    );

    const result = await runInit({ cwd: repo.dir });
    expect(result.claudeSettingsAction).toBe("merged");

    const settings = JSON.parse(await readRepoFile(".claude/settings.json"));
    // Unrelated top-level keys and hook events survive.
    expect(settings.permissions).toEqual({ allow: ["Bash(npm run test)"] });
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
    ]);
    // The user's existing Bash PostToolUse hook survives, ours is added beside it.
    const bashGroup = settings.hooks.PostToolUse.find(
      (g: { matcher: string }) => g.matcher === "Bash",
    );
    expect(bashGroup.hooks).toEqual([
      { type: "command", command: "some-other-tool --log" },
      { type: "command", command: "git for-ai capture-session --event maybe-commit" },
    ]);
    const planGroup = settings.hooks.PostToolUse.find(
      (g: { matcher: string }) => g.matcher === "ExitPlanMode",
    );
    expect(planGroup.hooks).toEqual([
      { type: "command", command: "git for-ai capture-session --event plan" },
    ]);

    // Idempotent: a re-run doesn't duplicate anything.
    const second = await runInit({ cwd: repo.dir });
    expect(second.claudeSettingsAction).toBe("unchanged");
    const again = JSON.parse(await readRepoFile(".claude/settings.json"));
    expect(again).toEqual(settings);
  });

  it("refuses to overwrite an unparseable .claude/settings.json", async () => {
    await repo.writeFile(".claude/settings.json", "{ not json !!");
    await expect(runInit({ cwd: repo.dir })).rejects.toThrow(/not valid JSON/);
    // The broken file is left exactly as it was.
    expect(await readRepoFile(".claude/settings.json")).toBe("{ not json !!");
  });

  it("does not regenerate an existing config.toml (user edits survive re-init)", async () => {
    await runInit({ cwd: repo.dir });
    const customized = (await readRepoFile(".git-for-ai/config.toml")).replace(
      "max_span_bytes = 16384",
      "max_span_bytes = 4096",
    );
    await repo.writeFile(".git-for-ai/config.toml", customized);

    const second = await runInit({ cwd: repo.dir });
    expect(second.configTomlAction).toBe("unchanged");
    expect(await readRepoFile(".git-for-ai/config.toml")).toBe(customized);
  });
});

describe("runInit — hooks path handling", () => {
  it("respects an existing core.hooksPath instead of .git/hooks", async () => {
    await repo.run(["config", "core.hooksPath", ".husky"]);

    const result = await runInit({ cwd: repo.dir });
    expect(result.hooksPathSource).toBe("core.hooksPath");
    // Compare canonical paths: on Windows, tmpdir() can yield an 8.3 short path
    // (HURRIC~1) while git reports the expanded long path for the same directory;
    // realpathSync.native expands short names, the plain JS realpath does not.
    const { realpathSync } = await import("node:fs");
    expect(realpathSync.native(result.hooksDir)).toBe(realpathSync.native(join(repo.dir, ".husky")));

    for (const name of ["commit-msg", "post-commit", "post-rewrite"]) {
      expect(existsSync(join(repo.dir, ".husky", name))).toBe(true);
      expect(existsSync(hookPath(name))).toBe(false); // default location untouched
    }
  });

  it("honors an explicit hooksPath option over everything else", async () => {
    const result = await runInit({ cwd: repo.dir, hooksPath: "custom-hooks" });
    expect(result.hooksPathSource).toBe("option");
    expect(existsSync(join(repo.dir, "custom-hooks", "post-commit"))).toBe(true);
  });
});

describe("runInit — flags", () => {
  it("--no-claude-hooks skips .claude/settings.json entirely", async () => {
    const result = await runInit({ cwd: repo.dir, claudeHooks: false });
    expect(result.claudeSettingsAction).toBe("skipped");
    expect(existsSync(join(repo.dir, ".claude", "settings.json"))).toBe(false);
    expect(formatInitResult(result)).toContain("Claude Code hooks skipped (--no-claude-hooks)");
  });

  it("--force regenerates a stale managed block without touching surrounding user content", async () => {
    await runInit({ cwd: repo.dir });

    // Simulate a stale managed block from an older version, sandwiched in user content.
    const stale = [
      "#!/bin/sh",
      "echo user-before",
      "# >>> git-for-ai >>> (old)",
      "git-for-ai old-dispatch post-commit",
      "# <<< git-for-ai <<<",
      "echo user-after",
      "",
    ].join("\n");
    await writeFile(hookPath("post-commit"), stale, "utf8");

    // Without --force: left alone.
    const noForce = await runInit({ cwd: repo.dir });
    expect(noForce.hooks.find((h) => h.name === "post-commit")?.action).toBe("unchanged");
    expect(await readFile(hookPath("post-commit"), "utf8")).toBe(stale);

    // With --force: block regenerated, user lines intact.
    const forced = await runInit({ cwd: repo.dir, force: true });
    expect(forced.hooks.find((h) => h.name === "post-commit")?.action).toBe("updated");
    const content = await readFile(hookPath("post-commit"), "utf8");
    expect(content).toContain("echo user-before");
    expect(content).toContain("echo user-after");
    expect(content).toContain('git-for-ai internal-hook post-commit "$@" || true');
    expect(content).not.toContain("old-dispatch");
  });

  it("--embedder is recorded in config.toml and state.json", async () => {
    await runInit({ cwd: repo.dir, embedder: "voyage-code-3" });
    const configToml = await readRepoFile(".git-for-ai/config.toml");
    expect(configToml).toContain('provider = "voyage-code-3"');
    expect(configToml).toContain("dim = 1024");
    expect(configToml).toContain("offline = false");
    expect(configToml).toContain("voyage_consent = false"); // consent NEVER granted by init
    const state = JSON.parse(await readRepoFile(".git-for-ai/state.json"));
    expect(state.model_fingerprint).toBe("voyage-code-3/1024");
  });
});

describe("runInit — error cases", () => {
  it("fails with a clear message outside a git repository", async () => {
    // The OS temp root is not a git repo.
    const { tmpdir } = await import("node:os");
    await expect(runInit({ cwd: tmpdir() })).rejects.toThrow(/not a git repository/);
  });
});

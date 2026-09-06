// Shared test-only helper: a real temporary git repository, created via a real `git init`
// subprocess (never mocked), for exercising the git access layer — and the
// identity resolver and the ledger — against actual git behavior.
//
// This module is intentionally NOT test-runner-specific (no vitest import) so it can be
// imported from any test file, in this package or a consuming one, without pulling in a
// particular test framework's globals.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { runGit, type RunGitOptions, type GitResult } from "./run.js";
import { revParse } from "./read.js";

/** A real, disposable git repository rooted at a temp directory, for use in tests. */
export interface FixtureRepo {
  /** Absolute path to the repository's working tree (also its `git init` target). */
  readonly dir: string;

  /** Run an arbitrary git command against this repo (shorthand for `runGit(args, { cwd: dir, ...opts })`). */
  run(args: string[], opts?: Omit<RunGitOptions, "cwd">): Promise<GitResult>;

  /**
   * Write a file inside the working tree, creating parent directories as needed.
   * Does not stage or commit it — pair with `commit()` or call `run(["add", ...])` yourself.
   */
  writeFile(relPath: string, content: string): Promise<void>;

  /**
   * Stage everything (`git add -A`) and commit, returning the new commit's SHA.
   * Pass `files` to write (and implicitly stage) file contents in one step — the common case
   * for scripting a sequence of commits in a test.
   */
  commit(message: string, options?: CommitOptions): Promise<string>;

  /** Resolve any revision expression against this repo (`revParse("HEAD")`, `revParse("HEAD~1")`, ...). */
  revParse(ref: string): Promise<string>;

  /** Remove the temp directory and everything in it. Safe to call more than once. */
  cleanup(): Promise<void>;
}

export interface CommitOptions {
  /** relative path -> file content, written before staging. */
  files?: Record<string, string>;
  /** `git commit --allow-empty` — useful for scripting a commit with no file changes. */
  allowEmpty?: boolean;
  /** Override author/committer identity for this one commit (default: the fixture's fixed test identity). */
  env?: Record<string, string>;
}

export interface CreateFixtureRepoOptions {
  /** Create a bare repository (`git init --bare`) instead of one with a working tree. Default false. */
  bare?: boolean;
  /** Initial branch name. Default `main`. */
  initialBranch?: string;
}

/** Fixed, deterministic author/committer identity used for every fixture-repo commit. */
const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: "git-for-ai test fixture",
  GIT_AUTHOR_EMAIL: "fixture@git-for-ai.test",
  GIT_COMMITTER_NAME: "git-for-ai test fixture",
  GIT_COMMITTER_EMAIL: "fixture@git-for-ai.test",
};

/**
 * Create a real temporary git repository (`fs.mkdtemp` + real `git init`) for use in tests.
 * This is the shared fixture used by the git, identity and ledger test suites.
 *
 * Nothing about the returned repo is mocked: every method shells out to the real `git` binary
 * exactly like production code does, via {@link runGit}.
 */
export async function createFixtureRepo(options: CreateFixtureRepoOptions = {}): Promise<FixtureRepo> {
  const { bare = false, initialBranch = "main" } = options;

  const dir = await mkdtemp(join(tmpdir(), "git-for-ai-fixture-"));

  const initArgs = ["init", `--initial-branch=${initialBranch}`];
  if (bare) {
    initArgs.push("--bare");
  }
  await runGit(initArgs, { cwd: dir });

  // Local (repo-scoped) config so fixture repos never depend on — or pollute — the
  // machine's global git config, and behave identically in CI and on a dev laptop.
  await runGit(["config", "user.name", FIXTURE_GIT_ENV.GIT_AUTHOR_NAME], { cwd: dir });
  await runGit(["config", "user.email", FIXTURE_GIT_ENV.GIT_AUTHOR_EMAIL], { cwd: dir });
  await runGit(["config", "commit.gpgsign", "false"], { cwd: dir });
  await runGit(["config", "tag.gpgsign", "false"], { cwd: dir });
  // Disable line-ending mangling so file contents (and therefore blob hashes) are byte-exact
  // on every platform, including Windows where core.autocrlf frequently defaults to true.
  await runGit(["config", "core.autocrlf", "false"], { cwd: dir });

  const run: FixtureRepo["run"] = (args, opts) => runGit(args, { cwd: dir, ...opts });

  const repo: FixtureRepo = {
    dir,

    run,

    async writeFile(relPath, content) {
      const absPath = join(dir, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf8");
    },

    async commit(message, commitOptions = {}) {
      const { files, allowEmpty = false, env } = commitOptions;
      if (files !== undefined) {
        for (const [relPath, content] of Object.entries(files)) {
          await repo.writeFile(relPath, content);
        }
      }
      await run(["add", "-A"]);
      const commitArgs = ["commit", "-m", message];
      if (allowEmpty) {
        commitArgs.push("--allow-empty");
      }
      await run(commitArgs, { env: { ...FIXTURE_GIT_ENV, ...env } });
      return repo.revParse("HEAD");
    },

    revParse(ref) {
      return revParse(ref, { cwd: dir });
    },

    async cleanup() {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };

  return repo;
}

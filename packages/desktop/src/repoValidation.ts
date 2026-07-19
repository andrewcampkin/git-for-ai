// Repo validation for the picker: is this folder a git repository, and has it opted in to
// git-for-ai (`.git-for-ai/` exists — the same signal /api/meta's `initialized` uses)?
// Pure logic (no Electron) so it's testable against real fixture repos.
//
// Judgment call: validation reuses core's `runGit` rather than shelling out itself — the
// desktop package never duplicates logic (DESKTOP.md §4), and this is the exact check the
// review server performs at startup, just surfaced early enough to drive picker UX
// (error message vs. "initialize?" screen) instead of a failed server start.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { runGit } from "@git-for-ai/core";

export type RepoValidation =
  /** A git repo with `.git-for-ai/` — ready to serve. `repoRoot` is the worktree toplevel. */
  | { status: "ok"; repoRoot: string }
  /** A git repo that has not run `git for-ai init` — the picker offers to initialize it. */
  | { status: "uninitialized"; repoRoot: string }
  /** Not a usable target; `message` is shown verbatim in the picker. */
  | { status: "invalid"; message: string };

/**
 * Classify `dir` for the picker. Any directory *inside* a repo resolves to that repo's
 * toplevel (same as every CLI command).
 */
export async function validateRepo(dir: string): Promise<RepoValidation> {
  let isDirectory = false;
  try {
    isDirectory = existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { status: "invalid", message: `not a folder: ${dir}` };
  }

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, allowFailure: true });
  if (toplevel.exitCode !== 0 || toplevel.stdout.length === 0) {
    return { status: "invalid", message: `not a git repository: ${dir}` };
  }
  const repoRoot = resolve(toplevel.stdout);

  return existsSync(join(repoRoot, ".git-for-ai"))
    ? { status: "ok", repoRoot }
    : { status: "uninitialized", repoRoot };
}

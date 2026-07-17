// Low-level object-creation plumbing needed by Milestone 3's change-map implementation
// (a hand-built tree of shard files under refs/git-for-ai/change-map) and by Milestone 4's
// notes-based ledger. All of it shells out via runGit — see ./run.ts.

import { runGit, type RunGitOptions } from "./run.js";
import type { TreeEntry } from "./read.js";

/** Git's object type enum, as accepted by `hash-object -t`. */
export type GitObjectType = "blob" | "tree" | "commit" | "tag";

export interface HashObjectOptions extends RunGitOptions {
  /** Object type to hash as. Defaults to `blob`. */
  type?: GitObjectType;
  /** Actually write the object into the object database (`-w`). Defaults to false (dry-run hash). */
  write?: boolean;
}

/**
 * Compute (and optionally write) the git object id for `content`, equivalent to
 * `git hash-object [-w] -t <type> --stdin`.
 */
export async function hashObject(content: string | Uint8Array, opts: HashObjectOptions = {}): Promise<string> {
  const { type = "blob", write = false, ...runOpts } = opts;
  const args = ["hash-object", "-t", type, "--stdin"];
  if (write) {
    args.push("-w");
  }
  const result = await runGit(args, { ...runOpts, input: content });
  return result.stdout;
}

/** One entry to be assembled into a tree by {@link mktree}. */
export interface MktreeEntry {
  /** Octal file mode, e.g. `100644` (file), `100755` (executable), `040000` (subtree), `120000` (symlink). */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  path: string;
}

/**
 * Build a tree object from a flat list of entries, equivalent to piping
 * `"<mode> <type> <sha>\t<path>"` lines into `git mktree`. Returns the new tree's SHA.
 * Entries are written in the order given; per `git mktree` semantics they should already
 * be sorted (git-for-ai's change-map shards by change-id prefix, which keeps this trivial —
 * sort by `path` before calling if the caller can't otherwise guarantee order).
 */
export async function mktree(entries: MktreeEntry[], opts: RunGitOptions = {}): Promise<string> {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join("\n");
  const result = await runGit(["mktree"], { ...opts, input });
  return result.stdout;
}

export interface CommitTreeOptions extends RunGitOptions {
  /** Parent commit SHAs, in order. Omit/empty for a root commit. */
  parents?: string[];
  message: string;
}

/**
 * Create a commit object pointing at `treeSha`, equivalent to
 * `git commit-tree <tree> [-p <parent>]... -m <message>`. Returns the new commit's SHA.
 * This does not move any ref — pair with {@link updateRef} to actually point a branch/ref at it.
 */
export async function commitTree(treeSha: string, opts: CommitTreeOptions): Promise<string> {
  const { parents = [], message, ...runOpts } = opts;
  const args = ["commit-tree", treeSha];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  args.push("-m", message);
  const result = await runGit(args, runOpts);
  return result.stdout;
}

export interface UpdateRefOptions extends RunGitOptions {
  /**
   * Expected current value of the ref, for a safe compare-and-swap update.
   * If provided and the ref's actual current value differs, git refuses the update.
   * Pass the all-zero SHA (or omit) to create a brand-new ref unconditionally.
   */
  oldSha?: string;
}

/**
 * Point `ref` (e.g. `refs/git-for-ai/change-map`) at `newSha`, equivalent to
 * `git update-ref <ref> <newSha> [<oldSha>]`.
 */
export async function updateRef(ref: string, newSha: string, opts: UpdateRefOptions = {}): Promise<void> {
  const { oldSha, ...runOpts } = opts;
  const args = ["update-ref", ref, newSha];
  if (oldSha !== undefined) {
    args.push(oldSha);
  }
  await runGit(args, runOpts);
}

export type { TreeEntry };

// Read-side git plumbing: HEAD, commit messages, blob/tree contents, refs, rev-parse.
// All of these shell out via runGit — see ./run.ts and architecture/ARCHITECTURE.md §4.1.

import { runGit, type RunGitOptions } from "./run.js";

/** One row of `git for-each-ref` output. */
export interface RefInfo {
  /** Full ref name, e.g. `refs/heads/main` or `refs/notes/git-for-ai/intent`. */
  ref: string;
  /** The object the ref currently points at. */
  sha: string;
}

/** One row of `git ls-tree` output. */
export interface TreeEntry {
  /** Octal file mode as git reports it, e.g. `100644`, `040000`, `120000`. */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  /** Path relative to the tree root (or to the given subdirectory, for non-recursive calls). */
  path: string;
}

/** Resolve `HEAD` to its current commit SHA. */
export async function readHead(opts?: RunGitOptions): Promise<string> {
  return revParse("HEAD", opts);
}

/**
 * Read the full commit message (subject + body, trailers included) for `sha`,
 * exactly as `%B` renders it. Git normalizes a stored commit message to always end in
 * exactly one trailing newline regardless of what was originally passed to `git commit`;
 * that trailing newline (plus `%B`'s own format terminator) is stripped here so the
 * returned string round-trips against whatever message the caller originally authored.
 */
export async function readCommitMessage(sha: string, opts?: RunGitOptions): Promise<string> {
  const result = await runGit(["log", "-1", "--format=%B", sha], { ...opts, stripFinalNewline: false });
  return result.stdout.replace(/\n+$/, "");
}

/**
 * Read the raw content of a git object (blob, commit, tree, tag) via `cat-file -p`.
 * Returned as a UTF-8 string, byte-exact — the trailing-newline strip that most other
 * helpers apply is disabled here since blob content legitimately may or may not end
 * in a newline and we must not silently alter it.
 */
export async function catFile(sha: string, opts?: RunGitOptions): Promise<string> {
  const result = await runGit(["cat-file", "-p", sha], { ...opts, stripFinalNewline: false });
  return result.stdout;
}

/**
 * List refs matching an optional glob-ish pattern (anything `git for-each-ref` accepts,
 * e.g. `refs/heads/*`, `refs/notes/git-for-ai/*`). Omit `pattern` to list every ref.
 */
export async function listRefs(pattern?: string, opts?: RunGitOptions): Promise<RefInfo[]> {
  const args = ["for-each-ref", "--format=%(objectname) %(refname)"];
  if (pattern !== undefined) {
    args.push(pattern);
  }
  const result = await runGit(args, opts);
  if (result.stdout.length === 0) {
    return [];
  }
  return result.stdout.split("\n").map((line) => {
    const spaceIndex = line.indexOf(" ");
    return { sha: line.slice(0, spaceIndex), ref: line.slice(spaceIndex + 1) };
  });
}

/**
 * Resolve any git revision expression (`HEAD`, a branch name, a short SHA, `HEAD~1`, ...)
 * to its full SHA-1/SHA-256 object id.
 */
export async function revParse(ref: string, opts?: RunGitOptions): Promise<string> {
  const result = await runGit(["rev-parse", "--verify", ref], opts);
  return result.stdout;
}

/**
 * List the entries of a tree object. Pass `recursive: true` to walk into subtrees
 * (entries come back with `path` relative to the root and only blobs/commits are leaves).
 */
export async function lsTree(
  treeish: string,
  opts?: RunGitOptions & { recursive?: boolean },
): Promise<TreeEntry[]> {
  const args = ["ls-tree"];
  if (opts?.recursive) {
    args.push("-r");
  }
  args.push(treeish);
  const result = await runGit(args, opts);
  if (result.stdout.length === 0) {
    return [];
  }
  return result.stdout.split("\n").map(parseLsTreeLine);
}

function parseLsTreeLine(line: string): TreeEntry {
  // Format: "<mode> <type> <sha>\t<path>"
  const tabIndex = line.indexOf("\t");
  const meta = line.slice(0, tabIndex).split(" ");
  const [mode, type, sha] = meta;
  const path = line.slice(tabIndex + 1);
  if (mode === undefined || sha === undefined || (type !== "blob" && type !== "tree" && type !== "commit")) {
    throw new Error(`unparseable ls-tree line: ${JSON.stringify(line)}`);
  }
  return { mode, type, sha, path };
}

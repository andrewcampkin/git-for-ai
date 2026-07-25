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
 * Read MANY git objects in ONE `git cat-file --batch` process, keyed by the sha asked for.
 * Missing objects map to null rather than throwing — a batch read is a lookup, not an
 * assertion that everything exists.
 *
 * Why this exists: on Windows a git spawn costs ~25–30ms, so a read that touches N objects
 * one at a time is N × that before git does any work. Reading the change-map per commit
 * this way made `report` over 41 commits take 123 seconds; batching is what makes the
 * review page open instantly.
 *
 * Scope limit, deliberate: git's batch protocol frames each object by BYTE length, and
 * this parser re-encodes the decoded stdout to find those boundaries — correct for UTF-8
 * text objects (our JSON change-map shards, ledger notes, commit messages), which is all
 * we use it for. Do not reach for it to read arbitrary binary blobs; use {@link catFile}.
 */
export async function catFileBatch(
  shas: readonly string[],
  opts?: RunGitOptions,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) {
    return out;
  }

  const result = await runGit(["cat-file", "--batch"], {
    ...opts,
    input: `${wanted.join("\n")}\n`,
    stripFinalNewline: false,
  });
  const buffer = Buffer.from(result.stdout, "utf8");

  let position = 0;
  let index = 0;
  while (position < buffer.length && index < wanted.length) {
    const newline = buffer.indexOf(0x0a, position);
    if (newline === -1) {
      break;
    }
    const header = buffer.toString("utf8", position, newline);
    position = newline + 1;

    // `<sha> SP <type> SP <size>` for a hit; `<name> SP missing` for a miss.
    const parts = header.split(" ");
    const requested = wanted[index]!;
    index += 1;
    if (parts.length < 3 || parts[1] === "missing") {
      out.set(requested, null);
      continue;
    }
    const size = Number.parseInt(parts[2]!, 10);
    if (!Number.isFinite(size)) {
      out.set(requested, null);
      continue;
    }
    out.set(requested, buffer.toString("utf8", position, position + size));
    position += size + 1; // git terminates each object's contents with a newline
  }

  // Anything git never answered for is reported absent rather than silently dropped.
  for (const sha of wanted) {
    if (!out.has(sha)) {
      out.set(sha, null);
    }
  }
  return out;
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

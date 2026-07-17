// The change-map storage layer — ARCHITECTURE.md §8.1, DATA_MODEL.md §4.
//
// The map lives entirely inside git: `refs/git-for-ai/change-map` points at a commit whose
// tree holds one JSON shard file per change-id, sharded by the first 2 hex chars of the id
// (`9f/2c...17.json`) so concurrent edits to different changes never touch the same file.
// Everything here is built from Milestone 2's plumbing primitives (hash-object / mktree /
// commit-tree / update-ref / ls-tree) — no working-tree checkout is ever involved.

import {
  changeMapEntrySchema,
  type ChangeMapEntry,
  type ChangeId,
} from "@git-for-ai/schemas";

import {
  runGit,
  lsTree,
  catFile,
  hashObject,
  mktree,
  commitTree,
  updateRef,
  type MktreeEntry,
} from "../git/index.js";

/** The dedicated ref the change-map lives under (ARCHITECTURE.md §8.1). */
export const CHANGE_MAP_REF = "refs/git-for-ai/change-map";

/**
 * The subset of git-invocation options identity operations thread through to the git layer.
 * Deliberately narrower than RunGitOptions: `input`/`allowFailure`/`stripFinalNewline` are
 * per-call concerns owned by the functions here, not by callers.
 */
export interface GitContext {
  /** Repository to operate on. Defaults to the current process cwd. */
  cwd?: string;
  /** Extra environment variables for the underlying git subprocesses. */
  env?: Record<string, string>;
}

const ZERO_SHA = "0".repeat(40);

/** In-tree shard path for a change-id: `9f/2c1a...0617.json` (DATA_MODEL.md §4.1). */
export function shardPathFor(changeId: ChangeId): string {
  return `${changeId.slice(0, 2)}/${changeId.slice(2)}.json`;
}

/** Resolve the change-map ref to its current commit SHA, or null if the ref doesn't exist yet. */
export async function readChangeMapCommit(ctx: GitContext = {}): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", CHANGE_MAP_REF], {
    ...ctx,
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

/**
 * Read one change-map entry by change-id, or null if the map (or that shard) doesn't exist.
 * The entry is validated against the schema on the way in — a corrupt or
 * unknown-major-version shard fails loud rather than being silently mis-read
 * (DATA_MODEL.md §6).
 */
export async function readChangeMapEntry(
  changeId: ChangeId,
  ctx: GitContext = {},
): Promise<ChangeMapEntry | null> {
  const mapCommit = await readChangeMapCommit(ctx);
  if (mapCommit === null) {
    return null;
  }
  const result = await runGit(["cat-file", "-p", `${mapCommit}:${shardPathFor(changeId)}`], {
    ...ctx,
    allowFailure: true,
    stripFinalNewline: false,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return changeMapEntrySchema.parse(JSON.parse(result.stdout));
}

/** Read every entry in the change-map. Empty array if the ref doesn't exist yet. */
export async function readAllChangeMapEntries(ctx: GitContext = {}): Promise<ChangeMapEntry[]> {
  const mapCommit = await readChangeMapCommit(ctx);
  if (mapCommit === null) {
    return [];
  }
  const treeEntries = await lsTree(mapCommit, { ...ctx, recursive: true });
  const entries: ChangeMapEntry[] = [];
  for (const treeEntry of treeEntries) {
    if (treeEntry.type !== "blob" || !treeEntry.path.endsWith(".json")) {
      continue;
    }
    const body = await catFile(treeEntry.sha, ctx);
    entries.push(changeMapEntrySchema.parse(JSON.parse(body)));
  }
  return entries;
}

/**
 * Find the change-map entry that maps a commit SHA — matching against `head` or any
 * member of `history` (the §7.3 flowchart's first question). Null when unmapped.
 */
export async function findEntryByCommitSha(
  sha: string,
  ctx: GitContext = {},
): Promise<ChangeMapEntry | null> {
  const entries = await readAllChangeMapEntries(ctx);
  for (const entry of entries) {
    if (entry.head === sha || entry.history.includes(sha)) {
      return entry;
    }
  }
  return null;
}

export interface UpsertChangeMapOptions extends GitContext {
  /** Commit message for the change-map ref commit. */
  message?: string;
}

// Git tree entries sort byte-wise with directories compared as `name + "/"`.
function treeSortKey(entry: MktreeEntry): string {
  return entry.type === "tree" ? `${entry.path}/` : entry.path;
}

function byTreeOrder(a: MktreeEntry, b: MktreeEntry): number {
  return treeSortKey(a) < treeSortKey(b) ? -1 : 1;
}

/**
 * Upsert one or more entries into the change-map in a single new commit on
 * `refs/git-for-ai/change-map`, preserving every other shard untouched. The ref update is
 * a compare-and-swap against the commit that was read, so a concurrent writer produces a
 * visible error instead of silently losing an update.
 *
 * Returns the new change-map commit SHA.
 */
export async function upsertChangeMapEntries(
  entries: ChangeMapEntry[],
  opts: UpsertChangeMapOptions = {},
): Promise<string> {
  const { message = "git-for-ai: update change-map", ...ctx } = opts;
  const parent = await readChangeMapCommit(ctx);
  if (entries.length === 0 && parent !== null) {
    return parent;
  }

  // Current shard files (path -> blob sha), then overlay the upserted entries.
  const files = new Map<string, string>();
  if (parent !== null) {
    for (const treeEntry of await lsTree(parent, { ...ctx, recursive: true })) {
      if (treeEntry.type === "blob") {
        files.set(treeEntry.path, treeEntry.sha);
      }
    }
  }
  for (const entry of entries) {
    const validated = changeMapEntrySchema.parse(entry);
    const body = `${JSON.stringify(validated, null, 2)}\n`;
    const blobSha = await hashObject(body, { ...ctx, write: true });
    files.set(shardPathFor(validated.change_id), blobSha);
  }

  // Rebuild the (exactly-one-level-deep) sharded tree: `aa/` subtrees, then the root.
  const byDir = new Map<string, MktreeEntry[]>();
  const rootEntries: MktreeEntry[] = [];
  for (const [path, sha] of files) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      rootEntries.push({ mode: "100644", type: "blob", sha, path });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ mode: "100644", type: "blob", sha, path: rest });
      byDir.set(dir, list);
    }
  }
  for (const [dir, blobs] of byDir) {
    blobs.sort(byTreeOrder);
    const subtreeSha = await mktree(blobs, ctx);
    rootEntries.push({ mode: "040000", type: "tree", sha: subtreeSha, path: dir });
  }
  rootEntries.sort(byTreeOrder);

  const rootTreeSha = await mktree(rootEntries, ctx);
  const newCommit = await commitTree(rootTreeSha, {
    ...ctx,
    parents: parent === null ? [] : [parent],
    message,
  });
  await updateRef(CHANGE_MAP_REF, newCommit, { ...ctx, oldSha: parent ?? ZERO_SHA });
  return newCommit;
}

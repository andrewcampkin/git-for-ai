// The change-map storage layer — ARCHITECTURE.md §8.1, DATA_MODEL.md §4.
//
// The map lives entirely inside git: `refs/git-for-ai/change-map` points at a commit whose
// tree holds one JSON shard file per change-id, sharded by the first 2 hex chars of the id
// (`9f/2c...17.json`) so concurrent edits to different changes never touch the same file.
// Everything here is built from the git access layer's plumbing primitives (hash-object / mktree /
// commit-tree / update-ref / ls-tree) — no working-tree checkout is ever involved.

import {
  changeMapEntrySchema,
  type ChangeMapEntry,
  type ChangeId,
} from "@git-for-ai/schemas";

import {
  runGit,
  lsTree,
  catFileBatch,
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

/**
 * Read every entry in the change-map. Empty array if the ref doesn't exist yet.
 *
 * All shards are fetched in ONE `cat-file --batch` (see catFileBatch's header): a repo with
 * N changes used to cost N git spawns here, and this function is called on every identity
 * lookup, which is how a whole-history read turned quadratic.
 */
export async function readAllChangeMapEntries(ctx: GitContext = {}): Promise<ChangeMapEntry[]> {
  const mapCommit = await readChangeMapCommit(ctx);
  if (mapCommit === null) {
    return [];
  }
  const treeEntries = await lsTree(mapCommit, { ...ctx, recursive: true });
  const shardShas = treeEntries
    .filter((treeEntry) => treeEntry.type === "blob" && treeEntry.path.endsWith(".json"))
    .map((treeEntry) => treeEntry.sha);
  const bodies = await catFileBatch(shardShas, ctx);

  const entries: ChangeMapEntry[] = [];
  for (const sha of shardShas) {
    const body = bodies.get(sha);
    if (body === null || body === undefined) {
      // A shard listed in the tree that git cannot produce is real corruption; the old
      // per-object read threw here, and so does this one.
      throw new Error(`change-map shard ${sha} is listed in the tree but unreadable`);
    }
    entries.push(changeMapEntrySchema.parse(JSON.parse(body)));
  }
  return entries;
}

/**
 * A consistent, in-memory view of the whole change-map, read once.
 *
 * Read commands (`log`, `report`, the review server) resolve identity for every commit they
 * touch. Doing that through {@link findEntryByCommitSha} re-reads the entire map per commit;
 * a snapshot answers the same questions from memory, turning a quadratic pile of git spawns
 * into two. It is a READ-ONLY view and, deliberately, a point-in-time one: a caller that
 * writes (healing, folding) must take a fresh snapshot afterwards.
 */
export interface ChangeMapSnapshot {
  /** Every entry, in tree order. */
  readonly entries: readonly ChangeMapEntry[];
  /** The entry whose `head` or `history` contains this commit sha — the R1 question. */
  entryForCommit(sha: string): ChangeMapEntry | null;
  /** The entry for a change-id, or null when the map has never seen it. */
  entryForChangeId(changeId: ChangeId): ChangeMapEntry | null;
  /** Follow `folded_into` redirects to the surviving entry (cycle- and dangling-safe). */
  surviving(entry: ChangeMapEntry): ChangeMapEntry;
}

/** Read the whole change-map into a queryable snapshot (two git invocations, total). */
export async function readChangeMapSnapshot(ctx: GitContext = {}): Promise<ChangeMapSnapshot> {
  const entries = await readAllChangeMapEntries(ctx);

  const byChangeId = new Map<string, ChangeMapEntry>();
  const byCommit = new Map<string, ChangeMapEntry>();
  for (const entry of entries) {
    byChangeId.set(entry.change_id, entry);
    // First writer wins, matching findEntryByCommitSha's "first match in tree order".
    for (const sha of [entry.head, ...entry.history]) {
      if (!byCommit.has(sha)) {
        byCommit.set(sha, entry);
      }
    }
  }

  const surviving = (entry: ChangeMapEntry): ChangeMapEntry => {
    let current = entry;
    const seen = new Set<string>([entry.change_id]);
    while (current.folded_into !== undefined) {
      if (seen.has(current.folded_into)) {
        break;
      }
      const next = byChangeId.get(current.folded_into);
      if (next === undefined) {
        break;
      }
      seen.add(next.change_id);
      current = next;
    }
    return current;
  };

  return {
    entries,
    entryForCommit: (sha) => byCommit.get(sha) ?? null,
    entryForChangeId: (changeId) => byChangeId.get(changeId) ?? null,
    surviving,
  };
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

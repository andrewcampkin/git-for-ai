// The session-trace store — ARCHITECTURE.md §8.1, DATA_MODEL.md §3.
//
// Session records live entirely inside git, following the same pattern as the identity
// change-map (../identity/changeMap.ts): one ref (`refs/git-for-ai/sessions`) pointing
// at a commit whose tree holds one blob per record, sharded by the first byte of the
// record's content hash (`1f/4e9c...899.json`). A ref-pointing-at-a-tree-of-blobs keeps
// the ref namespace small and lets git pack the blobs efficiently (git-annex's
// "bookkeeping in a ref, content-addressed payload" pattern).
//
// Content addressing (DATA_MODEL.md §3.1): the `session_ref` is `sha256:` + the hex
// sha256 of the record's CANONICAL serialization — UTF-8 JSON, keys sorted at every
// level, no insignificant whitespace, arrays in meaningful order. The stored blob is
// exactly those canonical bytes, so a reader can always recompute and verify the hash.
// The hash is computed AFTER redaction, over exactly what is stored. Identical content
// produces the identical hash/path/blob, so writes are idempotent by construction and
// sync can never conflict.

import { createHash } from "node:crypto";

import { sessionRecordSchema, type SessionRecord } from "@git-for-ai/schemas";

import {
  runGit,
  lsTree,
  hashObject,
  mktree,
  commitTree,
  updateRef,
  type MktreeEntry,
} from "../git/index.js";
import type { GitContext } from "../identity/changeMap.js";
import { canonicalJsonStringify } from "../ledger/effective.js";

/** The dedicated ref the session store lives under (ARCHITECTURE.md §8.1). */
export const SESSIONS_REF = "refs/git-for-ai/sessions";

const ZERO_SHA = "0".repeat(40);

/** In-tree shard path for a content hash: `1f/4e9c...99.json` (sharded by first byte). */
export function sessionShardPath(contentHash: string): string {
  return `${contentHash.slice(0, 2)}/${contentHash.slice(2)}.json`;
}

/**
 * Canonicalize a session record and compute its content address.
 * Returns both the `sha256:<hash>` ref form and the exact bytes to store.
 */
export function contentAddressSessionRecord(record: SessionRecord): {
  sessionRef: string;
  contentHash: string;
  canonicalBody: string;
} {
  const canonicalBody = canonicalJsonStringify(record);
  const contentHash = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  return { sessionRef: `sha256:${contentHash}`, contentHash, canonicalBody };
}

/** Resolve the sessions ref to its current commit SHA, or null if it doesn't exist yet. */
export async function readSessionsCommit(ctx: GitContext = {}): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", SESSIONS_REF], {
    ...ctx,
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

export interface WriteSessionRecordResult {
  /** `sha256:<hash>` — the value stored in a ledger entry's `session_ref`. */
  sessionRef: string;
  /** Hex sha256 content hash (the ref form without the prefix). */
  contentHash: string;
  /** Git blob SHA of the stored canonical bytes. */
  blobSha: string;
  /** False when an identical record was already stored (idempotent no-op). */
  created: boolean;
}

// Git tree entries sort byte-wise with directories compared as `name + "/"`.
function treeSortKey(entry: MktreeEntry): string {
  return entry.type === "tree" ? `${entry.path}/` : entry.path;
}

function byTreeOrder(a: MktreeEntry, b: MktreeEntry): number {
  return treeSortKey(a) < treeSortKey(b) ? -1 : 1;
}

/** Rebuild the one-level-sharded tree from a flat `path -> blobSha` map. */
async function buildShardedTree(files: Map<string, string>, ctx: GitContext): Promise<string> {
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
  return mktree(rootEntries, ctx);
}

/**
 * Write a (already-redacted) session record into the sessions ref as a content-addressed
 * blob. The record is validated against `sessionRecordSchema` before anything is written.
 * Idempotent: writing a record whose canonical content is already stored is a no-op that
 * returns the same `sessionRef` with `created: false`. The ref update is a
 * compare-and-swap against the commit that was read, so a concurrent writer produces a
 * visible error rather than a silently lost record.
 */
export async function writeSessionRecord(
  record: SessionRecord,
  ctx: GitContext = {},
): Promise<WriteSessionRecordResult> {
  const validated = sessionRecordSchema.parse(record);
  const { sessionRef, contentHash, canonicalBody } = contentAddressSessionRecord(validated);
  const shardPath = sessionShardPath(contentHash);

  const parent = await readSessionsCommit(ctx);

  // Current stored blobs (path -> blob sha).
  const files = new Map<string, string>();
  if (parent !== null) {
    for (const treeEntry of await lsTree(parent, { ...ctx, recursive: true })) {
      if (treeEntry.type === "blob") {
        files.set(treeEntry.path, treeEntry.sha);
      }
    }
  }

  if (files.has(shardPath)) {
    // Content-addressed: identical hash = identical content. Nothing to do.
    const blobSha = files.get(shardPath)!;
    return { sessionRef, contentHash, blobSha, created: false };
  }

  const blobSha = await hashObject(canonicalBody, { ...ctx, write: true });
  files.set(shardPath, blobSha);

  const rootTreeSha = await buildShardedTree(files, ctx);
  const newCommit = await commitTree(rootTreeSha, {
    ...ctx,
    parents: parent === null ? [] : [parent],
    message: `git-for-ai: store session ${contentHash.slice(0, 12)}`,
  });
  await updateRef(SESSIONS_REF, newCommit, { ...ctx, oldSha: parent ?? ZERO_SHA });

  return { sessionRef, contentHash, blobSha, created: true };
}

/**
 * Read a session record back by its `sha256:<hash>` ref. Returns null when the sessions
 * ref doesn't exist or holds no blob for that hash. A stored blob that no longer parses
 * as a valid session record fails loud (schema error) rather than being mis-read
 * (DATA_MODEL.md §6).
 */
export async function readSessionRecord(
  sessionRef: string,
  ctx: GitContext = {},
): Promise<SessionRecord | null> {
  const match = /^sha256:([0-9a-f]{64})$/.exec(sessionRef);
  if (match === null) {
    throw new Error(`invalid session ref (expected sha256:<64 hex>): ${sessionRef}`);
  }
  const contentHash = match[1]!;

  const commit = await readSessionsCommit(ctx);
  if (commit === null) {
    return null;
  }

  const result = await runGit(["cat-file", "-p", `${commit}:${sessionShardPath(contentHash)}`], {
    ...ctx,
    allowFailure: true,
    stripFinalNewline: false,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return sessionRecordSchema.parse(JSON.parse(result.stdout));
}

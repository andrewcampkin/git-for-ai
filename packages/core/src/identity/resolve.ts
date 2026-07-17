// resolveChangeId — the full §7.3 resolution algorithm (commit SHA -> change-id),
// every branch of the flowchart, ordered by descending authority:
//
//   R1: SHA already in the change-map (head or history)  -> authoritative, return it.
//   R2: Change-Id trailer whose id IS known to the map    -> adopt the SHA into that
//       change's history (self-heal), return it.
//   R3: Change-Id trailer whose id is NOT known           -> register a new row from the
//       trailer, origin=trailer-recovery, return it.
//   R4: no trailer, exactly one parent with a known
//       change-id AND tree-similarity over threshold      -> infer continuation,
//       origin=inferred, low confidence.
//   R5: nothing                                           -> mint fresh, origin=orphan-recovery,
//       surfaced by doctor as unlinked.
//
// R2/R3 are the lazy-healing mitigation for the operations post-rewrite never observes
// (cherry-pick, filter-branch/filter-repo — §7.5): recovery is triggered by ANY read, and
// the recovered mapping is written back so the next lookup hits the authoritative fast
// path (R1).

import type { ChangeId, ChangeMapEntry } from "@git-for-ai/schemas";

import { runGit, readCommitMessage, lsTree } from "../git/index.js";
import { mintChangeId, parseChangeIdTrailer } from "./changeId.js";
import {
  findEntryByCommitSha,
  readChangeMapEntry,
  upsertChangeMapEntries,
  type GitContext,
} from "./changeMap.js";

/** Which branch of the §7.3 flowchart produced the answer. */
export type ResolutionBranch = "R1" | "R2" | "R3" | "R4" | "R5";

/**
 * Default tree-similarity threshold for the R4 inferred-continuation branch. §7.3 requires
 * "tree-similarity over threshold" without fixing a value; 0.7 (at least 70% of the union
 * of both trees' paths carry identical blobs) is this implementation's default, overridable
 * per call.
 */
export const DEFAULT_INFER_SIMILARITY_THRESHOLD = 0.7;

export interface ResolveChangeIdOptions extends GitContext {
  /** Override the R4 tree-similarity threshold (0..1). */
  inferSimilarityThreshold?: number;
}

export interface ResolveChangeIdResult {
  /**
   * The resolved change-id. When the directly-mapped change was absorbed by a squash,
   * this is the SURVIVING change-id after following `folded_into` redirects (§7.4:
   * "queries for an absorbed change-id transparently redirect").
   */
  changeId: ChangeId;
  branch: ResolutionBranch;
  /** The change-map entry `changeId` refers to (post-redirect). */
  entry: ChangeMapEntry;
  /** When a `folded_into` redirect happened: the absorbed change-id the SHA mapped to directly. */
  absorbedChangeId?: ChangeId;
  /** True for the inferred (R4) and orphan (R5) branches — surfaced by doctor. */
  lowConfidence?: boolean;
}

/** Follow `folded_into` redirects to the surviving entry (cycle- and dangling-safe). */
async function followFolds(entry: ChangeMapEntry, ctx: GitContext): Promise<ChangeMapEntry> {
  let current = entry;
  const seen = new Set<ChangeId>([entry.change_id]);
  while (current.folded_into !== undefined) {
    if (seen.has(current.folded_into)) {
      break;
    }
    const next = await readChangeMapEntry(current.folded_into, ctx);
    if (next === null) {
      break;
    }
    seen.add(next.change_id);
    current = next;
  }
  return current;
}

async function listParents(sha: string, ctx: GitContext): Promise<string[]> {
  const result = await runGit(["log", "-1", "--format=%P", sha], ctx);
  return result.stdout.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Fraction of the union of both commits' tree paths that carry an identical blob in both
 * (1 = identical trees, 0 = nothing shared). Used only by the R4 inference branch.
 */
async function treeSimilarity(shaA: string, shaB: string, ctx: GitContext): Promise<number> {
  const [entriesA, entriesB] = await Promise.all([
    lsTree(shaA, { ...ctx, recursive: true }),
    lsTree(shaB, { ...ctx, recursive: true }),
  ]);
  const blobsA = new Map(entriesA.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const blobsB = new Map(entriesB.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const allPaths = new Set([...blobsA.keys(), ...blobsB.keys()]);
  if (allPaths.size === 0) {
    return 1;
  }
  let identical = 0;
  for (const path of allPaths) {
    const a = blobsA.get(path);
    if (a !== undefined && a === blobsB.get(path)) {
      identical += 1;
    }
  }
  return identical / allPaths.size;
}

/**
 * Resolve a commit SHA to its stable change-id (ARCHITECTURE.md §7.3). Every branch that
 * recovers identity from outside the map (R2–R5) writes the result back into the map, so
 * the next lookup for the same SHA hits the authoritative R1 fast path — this is the
 * self-healing property that repairs cherry-picks the hooks never saw (§7.5).
 */
export async function resolveChangeId(
  sha: string,
  opts: ResolveChangeIdOptions = {},
): Promise<ResolveChangeIdResult> {
  const { inferSimilarityThreshold = DEFAULT_INFER_SIMILARITY_THRESHOLD, ...ctx } = opts;
  const now = new Date().toISOString();

  // R1 — the change-map is authoritative.
  const mapped = await findEntryByCommitSha(sha, ctx);
  if (mapped !== null) {
    const surviving = await followFolds(mapped, ctx);
    return {
      changeId: surviving.change_id,
      branch: "R1",
      entry: surviving,
      ...(surviving.change_id === mapped.change_id
        ? {}
        : { absorbedChangeId: mapped.change_id }),
    };
  }

  // Not in the map — consult the portable fallback: the Change-Id trailer.
  const message = await readCommitMessage(sha, ctx);
  const trailerChangeId = parseChangeIdTrailer(message);

  if (trailerChangeId !== null) {
    const known = await readChangeMapEntry(trailerChangeId, ctx);

    if (known !== null) {
      // R2 — adopt the SHA into the known change's history; heal the map. `head` is left
      // as-is: the flowchart specifies adoption into history, and a cherry-picked copy on
      // another branch is not necessarily the change's current head.
      const healed: ChangeMapEntry = {
        ...known,
        history: known.history.includes(sha) ? known.history : [...known.history, sha],
        trailer_seen: true,
        updated_at: now,
      };
      await upsertChangeMapEntries([healed], {
        ...ctx,
        message: `git-for-ai: heal ${trailerChangeId} += ${sha} (trailer recovery)`,
      });
      const surviving = await followFolds(healed, ctx);
      return {
        changeId: surviving.change_id,
        branch: "R2",
        entry: surviving,
        ...(surviving.change_id === healed.change_id
          ? {}
          : { absorbedChangeId: healed.change_id }),
      };
    }

    // R3 — trailer names a change the map has never seen (e.g. cherry-pick into a repo
    // whose map was never synced): register it, origin=trailer-recovery.
    const registered: ChangeMapEntry = {
      schema: "git-for-ai/change-map-entry@1",
      change_id: trailerChangeId,
      head: sha,
      history: [sha],
      trailer_seen: true,
      origin: "trailer-recovery",
      updated_at: now,
    };
    await upsertChangeMapEntries([registered], {
      ...ctx,
      message: `git-for-ai: register ${trailerChangeId} -> ${sha} (trailer recovery)`,
    });
    return { changeId: trailerChangeId, branch: "R3", entry: registered };
  }

  // No trailer. R4 — exactly one parent with a known change-id AND high tree similarity:
  // infer continuation, low confidence.
  const parents = await listParents(sha, ctx);
  if (parents.length === 1) {
    const parentSha = parents[0];
    if (parentSha !== undefined) {
      const parentEntry = await findEntryByCommitSha(parentSha, ctx);
      if (parentEntry !== null) {
        const target = await followFolds(parentEntry, ctx);
        const similarity = await treeSimilarity(sha, parentSha, ctx);
        if (similarity >= inferSimilarityThreshold) {
          const inferred: ChangeMapEntry = {
            ...target,
            head: sha,
            history: target.history.includes(sha) ? target.history : [...target.history, sha],
            origin: "inferred",
            updated_at: now,
          };
          await upsertChangeMapEntries([inferred], {
            ...ctx,
            message: `git-for-ai: infer ${target.change_id} continues at ${sha}`,
          });
          return {
            changeId: target.change_id,
            branch: "R4",
            entry: inferred,
            lowConfidence: true,
          };
        }
      }
    }
  }

  // R5 — nothing to recover from: mint fresh, origin=orphan-recovery (doctor surfaces
  // these as unlinked).
  const orphanChangeId = mintChangeId();
  const orphan: ChangeMapEntry = {
    schema: "git-for-ai/change-map-entry@1",
    change_id: orphanChangeId,
    head: sha,
    history: [sha],
    trailer_seen: false,
    origin: "orphan-recovery",
    updated_at: now,
  };
  await upsertChangeMapEntries([orphan], {
    ...ctx,
    message: `git-for-ai: mint ${orphanChangeId} -> ${sha} (orphan recovery)`,
  });
  return { changeId: orphanChangeId, branch: "R5", entry: orphan, lowConfidence: true };
}

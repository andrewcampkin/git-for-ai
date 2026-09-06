// resolveChangeId — the full §7.3 resolution algorithm (commit SHA -> change-id),
// every branch of the flowchart, ordered by descending authority:
//
//   R1: SHA already in the change-map (head or history)  -> authoritative, return it.
//   R2: Change-Id trailer whose id IS known to the map    -> adopt the SHA into that
//       change's history (self-heal), return it.
//   R3: Change-Id trailer whose id is NOT known           -> register a new row from the
//       trailer, origin=trailer-recovery, return it.
//   R4: no trailer, and a SIBLING change-head (same sole
//       parent) whose changed-path set overlaps ours       -> infer a missed rewrite,
//       over threshold                                        origin=inferred, low confidence.
//   R5: nothing                                            -> mint fresh, origin=orphan-recovery,
//       surfaced by doctor as unlinked.
//
// R2/R3 are the lazy-healing mitigation for the operations post-rewrite never observes
// (cherry-pick, filter-branch/filter-repo — §7.5): recovery is triggered by ANY read, and
// the recovered mapping is written back so the next lookup hits the authoritative fast
// path (R1).
//
// ── Why R4 compares SIBLINGS, not parent and child ──
// The original implementation followed §7.3's flowchart literally: "exactly one parent
// with a known change-id AND tree-similarity over threshold → infer continuation". That
// signal is wrong on both axes, proven by live dogfood data (two unrelated commits glued
// into one change):
//   - Whole-TREE similarity is ~1 for ANY small commit in a non-tiny repo — the tree is
//     mostly untouched files — so the threshold gated nothing.
//   - A CHILD commit is virtually never the same logical change as its parent: rewrites
//     (amend/reword/rebase) produce SIBLINGS — a new commit sharing the original's parent
//     — not children. Stacked children are new work, not continuations.
// So R4 now models the actual missed-rewrite shape: the commit has one parent P, some
// change's head is ALSO a child of P (a sibling), and the two commits' changed-path sets
// (each diffed against P) overlap above threshold (Jaccard). That is what an amend or a
// same-base rebase the hooks never saw looks like — and what a genuinely new commit that
// merely follows its parent does not.

import type { ChangeId, ChangeMapEntry } from "@git-for-ai/schemas";

import { runGit, readCommitMessage } from "../git/index.js";
import { mintChangeId, parseChangeIdTrailer } from "./changeId.js";
import {
  findEntryByCommitSha,
  readAllChangeMapEntries,
  readChangeMapEntry,
  upsertChangeMapEntries,
  type GitContext,
} from "./changeMap.js";

/** Which branch of the §7.3 flowchart produced the answer. */
export type ResolutionBranch = "R1" | "R2" | "R3" | "R4" | "R5";

/**
 * Default changed-path overlap (Jaccard) threshold for the R4 missed-rewrite inference:
 * |paths(S)∩paths(H)| / |paths(S)∪paths(H)|, each commit diffed against the shared
 * parent. 0.6 admits the common "amend touched the same files plus one more" shape
 * (2-same-of-3 = 0.67 passes) while rejecting sibling commits that share less than a
 * majority of their footprint. Overridable per call.
 */
export const DEFAULT_INFER_SIMILARITY_THRESHOLD = 0.6;

export interface ResolveChangeIdOptions extends GitContext {
  /** Override the R4 changed-path overlap threshold (0..1). */
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

/** The set of paths a commit changed relative to a given base (its parent, for R4). */
async function changedPaths(sha: string, base: string, ctx: GitContext): Promise<Set<string>> {
  const result = await runGit(
    ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", base, sha],
    ctx,
  );
  return new Set(result.stdout.split("\0").filter((p) => p.length > 0));
}

/** Jaccard overlap of two path sets (1 = identical footprint, 0 = disjoint). */
function pathOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1; // two empty commits on the same parent — treat as the same (empty) rewrite
  }
  let intersection = 0;
  for (const path of a) {
    if (b.has(path)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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

  // No trailer. R4 — missed-rewrite inference (see the header note on why this compares
  // SIBLINGS): some change's head is also a sole child of our parent, and its changed-path
  // footprint (vs that shared parent) overlaps ours above threshold.
  const parents = await listParents(sha, ctx);
  const parentSha = parents.length === 1 ? parents[0] : undefined;
  if (parentSha !== undefined) {
    const ourPaths = await changedPaths(sha, parentSha, ctx);

    let best: { entry: ChangeMapEntry; overlap: number } | null = null;
    for (const candidate of await readAllChangeMapEntries(ctx)) {
      // A folded entry's head is stale — its surviving change is a separate candidate.
      if (candidate.folded_into !== undefined || candidate.head === sha) {
        continue;
      }
      // Sibling test: the candidate change's head must have exactly our parent. Heads
      // that no longer exist in this repo (synced map, pruned objects) just don't match.
      const headParents = await runGit(["log", "-1", "--format=%P", candidate.head], {
        ...ctx,
        allowFailure: true,
      });
      if (headParents.exitCode !== 0) {
        continue;
      }
      const siblingParents = headParents.stdout.split(/\s+/).filter((s) => s.length > 0);
      if (siblingParents.length !== 1 || siblingParents[0] !== parentSha) {
        continue;
      }
      const overlap = pathOverlap(ourPaths, await changedPaths(candidate.head, parentSha, ctx));
      if (overlap >= inferSimilarityThreshold && (best === null || overlap > best.overlap)) {
        best = { entry: candidate, overlap };
      }
    }

    if (best !== null) {
      const target = await followFolds(best.entry, ctx);
      const inferred: ChangeMapEntry = {
        ...target,
        head: sha,
        history: target.history.includes(sha) ? target.history : [...target.history, sha],
        origin: "inferred",
        updated_at: now,
      };
      await upsertChangeMapEntries([inferred], {
        ...ctx,
        message: `git-for-ai: infer ${target.change_id} rewritten as ${sha} (sibling overlap ${best.overlap.toFixed(2)})`,
      });
      return {
        changeId: target.change_id,
        branch: "R4",
        entry: inferred,
        lowConfidence: true,
      };
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

// onPostRewrite — the rewrite-folding logic from ARCHITECTURE.md §7.4.
//
// `post-rewrite` fires on amend and every form of rebase, receiving `<old-sha> <new-sha>`
// pairs on stdin. Grouping the pairs by new SHA distinguishes the two shapes we handle:
//
//   1 old -> 1 new  (amend / reword / plain rebase): rekey — head becomes the new SHA, the
//                    old SHA stays in history, the intent note is copied old -> new.
//   N old -> 1 new  (squash / fixup): fold — the FIRST old change-id survives (the squash
//                    target, matching git's own semantics), absorbing the others; absorbed
//                    entries get `folded_into` so their ledger entries remain reachable.
//
// The actual folding of ledger ENTRIES is Milestone 4's job — this module's responsibility
// is the change-map's head/history/absorbed/folded_into bookkeeping (plus the plain
// `git notes copy` for the surviving note, which §7.4 assigns to the rewrite transition).
//
// Split (1 old -> N new) never reaches here as a fan-out: git emits multiple post-commits
// instead, so the first new commit rekeys and later ones are fresh assignments (§7.4).

import type { ChangeId, ChangeMapEntry } from "@git-for-ai/schemas";

import { runGit } from "../git/index.js";
import {
  readAllChangeMapEntries,
  upsertChangeMapEntries,
  type GitContext,
} from "./changeMap.js";

/** The ledger notes ref (ARCHITECTURE.md §8.1) — the note copied on a 1->1 rekey. */
export const INTENT_NOTES_REF = "refs/notes/git-for-ai/intent";

/** One `<old-sha> <new-sha>` line of post-rewrite's stdin. */
export interface RewritePair {
  oldSha: string;
  newSha: string;
}

/**
 * Parse the exact stdin format git feeds a post-rewrite hook: one
 * `<old-sha> SP <new-sha> [ SP <extra-info> ] LF` line per rewritten commit.
 */
export function parsePostRewriteInput(input: string): RewritePair[] {
  const pairs: RewritePair[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const oldSha = tokens[0];
    const newSha = tokens[1];
    if (oldSha === undefined || newSha === undefined) {
      throw new Error(`unparseable post-rewrite line: ${JSON.stringify(rawLine)}`);
    }
    pairs.push({ oldSha, newSha });
  }
  return pairs;
}

export interface PostRewriteResult {
  /** 1 old -> 1 new rekeys performed. */
  rekeyed: Array<{ changeId: ChangeId; oldSha: string; newSha: string }>;
  /** N old -> 1 new folds performed. */
  folded: Array<{ survivorChangeId: ChangeId; absorbedChangeIds: ChangeId[]; newSha: string }>;
  /**
   * Old SHAs the change-map had never seen (e.g. hooks installed mid-history). These are
   * left for the resolver's lazy-healing path rather than guessed at here.
   */
  unknownOldShas: string[];
}

/**
 * Apply a post-rewrite transition to the change-map (ARCHITECTURE.md §7.4). All entry
 * updates from one hook invocation are written as a single change-map commit.
 */
export async function onPostRewrite(
  pairs: RewritePair[],
  ctx: GitContext = {},
): Promise<PostRewriteResult> {
  const result: PostRewriteResult = { rekeyed: [], folded: [], unknownOldShas: [] };
  if (pairs.length === 0) {
    return result;
  }

  // Index the current map by every SHA it knows (head + history members).
  const allEntries = await readAllChangeMapEntries(ctx);
  const entryBySha = new Map<string, ChangeMapEntry>();
  const indexEntry = (entry: ChangeMapEntry): void => {
    entryBySha.set(entry.head, entry);
    for (const sha of entry.history) {
      entryBySha.set(sha, entry);
    }
  };
  for (const entry of allEntries) {
    indexEntry(entry);
  }

  // Group pairs by new SHA, preserving git's emission order (for a squash, git emits the
  // squash target — the first non-fixup commit — first, which is what makes "first old
  // change-id survives" match git's own squash semantics).
  const groups = new Map<string, string[]>();
  for (const { oldSha, newSha } of pairs) {
    const list = groups.get(newSha) ?? [];
    list.push(oldSha);
    groups.set(newSha, list);
  }

  const staged = new Map<ChangeId, ChangeMapEntry>();
  const stage = (entry: ChangeMapEntry): void => {
    staged.set(entry.change_id, entry);
    indexEntry(entry); // later groups in the same invocation see staged state
  };
  const now = new Date().toISOString();

  for (const [newSha, oldShas] of groups) {
    // Distinct known change entries among this group's old SHAs, in pair order.
    const seenIds = new Set<ChangeId>();
    const known: Array<{ entry: ChangeMapEntry; oldSha: string }> = [];
    for (const oldSha of oldShas) {
      const entry = entryBySha.get(oldSha);
      if (entry === undefined) {
        result.unknownOldShas.push(oldSha);
      } else if (!seenIds.has(entry.change_id)) {
        seenIds.add(entry.change_id);
        known.push({ entry, oldSha });
      }
    }
    if (known.length === 0) {
      continue; // nothing the map knows about — the resolver heals these lazily
    }

    const survivor = known[0];
    if (survivor === undefined) {
      continue; // unreachable given the length check; satisfies noUncheckedIndexedAccess
    }
    const absorbed = known.slice(1);

    const survivorBase = staged.get(survivor.entry.change_id) ?? survivor.entry;
    const updatedSurvivor: ChangeMapEntry = {
      ...survivorBase,
      head: newSha,
      history: survivorBase.history.includes(newSha)
        ? survivorBase.history
        : [...survivorBase.history, newSha],
      origin: "post-rewrite",
      updated_at: now,
    };
    if (absorbed.length > 0) {
      updatedSurvivor.absorbed = [
        ...new Set([
          ...(survivorBase.absorbed ?? []),
          ...absorbed.map(({ entry }) => entry.change_id),
        ]),
      ];
    }
    stage(updatedSurvivor);

    for (const { entry } of absorbed) {
      stage({
        ...(staged.get(entry.change_id) ?? entry),
        folded_into: updatedSurvivor.change_id,
        updated_at: now,
      });
    }

    // Copy the surviving change's intent note from its old commit to the new one
    // (`git notes copy`, respecting the user's notes config — §7.4). allowFailure: the
    // old commit legitimately may have no note yet (capture hasn't run).
    if (survivor.oldSha !== newSha) {
      await runGit(
        ["notes", `--ref=${INTENT_NOTES_REF}`, "copy", "--force", survivor.oldSha, newSha],
        { ...ctx, allowFailure: true },
      );
    }

    if (absorbed.length > 0) {
      result.folded.push({
        survivorChangeId: updatedSurvivor.change_id,
        absorbedChangeIds: absorbed.map(({ entry }) => entry.change_id),
        newSha,
      });
    } else {
      result.rekeyed.push({
        changeId: updatedSurvivor.change_id,
        oldSha: survivor.oldSha,
        newSha,
      });
    }
  }

  if (staged.size > 0) {
    await upsertChangeMapEntries([...staged.values()], {
      ...ctx,
      message: `git-for-ai: post-rewrite transition (${pairs.length} pair${pairs.length === 1 ? "" : "s"})`,
    });
  }

  return result;
}

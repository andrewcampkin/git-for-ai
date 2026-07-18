// Milestone 11 — blame-position resolution: <file>:<line> → commit → change identity →
// ledger entry + session (the data behind ARCHITECTURE.md §9.1's `blame --why` output).
//
// ── Judgment calls ──
// 1. The line→commit step is REAL `git blame` (porcelain, -L one line), not a scan of
//    indexed chunk line ranges: blame must be exact under line drift (the index stores
//    HEAD-blob line numbers, but the question is "which commit introduced this line"),
//    and the project's core premise is behavioral parity with real git. The index is
//    used afterwards, for supplementary context (position-boosted hybrid retrieval in
//    engine.ts) — not for the identity answer.
// 2. Blame runs against the WORKING TREE (no rev argument), matching what a user
//    pointing at an editor line means. A line that is locally modified/uncommitted
//    blames to the zero-SHA → `commit: null` → M12 renders the honest degraded case.
// 3. Identity resolution is read-only (enrich.ts) — blame never mints change-map rows.
// 4. "LATER TOUCHED BY" (§9.1) = other, non-folded changes whose EFFECTIVE ledger entry
//    has a scope item on the same path with a newer created_at than the blamed entry.
//    Path-level (not line-level): recorded scope ranges are pinned to old revisions, so
//    line intersection against today's line numbers would be false precision.

import { runGit } from "../git/index.js";
import { readAllChangeMapEntries, type GitContext } from "../identity/changeMap.js";

import { readChangeLedger } from "./enrich.js";
import type { BlamePosition, RelatedChangeRef } from "./types.js";

const ZERO_SHA_RE = /^0{40}$/;

/**
 * Attribute one line to a commit via `git blame --porcelain -L <line>,<line>`.
 * Returns null commit for an uncommitted line; throws (with git's message) when the
 * path/line cannot be blamed at all — that is caller error, not a degraded case.
 */
export async function blameLineCommit(
  position: BlamePosition,
  ctx: GitContext = {},
): Promise<string | null> {
  const result = await runGit(
    ["blame", "--porcelain", "-L", `${position.line},${position.line}`, "--", position.path],
    { ...ctx, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git blame failed for ${position.path}:${position.line}: ${result.stderr.trim() || "unknown error"}`,
    );
  }
  const firstLine = result.stdout.split("\n", 1)[0] ?? "";
  const sha = firstLine.split(" ", 1)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `unexpected git blame output for ${position.path}:${position.line}: ${firstLine || "(empty)"}`,
    );
  }
  return ZERO_SHA_RE.test(sha) ? null : sha;
}

/**
 * §9.1's "LATER TOUCHED BY": non-folded changes (excluding `excludeChangeId`) whose
 * effective ledger entry touches `path` with `created_at` after `afterCreatedAt`.
 * Oldest first. `afterCreatedAt === null` (no blamed entry) yields [].
 */
export async function findLaterTouches(
  path: string,
  afterCreatedAt: string | null,
  excludeChangeId: string | null,
  ctx: GitContext = {},
  warnings: string[] = [],
): Promise<RelatedChangeRef[]> {
  if (afterCreatedAt === null) {
    return [];
  }
  const related: RelatedChangeRef[] = [];
  for (const mapEntry of await readAllChangeMapEntries(ctx)) {
    if (mapEntry.folded_into !== undefined || mapEntry.change_id === excludeChangeId) {
      continue;
    }
    const { effective } = await readChangeLedger(mapEntry, ctx, warnings);
    if (
      effective !== null &&
      effective.created_at > afterCreatedAt &&
      effective.scope.some((item) => item.path === path)
    ) {
      related.push({
        changeId: effective.change_id,
        createdAt: effective.created_at,
        summary: effective.summary,
      });
    }
  }
  related.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return related;
}

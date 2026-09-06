// `git for-ai reconcile [--rebuild-map] [--limit <N>]` — eager change-map healing
// (CLI_REFERENCE `reconcile`; ARCHITECTURE.md §7.5's mitigation for operations the hooks
// never observe).
//
// Default: walk the last `limit` commits from HEAD; any commit the map doesn't know that
// carries a Change-Id trailer is run through the normal resolver, whose R2/R3 branches
// adopt/register it (identical healing to what a read would eventually do — this just
// does it all at once). Commits WITHOUT a trailer are left alone: reconcile never mints
// identity for them (that's `annotate`'s or doctor's deliberate call).
//
// --rebuild-map: the recovery path when the change-map ref was lost. Walks ALL commits
// (rev-list --all, newest first) and resolves every trailer-carrying commit. Newest-first
// order makes R3 register each change's newest commit as head, with older commits adopted
// into history by R2 — so heads come out right without a second pass. Rich predecessor
// data (folds, absorbed) is not recoverable from trailers, per CLI_REFERENCE's honesty
// note.
//
// --by-content (best-effort re-link of orphaned intent via patch similarity) is specified
// but deliberately NOT implemented — it fails loudly rather than pretending.

import {
  findEntryByCommitSha,
  parseChangeIdTrailer,
  readCommitMessage,
  resolveChangeId,
  runGit,
  type GitContext,
  type ResolutionBranch,
} from "@git-for-ai/core";

export interface ReconcileOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** Rebuild the entire map from trailers (`--rebuild-map`). */
  rebuildMap?: boolean;
  /** Commits to scan in the default mode. Default 200 (the CLI_REFERENCE transcript). */
  limit?: number;
}

export interface ReconcileResult {
  scanned: number;
  /** Commits healed into the map, with the resolver branch that did it. */
  healed: Array<{ sha: string; changeId: string; branch: ResolutionBranch }>;
  /** Trailerless commits the map doesn't know (reported, never touched). */
  unlinked: number;
  output: string;
}

export async function runReconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const ctx: GitContext = options.cwd !== undefined ? { cwd: options.cwd } : {};
  await runGit(["rev-parse", "--git-dir"], ctx);

  const rebuild = options.rebuildMap === true;
  const limit = options.limit ?? 200;

  const revListArgs = rebuild
    ? ["rev-list", "--all"]
    : ["rev-list", `--max-count=${limit}`, "HEAD"];
  const revList = await runGit(revListArgs, { ...ctx, allowFailure: true });
  const shas =
    revList.exitCode === 0 ? revList.stdout.split(/\r?\n/).filter((s) => s.length > 0) : [];

  const healed: ReconcileResult["healed"] = [];
  let unlinked = 0;
  for (const sha of shas) {
    if ((await findEntryByCommitSha(sha, ctx)) !== null) {
      continue; // R1 territory — already known, nothing to heal
    }
    const trailer = parseChangeIdTrailer(await readCommitMessage(sha, ctx));
    if (trailer === null) {
      unlinked += 1;
      continue;
    }
    const resolved = await resolveChangeId(sha, ctx);
    healed.push({ sha, changeId: resolved.changeId, branch: resolved.branch });
  }

  const lines = [
    rebuild
      ? `Rebuilding change-map from Change-Id trailers across ${shas.length} commits...`
      : `Scanning last ${shas.length} commits for trailer-recovered identity...`,
  ];
  if (healed.length > 0) {
    lines.push(`  healed ${healed.length} commit${healed.length === 1 ? "" : "s"} into change-map`);
  }
  if (unlinked > 0) {
    lines.push(
      `  ${unlinked} commit${unlinked === 1 ? "" : "s"} without trailer left unlinked (see doctor)`,
    );
  }
  lines.push("✓ change-map converged.");

  return { scanned: shas.length, healed, unlinked, output: lines.join("\n") };
}

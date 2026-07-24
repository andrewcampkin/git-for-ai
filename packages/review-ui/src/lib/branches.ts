// Pure labeling/ordering helpers for the branch selector (DESKTOP.md §5 step 3). Same
// discipline as ./format.ts: absent data gets an explicit label, never a guess — a branch
// with no upstream says so rather than rendering a comforting "up to date".

import type { ReviewBranch } from "../types";

/**
 * Order for the selector: the checked-out branch first (it is what the page is about),
 * then the server's newest-commit-first order, untouched.
 */
export function orderBranches(branches: ReviewBranch[]): ReviewBranch[] {
  const current = branches.filter((branch) => branch.current);
  return [...current, ...branches.filter((branch) => !branch.current)];
}

/**
 * Upstream relationship in words. Null upstream is "not tracked" — distinct from a
 * tracked branch that happens to be level, which is "in sync".
 */
export function trackLabel(branch: ReviewBranch): string {
  if (branch.upstream === null) {
    return "not tracked";
  }
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) {
    return `in sync with ${branch.upstream}`;
  }
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  return `${parts.join(", ")} relative to ${branch.upstream}`;
}

/** Tooltip text for a branch chip: tip subject plus the upstream relationship. */
export function branchTitle(branch: ReviewBranch): string {
  const subject = branch.subject.length > 0 ? branch.subject : "(no subject)";
  return `${branch.shortSha} ${subject} — ${trackLabel(branch)}`;
}

/**
 * How the timeline heading describes its scope. `rev === null` means the page is showing
 * HEAD, which we name after the checked-out branch when there is one (a detached HEAD is
 * said out loud rather than dressed up as a branch).
 */
export function scopeLabel(rev: string | null, current: string | null, detached: boolean): string {
  if (rev !== null) {
    return rev;
  }
  if (detached) {
    return "detached HEAD";
  }
  return current ?? "HEAD";
}

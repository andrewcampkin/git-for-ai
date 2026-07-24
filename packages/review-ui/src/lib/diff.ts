// Pure labeling helpers for the diff pane (DESKTOP.md §5 step 3 — "diff viewer with intent
// beside it"). All rendering decisions that can be made without React live here so they are
// testable: this package has no component-render harness, and untested UI logic is how
// honest labels quietly become dishonest ones.

import type { ReviewDiffFile, ReviewDiffLine } from "../types";

/** Human word for a file's status, matching what git means by it. */
export function statusLabel(file: ReviewDiffFile): string {
  switch (file.status) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return file.similarity !== null && file.similarity < 100
        ? `renamed (${file.similarity}% similar)`
        : "renamed";
    case "copied":
      return "copied";
    default:
      return file.modeChange !== null ? "mode changed" : "modified";
  }
}

/** Title line for a file pane: renames/copies show both paths, in git's direction. */
export function fileTitle(file: ReviewDiffFile): string {
  return file.oldPath !== null && file.oldPath !== file.path
    ? `${file.oldPath} → ${file.path}`
    : file.path;
}

/** `+12 −3`, or an explicit note for the cases where line counts mean nothing. */
export function countsLabel(file: ReviewDiffFile): string {
  if (file.binary) {
    return "binary file — no line diff";
  }
  if (file.additions === 0 && file.deletions === 0) {
    return file.status === "renamed" || file.status === "copied"
      ? "content unchanged"
      : "no line changes";
  }
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${file.additions}`);
  if (file.deletions > 0) parts.push(`−${file.deletions}`);
  return parts.join(" ");
}

/** Gutter width in characters, so old/new line numbers line up across every hunk. */
export function gutterWidth(files: ReviewDiffFile[]): number {
  let widest = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      widest = Math.max(widest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
    }
  }
  return Math.max(2, String(widest).length);
}

/** The `+`/`−`/space marker a diff line carries in its own gutter. */
export function lineMarker(line: ReviewDiffLine): string {
  return line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
}

/**
 * Whether a file's pane should start open. Small files open (the point is to read the
 * code); large ones start folded so a 40-file commit is navigable — with the counts
 * visible on every closed header, so nothing is hidden, only deferred.
 */
export function startsOpen(file: ReviewDiffFile, fileCount: number): boolean {
  if (file.binary) return false;
  if (fileCount <= 3) return true;
  return file.additions + file.deletions <= 60;
}

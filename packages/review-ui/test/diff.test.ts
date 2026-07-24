// Diff-pane labeling: the pane's whole value is that it is the evidence a ledger entry
// cannot fake, so its labels have to be exact — a binary file, a rename with no content
// change, and a clipped body each say what they are instead of rendering as "no changes".

import { describe, expect, it } from "vitest";

import type { ReviewDiffFile, ReviewDiffLine } from "../src/types";
import {
  countsLabel,
  fileTitle,
  gutterWidth,
  lineMarker,
  startsOpen,
  statusLabel,
} from "../src/lib/diff";

function makeFile(overrides: Partial<ReviewDiffFile> = {}): ReviewDiffFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    additions: 3,
    deletions: 1,
    binary: false,
    modeChange: null,
    similarity: null,
    hunks: [],
    truncated: false,
    ...overrides,
  };
}

describe("statusLabel", () => {
  it("names each git status, with the similarity on a partial rename", () => {
    expect(statusLabel(makeFile({ status: "added" }))).toBe("added");
    expect(statusLabel(makeFile({ status: "deleted" }))).toBe("deleted");
    expect(statusLabel(makeFile({ status: "renamed", similarity: 100 }))).toBe("renamed");
    expect(statusLabel(makeFile({ status: "renamed", similarity: 87 }))).toBe(
      "renamed (87% similar)",
    );
    expect(statusLabel(makeFile())).toBe("modified");
  });

  it("calls out a mode-only change instead of a generic 'modified'", () => {
    expect(
      statusLabel(makeFile({ modeChange: { from: "100644", to: "100755" } })),
    ).toBe("mode changed");
  });
});

describe("fileTitle", () => {
  it("shows both paths for a rename, one for everything else", () => {
    expect(fileTitle(makeFile())).toBe("src/a.ts");
    expect(fileTitle(makeFile({ oldPath: "src/old.ts", path: "src/new.ts" }))).toBe(
      "src/old.ts → src/new.ts",
    );
  });
});

describe("countsLabel", () => {
  it("renders +/- counts", () => {
    expect(countsLabel(makeFile({ additions: 12, deletions: 3 }))).toBe("+12 −3");
    expect(countsLabel(makeFile({ additions: 12, deletions: 0 }))).toBe("+12");
  });

  it("labels the cases where a line count would be a lie", () => {
    expect(countsLabel(makeFile({ binary: true, additions: 0, deletions: 0 }))).toBe(
      "binary file — no line diff",
    );
    expect(
      countsLabel(makeFile({ status: "renamed", additions: 0, deletions: 0 })),
    ).toBe("content unchanged");
    expect(countsLabel(makeFile({ additions: 0, deletions: 0 }))).toBe("no line changes");
  });
});

describe("gutterWidth", () => {
  it("sizes the gutter to the widest line number across every file", () => {
    const wide = makeFile({
      hunks: [{ header: "@@", oldStart: 990, oldLines: 20, newStart: 990, newLines: 20, lines: [] }],
    });
    expect(gutterWidth([wide])).toBe(4);
    expect(gutterWidth([makeFile()])).toBe(2);
  });
});

describe("lineMarker", () => {
  it("marks adds, deletes, and context", () => {
    const line = (kind: ReviewDiffLine["kind"]): ReviewDiffLine => ({
      kind,
      oldLine: 1,
      newLine: 1,
      text: "x",
    });
    expect(lineMarker(line("add"))).toBe("+");
    expect(lineMarker(line("del"))).toBe("−");
    expect(lineMarker(line("context"))).toBe(" ");
  });
});

describe("startsOpen", () => {
  it("opens everything in a small commit, and folds the big files in a large one", () => {
    expect(startsOpen(makeFile({ additions: 500, deletions: 500 }), 2)).toBe(true);
    expect(startsOpen(makeFile({ additions: 500, deletions: 500 }), 12)).toBe(false);
    expect(startsOpen(makeFile({ additions: 4, deletions: 1 }), 12)).toBe(true);
  });

  it("never auto-opens a binary file (there is nothing to read)", () => {
    expect(startsOpen(makeFile({ binary: true, additions: 0, deletions: 0 }), 1)).toBe(false);
  });
});

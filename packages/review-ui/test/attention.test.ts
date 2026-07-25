// Attention queue computation (REVIEW_UI.md §4.4) + v2 inbox grouping — pure-logic tests.

import { describe, expect, it } from "vitest";

import { computeAttention, groupAttention, type AttentionItem } from "../src/lib/attention";
import { makeEntry, makeReportData, makeRow } from "./fixtures";

describe("computeAttention", () => {
  it("returns nothing for a fully-captured, confident range", () => {
    const data = makeReportData({
      timeline: [makeRow()],
      changes: [
        {
          changeId: "0123456789abcdef0123456789abcdef",
          commits: [],
          entries: [{ entry: makeEntry(), effective: true }],
          effective: makeEntry({ reasoning: { confidence: 0.9 } }),
          supersededCount: 0,
          session: { ref: null, status: "none" },
        },
      ],
    });
    expect(computeAttention(data)).toEqual([]);
  });

  it("flags no-intent commits and unreadable notes distinctly", () => {
    const data = makeReportData({
      timeline: [
        makeRow({
          sha: "1".repeat(40),
          shortSha: "1111111",
          hasIntent: false,
          summarySource: "git-subject",
          subject: "plain commit",
          badge: { kind: "none", label: "no reasoning recorded" },
        }),
        makeRow({
          sha: "2".repeat(40),
          shortSha: "2222222",
          hasIntent: false,
          summarySource: "git-subject-note-unreadable",
          subject: "corrupt note commit",
          badge: { kind: "none", label: "note unreadable" },
        }),
      ],
    });
    const items = computeAttention(data);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "no-intent",
      title: "no reasoning recorded on 1111111",
      detail: "plain commit",
      href: `#/change/${"1".repeat(40)}`,
    });
    expect(items[1]).toMatchObject({
      kind: "note-unreadable",
      title: "note unreadable on 2222222",
      detail: "corrupt note commit",
    });
  });

  it("flags low-confidence (< 0.5) effective entries, not confident ones", () => {
    const changeId = "abcdefabcdefabcdefabcdefabcdefab";
    const low = makeEntry({ reasoning: { confidence: 0.3 }, summary: "sketchy change" });
    const data = makeReportData({
      changes: [
        {
          changeId,
          commits: [],
          entries: [{ entry: low, effective: true }],
          effective: low,
          supersededCount: 0,
          session: { ref: null, status: "none" },
        },
      ],
    });
    const items = computeAttention(data);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "low-confidence",
      title: "low confidence (0.30) on change c/abcdefab",
      detail: "sketchy change",
      href: `#/change/c/${changeId}`,
    });
    // Exactly 0.5 is NOT low-confidence (threshold is strict <).
    const borderline = makeEntry({ reasoning: { confidence: 0.5 } });
    const borderlineData = makeReportData({
      changes: [
        {
          changeId,
          commits: [],
          entries: [{ entry: borderline, effective: true }],
          effective: borderline,
          supersededCount: 0,
          session: { ref: null, status: "none" },
        },
      ],
    });
    expect(computeAttention(borderlineData)).toEqual([]);
  });

  it("flags inferred-provenance effective entries", () => {
    const changeId = "abcdefabcdefabcdefabcdefabcdefab";
    const inferred = makeEntry({ provenance: "inferred", summary: "recovered summary" });
    const data = makeReportData({
      changes: [
        {
          changeId,
          commits: [],
          entries: [{ entry: inferred, effective: true }],
          effective: inferred,
          supersededCount: 0,
          session: { ref: null, status: "none" },
        },
      ],
    });
    const items = computeAttention(data);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "inferred-provenance",
      title: "inferred provenance on change c/abcdefab",
      detail: "recovered summary",
    });
  });

  it("skips changes with identity but no recorded reasoning (already flagged per-commit)", () => {
    const data = makeReportData({
      changes: [
        {
          changeId: "abcdefabcdefabcdefabcdefabcdefab",
          commits: [],
          entries: [],
          effective: null,
          supersededCount: 0,
          session: { ref: null, status: "none" },
        },
      ],
    });
    expect(computeAttention(data)).toEqual([]);
  });
});

describe("groupAttention (v2 inbox)", () => {
  const item = (kind: AttentionItem["kind"], title: string): AttentionItem => ({
    kind,
    title,
    detail: "detail",
    href: null,
  });

  it("groups by kind in severity order, omitting empty groups", () => {
    const items = [
      item("no-intent", "a"),
      item("low-confidence", "b"),
      item("no-intent", "c"),
      item("note-unreadable", "d"),
    ];
    const groups = groupAttention(items);
    expect(groups.map((g) => g.kind)).toEqual(["note-unreadable", "low-confidence", "no-intent"]);
    expect(groups[0]!.title).toBe("Unreadable notes");
    expect(groups[2]!.items.map((i) => i.title)).toEqual(["a", "c"]);
  });

  it("preserves item order within a group and returns no groups for no items", () => {
    expect(groupAttention([])).toEqual([]);
    const groups = groupAttention([
      item("inferred-provenance", "first"),
      item("inferred-provenance", "second"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("inferred-provenance");
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["first", "second"]);
  });

  it("gives every group a human title and a why line", () => {
    const groups = groupAttention([
      item("note-unreadable", "n"),
      item("low-confidence", "l"),
      item("inferred-provenance", "i"),
      item("no-intent", "p"),
    ]);
    for (const group of groups) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.why.length).toBeGreaterThan(0);
    }
  });
});

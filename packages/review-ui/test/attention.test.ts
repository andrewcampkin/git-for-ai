// Attention queue computation (REVIEW_UI.md §4.4) — pure-logic tests.

import { describe, expect, it } from "vitest";

import { computeAttention } from "../src/lib/attention";
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
          badge: { kind: "none", label: "no captured intent" },
        }),
        makeRow({
          sha: "2".repeat(40),
          shortSha: "2222222",
          hasIntent: false,
          summarySource: "git-subject-note-unreadable",
          subject: "corrupt note commit",
          badge: { kind: "none", label: "ledger note unreadable" },
        }),
      ],
    });
    const items = computeAttention(data);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "no-intent",
      title: "no captured intent on 1111111",
      detail: "plain commit",
      href: `#/change/${"1".repeat(40)}`,
    });
    expect(items[1]).toMatchObject({
      kind: "note-unreadable",
      title: "ledger note unreadable on 2222222",
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

  it("skips changes with identity but no captured intent (already flagged per-commit)", () => {
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

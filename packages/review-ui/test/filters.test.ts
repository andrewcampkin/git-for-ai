// Client-side timeline filtering (REVIEW_UI.md §4.1) — pure-logic tests.

import { describe, expect, it } from "vitest";

import { EMPTY_FILTER, filterTimeline, modelsInTimeline } from "../src/lib/filters";
import { makeRow } from "./fixtures";

const agentRow = makeRow({
  sha: "1".repeat(40),
  shortSha: "1111111",
  authorDate: "2026-07-18T09:00:00+00:00",
});
const humanRow = makeRow({
  sha: "2".repeat(40),
  shortSha: "2222222",
  authorDate: "2026-07-17T12:00:00+00:00",
  badge: { kind: "human", label: "human · dev@example.test" },
  flags: {},
  provenance: "human-authored",
});
const otherModelRow = makeRow({
  sha: "3".repeat(40),
  shortSha: "3333333",
  authorDate: "2026-07-16T08:00:00+00:00",
  badge: { kind: "agent", tool: "other-tool", model: "other-model", label: "agent · other-tool · other-model" },
});
const noIntentRow = makeRow({
  sha: "4".repeat(40),
  shortSha: "4444444",
  authorDate: "2026-07-15T08:00:00+00:00",
  changeId: null,
  summary: "plain git subject",
  hasIntent: false,
  summarySource: "git-subject",
  badge: { kind: "none", label: "no captured intent" },
  flags: {},
});
// deliberately degraded date — must never match a date-bounded filter
const badDateRow = makeRow({
  sha: "5".repeat(40),
  shortSha: "5555555",
  authorDate: "not-a-date",
});

const ALL = [agentRow, humanRow, otherModelRow, noIntentRow, badDateRow];

describe("filterTimeline", () => {
  it("passes everything through with the empty filter", () => {
    expect(filterTimeline(ALL, EMPTY_FILTER)).toEqual(ALL);
  });

  it("filters by author kind, including the no-captured-intent kind", () => {
    expect(filterTimeline(ALL, { ...EMPTY_FILTER, kind: "agent" })).toEqual([
      agentRow,
      otherModelRow,
      badDateRow,
    ]);
    expect(filterTimeline(ALL, { ...EMPTY_FILTER, kind: "human" })).toEqual([humanRow]);
    expect(filterTimeline(ALL, { ...EMPTY_FILTER, kind: "none" })).toEqual([noIntentRow]);
    expect(filterTimeline(ALL, { ...EMPTY_FILTER, kind: "mixed" })).toEqual([]);
  });

  it("filters by model (rows without a model never match a model filter)", () => {
    expect(filterTimeline(ALL, { ...EMPTY_FILTER, model: "other-model" })).toEqual([
      otherModelRow,
    ]);
    expect(
      filterTimeline(ALL, { ...EMPTY_FILTER, model: "claude-opus-4-8" }).map((r) => r.sha),
    ).toEqual([agentRow.sha, badDateRow.sha]);
  });

  it("filters by inclusive date bounds", () => {
    expect(
      filterTimeline(ALL, { ...EMPTY_FILTER, since: "2026-07-17" }).map((r) => r.shortSha),
    ).toEqual(["1111111", "2222222"]);
    expect(
      filterTimeline(ALL, { ...EMPTY_FILTER, until: "2026-07-16" }).map((r) => r.shortSha),
    ).toEqual(["3333333", "4444444"]);
    expect(
      filterTimeline(ALL, {
        ...EMPTY_FILTER,
        since: "2026-07-16",
        until: "2026-07-17",
      }).map((r) => r.shortSha),
    ).toEqual(["2222222", "3333333"]);
  });

  it("excludes rows with unparseable dates from any date-bounded filter (never guesses)", () => {
    const withBounds = filterTimeline(ALL, { ...EMPTY_FILTER, since: "2000-01-01" });
    expect(withBounds.map((r) => r.shortSha)).not.toContain("5555555");
  });

  it("combines kind + model + date filters", () => {
    expect(
      filterTimeline(ALL, {
        kind: "agent",
        model: "claude-opus-4-8",
        since: "2026-07-18",
        until: "",
      }),
    ).toEqual([agentRow]);
  });
});

describe("modelsInTimeline", () => {
  it("collects distinct badge models, sorted", () => {
    expect(modelsInTimeline(ALL)).toEqual(["claude-opus-4-8", "other-model"]);
  });

  it("is empty when no row carries a model", () => {
    expect(modelsInTimeline([humanRow, noIntentRow])).toEqual([]);
  });
});

// Client-side timeline filtering (REVIEW_UI.md §4.1: filterable by author kind, model,
// and date — all client-side over the already-fetched ReportData). Pure functions so the
// logic is unit-tested without a DOM.

import type { ReportTimelineRow } from "../types";

export interface TimelineFilter {
  /** Author-kind filter; "none" = commits with no captured intent. */
  kind: "all" | "agent" | "human" | "mixed" | "none";
  /** Model filter — matches the badge's model; "all" disables. */
  model: string;
  /** Inclusive YYYY-MM-DD lower bound on the author date; "" disables. */
  since: string;
  /** Inclusive YYYY-MM-DD upper bound on the author date; "" disables. */
  until: string;
}

export const EMPTY_FILTER: TimelineFilter = { kind: "all", model: "all", since: "", until: "" };

/** The author date's calendar day (YYYY-MM-DD), or "" for degraded input. */
function dayOf(authorDate: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(authorDate) ? authorDate.slice(0, 10) : "";
}

/** Apply the filter. Rows with degraded (unparseable) dates never match a date bound. */
export function filterTimeline(
  rows: ReportTimelineRow[],
  filter: TimelineFilter,
): ReportTimelineRow[] {
  return rows.filter((row) => {
    if (filter.kind !== "all" && row.badge.kind !== filter.kind) {
      return false;
    }
    if (filter.model !== "all" && row.badge.model !== filter.model) {
      return false;
    }
    if (filter.since !== "" || filter.until !== "") {
      const day = dayOf(row.authorDate);
      if (day === "") {
        return false;
      }
      if (filter.since !== "" && day < filter.since) {
        return false;
      }
      if (filter.until !== "" && day > filter.until) {
        return false;
      }
    }
    return true;
  });
}

/** Distinct models present on timeline badges, sorted — the model dropdown's options. */
export function modelsInTimeline(rows: ReportTimelineRow[]): string[] {
  const models = new Set<string>();
  for (const row of rows) {
    if (row.badge.model !== undefined) {
      models.add(row.badge.model);
    }
  }
  return [...models].sort();
}

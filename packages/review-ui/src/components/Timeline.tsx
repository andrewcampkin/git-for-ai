// Timeline (REVIEW_UI.md §4.1): ReportData's timeline rows, filterable CLIENT-SIDE by
// author kind, model, and date. Each row: sha, when, summary (honest degradation labels
// preserved verbatim from report.ts), author badge, provenance pill, conf/risk/undo flags.

import { useMemo, useState } from "react";

import type { ReportTimelineRow } from "../types";
import { fmtWhen, sourceTag } from "../lib/format";
import {
  EMPTY_FILTER,
  filterTimeline,
  modelsInTimeline,
  type TimelineFilter,
} from "../lib/filters";
import { BadgePill, FlagPills, ProvenancePill } from "./Pills";

function TimelineRow({ row }: { row: ReportTimelineRow }) {
  const tag = sourceTag(row.summarySource);
  return (
    <article className={`row${row.hasIntent ? "" : " no-intent"}`}>
      <div className="row-head">
        <a className="sha" href={`#/change/${row.sha}`} title={row.sha}>
          {row.shortSha}
        </a>
        <time dateTime={row.authorDate}>{fmtWhen(row.authorDate)}</time>
        <BadgePill badge={row.badge} />
        {row.provenance !== undefined && <ProvenancePill provenance={row.provenance} />}
        <FlagPills flags={row.flags} />
        {row.changeId !== null && (
          <a href={`#/change/c/${row.changeId}`}>c/{row.changeId.slice(0, 8)}</a>
        )}
      </div>
      <p className="summary">
        {row.summary}
        {tag !== null && <span className="degraded-tag">{tag}</span>}
      </p>
    </article>
  );
}

export function Timeline({ rows }: { rows: ReportTimelineRow[] }) {
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_FILTER);
  const models = useMemo(() => modelsInTimeline(rows), [rows]);
  const visible = useMemo(() => filterTimeline(rows, filter), [rows, filter]);
  const isFiltered =
    filter.kind !== "all" || filter.model !== "all" || filter.since !== "" || filter.until !== "";

  return (
    <section>
      <h2 id="timeline">Timeline</h2>
      <div className="filters">
        <label>
          author
          <select
            value={filter.kind}
            onChange={(event) =>
              setFilter({ ...filter, kind: event.target.value as TimelineFilter["kind"] })
            }
          >
            <option value="all">all</option>
            <option value="agent">agent</option>
            <option value="human">human</option>
            <option value="mixed">mixed</option>
            <option value="none">no captured intent</option>
          </select>
        </label>
        <label>
          model
          <select
            value={filter.model}
            onChange={(event) => setFilter({ ...filter, model: event.target.value })}
          >
            <option value="all">all</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label>
          since
          <input
            type="date"
            value={filter.since}
            onChange={(event) => setFilter({ ...filter, since: event.target.value })}
          />
        </label>
        <label>
          until
          <input
            type="date"
            value={filter.until}
            onChange={(event) => setFilter({ ...filter, until: event.target.value })}
          />
        </label>
        {isFiltered && (
          <button type="button" onClick={() => setFilter(EMPTY_FILTER)}>
            clear
          </button>
        )}
        <span className="count">
          {visible.length} of {rows.length} commit{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 && <p className="empty">No commits in range.</p>}
      {rows.length > 0 && visible.length === 0 && (
        <p className="empty">No commits match the current filters.</p>
      )}
      {visible.map((row) => (
        <TimelineRow key={row.sha} row={row} />
      ))}
    </section>
  );
}

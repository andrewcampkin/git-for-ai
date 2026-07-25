// Timeline (Review UI v2): what a human wants first — the SUMMARY, readable, grouped
// under day headings ("what did my agents do this week"). Evidence and risk flags stay
// on the row (author badge, conf/risk/undo pills, honest degradation tags); internals
// are demoted: the sha is a small trailing link, provenance only appears when it is
// noteworthy (inferred), and change-ids are gone from the page entirely — they remain
// on the CLI's --json output, which is the agent contract.

import { useMemo, useState } from "react";

import type { ReportTimelineRow } from "../types";
import { dayHeading, fmtTime, isNoteworthyProvenance, sourceTag } from "../lib/format";
import {
  EMPTY_FILTER,
  filterTimeline,
  groupByDay,
  modelsInTimeline,
  type TimelineFilter,
} from "../lib/filters";
import { BadgePill, FlagPills, ProvenancePill } from "./Pills";

function TimelineRow({ row }: { row: ReportTimelineRow }) {
  const tag = sourceTag(row.summarySource);
  return (
    <article className={`row${row.hasIntent ? "" : " no-intent"}`}>
      <p className="summary">
        <a href={`#/change/${row.sha}`}>{row.summary}</a>
        {tag !== null && <span className="degraded-tag">{tag}</span>}
      </p>
      <div className="row-meta">
        <BadgePill badge={row.badge} />
        <FlagPills flags={row.flags} />
        {row.provenance !== undefined && isNoteworthyProvenance(row.provenance) && (
          <ProvenancePill provenance={row.provenance} />
        )}
        <time dateTime={row.authorDate}>{fmtTime(row.authorDate)}</time>
        <a className="sha row-sha" href={`#/change/${row.sha}`} title={row.sha}>
          {row.shortSha}
        </a>
      </div>
    </article>
  );
}

export function Timeline({ rows }: { rows: ReportTimelineRow[] }) {
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_FILTER);
  const models = useMemo(() => modelsInTimeline(rows), [rows]);
  const visible = useMemo(() => filterTimeline(rows, filter), [rows, filter]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const today = new Date().toISOString().slice(0, 10);
  const isFiltered =
    filter.kind !== "all" || filter.model !== "all" || filter.since !== "" || filter.until !== "";

  return (
    <section aria-labelledby="timeline">
      <h2 id="timeline">Activity</h2>
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
            <option value="none">no reasoning recorded</option>
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
      {days.map((group) => (
        <div key={group.day === "" ? "undated" : group.day}>
          <h3 className="day-head">{dayHeading(group.day, today)}</h3>
          {group.rows.map((row) => (
            <TimelineRow key={row.sha} row={row} />
          ))}
        </div>
      ))}
    </section>
  );
}

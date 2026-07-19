// Session trace viewer (REVIEW_UI.md §4.3): spans as a readable narrative list — kind,
// tool name, one-line key attribute (command/file), timestamp — with collapsible raw
// attributes per span. An unresolvable ref renders the honest "session trace unavailable"
// label with its reason, exactly like report/show.

import type { ReviewSessionData, Span } from "../types";
import { fmtWhen, spanHeadline } from "../lib/format";
import { useFetch } from "../lib/useFetch";

function SpanRow({ span }: { span: Span }) {
  const headline = spanHeadline(span);
  const hasRaw =
    (span.attributes !== undefined && Object.keys(span.attributes).length > 0) ||
    (span.body !== undefined && Object.keys(span.body).length > 0);
  return (
    <div className={`span-row${span.parent_id !== undefined ? " nested" : ""}`}>
      <div className="span-line">
        <span className="pill pill-kind">{span.kind}</span>
        {span.name !== undefined && <strong>{span.name}</strong>}
        {headline !== null && <span className="headline">{headline}</span>}
        {span.start !== undefined && <span className="when">{fmtWhen(span.start)}</span>}
      </div>
      {hasRaw && (
        <details>
          <summary>raw attributes</summary>
          <pre>
            {JSON.stringify(
              {
                ...(span.attributes !== undefined ? { attributes: span.attributes } : {}),
                ...(span.body !== undefined ? { body: span.body } : {}),
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

export function SessionTrace({ sessionRef }: { sessionRef: string }) {
  const result = useFetch<ReviewSessionData>(`/api/session/${sessionRef}`);

  if (result.state === "loading") {
    return <p className="loading">Loading session trace…</p>;
  }
  if (result.state === "error") {
    return (
      <>
        <a className="back-link" href="#/">
          ← back to the overview
        </a>
        <div className="error-box">Could not load the session trace: {result.error}</div>
      </>
    );
  }

  const data = result.data;
  if (data.status === "unavailable" || data.record === undefined) {
    return (
      <>
        <a className="back-link" href="#/">
          ← back to the overview
        </a>
        <div className="error-box">
          session trace unavailable — {data.reason ?? "unknown reason"}
        </div>
      </>
    );
  }

  const record = data.record;
  return (
    <>
      <a className="back-link" href="#/">
        ← back to the overview
      </a>
      <section className="trace-head">
        <h3>
          {record.agent.tool} session{" "}
          {record.agent.model !== undefined && (
            <span className="commit-line">({record.agent.model})</span>
          )}
        </h3>
        <p className="commit-line">
          captured {fmtWhen(record.captured_at)} · {record.agent.tool} {record.agent.version}{" "}
          · commits {record.commit_range.since.slice(0, 7)}..
          {record.commit_range.until.slice(0, 7)} · redaction{" "}
          {record.redaction.applied
            ? `applied (${record.redaction.redacted_count} redacted)`
            : "not applied"}
        </p>
        {record.summary !== undefined && <p>{record.summary}</p>}
        <details className="record-details">
          <summary>Record details</summary>
          <p className="commit-line">
            session ref <code>{data.ref}</code>
          </p>
        </details>
      </section>
      <h2>
        What it did — {record.spans.length} span{record.spans.length === 1 ? "" : "s"}
      </h2>
      {record.spans.length === 0 && <p className="empty">This session recorded no spans.</p>}
      {record.spans.map((span) => (
        <SpanRow key={span.span_id} span={span} />
      ))}
    </>
  );
}

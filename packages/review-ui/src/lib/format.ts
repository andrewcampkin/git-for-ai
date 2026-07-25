// Pure formatting/labeling helpers — the same information design as `git for-ai report`
// (packages/cli/src/commands/report.ts; this SPA is that page made live). Honest
// degradation is the product: every label here mirrors report.ts's wording exactly, and
// absent data always renders an explicit label, never a guess.

import type {
  ReportFlags,
  ReportSessionInfo,
  ReportTimelineRow,
  ShowSessionInfo,
  Span,
} from "../types";

/** `2026-07-18 09:22` from an RFC 3339 timestamp; degraded input passes through as-is. */
export function fmtWhen(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    : iso;
}

/** `09:22` from an RFC 3339 timestamp (for rows under a day heading); degraded → as-is. */
export function fmtTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : iso;
}

/**
 * Human heading for a timeline day group. `today` is injected (YYYY-MM-DD) so the
 * function stays pure. The empty day (degraded/unparseable author dates) is labeled
 * honestly, never guessed into a date.
 */
export function dayHeading(day: string, today: string): string {
  if (day === "") {
    return "date unavailable";
  }
  if (day === today) {
    return `Today · ${day}`;
  }
  const yesterday = new Date(`${today}T12:00:00Z`);
  if (!Number.isNaN(yesterday.getTime())) {
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    if (day === yesterday.toISOString().slice(0, 10)) {
      return `Yesterday · ${day}`;
    }
  }
  return day;
}

/**
 * Whether a provenance value deserves the reader's attention on the overview.
 * `agent-captured` and `human-authored` are the normal, expected cases — showing a pill
 * for every row would be noise; `inferred` means the intent was reconstructed rather than
 * directly captured, which a reviewer should see.
 */
export function isNoteworthyProvenance(provenance: string): boolean {
  return provenance !== "agent-captured" && provenance !== "human-authored";
}

/** Human label for a summary's provenance (the honest-degradation tag), per report.ts. */
export function sourceTag(source: ReportTimelineRow["summarySource"]): string | null {
  switch (source) {
    case "ledger":
      return null;
    case "git-subject":
      return "no reasoning recorded — showing the commit message";
    case "git-subject-note-unreadable":
      return "note unreadable — showing the commit message";
  }
}

/** `["conf 0.82", "risk medium", "undo easy"]` — only the flags actually present. */
export function flagParts(flags: ReportFlags): string[] {
  const parts: string[] = [];
  if (flags.confidence !== undefined) {
    parts.push(`conf ${flags.confidence.toFixed(2)}`);
  }
  if (flags.scopeRisk !== undefined) {
    parts.push(`risk ${flags.scopeRisk}`);
  }
  if (flags.reversibility !== undefined) {
    parts.push(`undo ${flags.reversibility}`);
  }
  return parts;
}

/** One-line session summary, mirroring report.ts's sessionLine. */
export function sessionLine(session: ReportSessionInfo): string {
  switch (session.status) {
    case "none":
      return "no session captured";
    case "unavailable":
      return `no session record available — ${session.reason ?? "unknown reason"}`;
    case "available": {
      const agent = [session.agentTool, session.agentVersion]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const model = session.agentModel !== undefined ? ` (${session.agentModel})` : "";
      const spans = `${session.spanCount ?? 0} step${session.spanCount === 1 ? "" : "s"}`;
      const captured =
        session.capturedAt !== undefined ? ` · captured ${fmtWhen(session.capturedAt)}` : "";
      return `${agent}${model} · ${spans}${captured}`;
    }
  }
}

/** The same one-liner from show.ts's ShowSessionInfo shape (record nested, not flattened). */
export function sessionLineFromShow(session: ShowSessionInfo): string {
  if (session.status === "none") {
    return "no session captured";
  }
  if (session.status === "unavailable" || session.record === undefined) {
    return `no session record available — ${session.reason ?? "unknown reason"}`;
  }
  const record = session.record;
  return sessionLine({
    ref: session.ref,
    status: "available",
    agentTool: record.agent.tool,
    agentModel: record.agent.model,
    agentVersion: record.agent.version,
    spanCount: record.spans.length,
    capturedAt: record.captured_at,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
  });
}

/** Attribute keys most likely to be the one-line story of a span, in preference order. */
const KEY_ATTRIBUTES = ["command", "file", "file_path", "path", "query", "target", "url"];

/**
 * One-line rendering of a span's key attribute for the trace narrative (REVIEW_UI.md §4.3:
 * "tool, one-line rendering of the key attribute — command/file — timestamp"). Returns
 * null when the span carries nothing headline-worthy — the caller renders the kind alone,
 * never an invented description.
 */
export function spanHeadline(span: Span): string | null {
  const attributes = span.attributes ?? {};
  for (const key of KEY_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const body = span.body ?? {};
  for (const key of ["plan", "text", "diff_summary"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) {
      const firstLine = value.split("\n", 1)[0] ?? "";
      return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
    }
  }
  return null;
}

/** Plain-language label for a span's kind (raw values are our internal telemetry shape). */
export function spanKindLabel(kind: string): string {
  switch (kind) {
    case "agent.plan":
      return "plan";
    case "gen_ai.completion":
      return "response";
    case "gen_ai.tool.execution":
      return "tool use";
    case "agent.step":
      return "step";
    default:
      return kind;
  }
}

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

/** Human label for a summary's provenance (the honest-degradation tag), per report.ts. */
export function sourceTag(source: ReportTimelineRow["summarySource"]): string | null {
  switch (source) {
    case "ledger":
      return null;
    case "git-subject":
      return "no captured intent — showing the commit's own git subject";
    case "git-subject-note-unreadable":
      return "ledger note unreadable — showing the commit's own git subject";
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
      return `session trace unavailable — ${session.reason ?? "unknown reason"}`;
    case "available": {
      const agent = [session.agentTool, session.agentVersion]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const model = session.agentModel !== undefined ? ` (${session.agentModel})` : "";
      const spans = `${session.spanCount ?? 0} span${session.spanCount === 1 ? "" : "s"}`;
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
    return `session trace unavailable — ${session.reason ?? "unknown reason"}`;
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

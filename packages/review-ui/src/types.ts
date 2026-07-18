// Type-only bridge to the API's payload shapes (REVIEW_UI.md §3): the types live in the
// CLI package next to the commands that produce them, and are imported here as TYPES ONLY
// (erased at build — `verbatimModuleSyntax` enforces it). This package never imports core,
// and never imports any CLI *runtime* code; the relative paths reach the CLI's built
// declaration files because the CLI cannot be a package dependency (it already depends on
// this package for its assets — a package cycle would break the workspace graph).

export type {
  ReportData,
  ReportTimelineRow,
  ReportChangeSection,
  ReportChangeCommit,
  ReportLedgerRow,
  ReportBadge,
  ReportFlags,
  ReportSessionInfo,
  ReportTotals,
} from "../../cli/dist/commands/report";

export type {
  ShowData,
  ShowCommitInfo,
  ShowLedgerRow,
  ShowSessionInfo,
} from "../../cli/dist/commands/show";

export type {
  ReviewMeta,
  ReviewMetaIndex,
  ReviewSessionData,
} from "../../cli/dist/commands/review";

// Record-format types come from the schemas package (types only; erased at build).
export type {
  ChangeMapEntry,
  LedgerEntry,
  Provenance,
  SessionRecord,
  Span,
} from "@git-for-ai/schemas";

// Badge / provenance / flag pills — the same visual vocabulary as report.ts's HTML
// renderer (pill-agent / pill-none / prov-inferred / pill-risk-* classes).

import type { ReportBadge, ReportFlags, Provenance } from "../types";

export function BadgePill({ badge }: { badge: ReportBadge }) {
  return <span className={`pill pill-${badge.kind}`}>{badge.label}</span>;
}

export function ProvenancePill({ provenance }: { provenance: Provenance }) {
  return <span className={`pill pill-prov prov-${provenance}`}>{provenance}</span>;
}

export function FlagPills({ flags }: { flags: ReportFlags }) {
  return (
    <>
      {flags.confidence !== undefined && (
        <span className="pill pill-conf">conf {flags.confidence.toFixed(2)}</span>
      )}
      {flags.scopeRisk !== undefined && (
        <span className={`pill pill-risk-${flags.scopeRisk}`}>risk {flags.scopeRisk}</span>
      )}
      {flags.reversibility !== undefined && (
        <span className="pill pill-undo">undo {flags.reversibility}</span>
      )}
    </>
  );
}

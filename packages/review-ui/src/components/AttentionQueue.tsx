// Minimal v1 attention queue (REVIEW_UI.md §4.4) — computed client-side from ReportData
// (see src/lib/attention.ts for the judgment call on change-map origin). An empty queue is
// stated as such, not hidden.

import { useMemo } from "react";

import type { ReportData } from "../types";
import { computeAttention } from "../lib/attention";

export function AttentionQueue({ data }: { data: ReportData }) {
  const items = useMemo(() => computeAttention(data), [data]);

  return (
    <section>
      <h2 id="attention">Needs attention</h2>
      {items.length === 0 && (
        <p className="attention-empty">
          Nothing flagged in this range — every commit has captured intent, no unreadable
          notes, no low-confidence or inferred entries.
        </p>
      )}
      {items.map((item, index) => (
        <div className="attention-item" key={`${item.kind}-${index}`}>
          <span className="pill pill-kind">{item.kind}</span>
          {item.href !== null ? <a href={item.href}>{item.title}</a> : <span>{item.title}</span>}
          <span className="a-detail">{item.detail}</span>
        </div>
      ))}
    </section>
  );
}

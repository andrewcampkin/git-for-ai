// Attention inbox (Review UI v2): "look at these first", grouped by why they need a
// human — record damage, low agent confidence, reconstructed intent, plain-git commits —
// in that severity order (src/lib/attention.ts). Each group shows its first few items;
// the rest fold behind a disclosure. An empty queue is stated as such, never hidden.

import { useMemo } from "react";

import type { ReportData } from "../types";
import { computeAttention, groupAttention, type AttentionItem } from "../lib/attention";
import { RepairPanel } from "./RepairPanel";

/** Items shown before the group folds the remainder behind "show more". */
const VISIBLE_PER_GROUP = 3;

function Item({ item }: { item: AttentionItem }) {
  return (
    <li className="attn-item">
      {item.href !== null ? <a href={item.href}>{item.title}</a> : <span>{item.title}</span>}
      <span className="attn-detail">{item.detail}</span>
    </li>
  );
}

export function AttentionQueue({
  data,
  canRepair = false,
}: {
  data: ReportData;
  /**
   * Whether this window may run repairs. The checkup lives here rather than in the
   * maintenance panel (DESKTOP.md §3 item 4): what it finds belongs in the list of things
   * needing a person, not in a drawer elsewhere on the page.
   */
  canRepair?: boolean;
}) {
  const groups = useMemo(() => groupAttention(computeAttention(data)), [data]);

  return (
    <section aria-labelledby="attention">
      <h2 id="attention">Needs your attention</h2>
      {groups.length === 0 && (
        <p className="attention-empty">
          Nothing flagged in this range — every commit has recorded reasoning, no unreadable
          notes, no low-confidence or inferred entries.
        </p>
      )}
      {canRepair && <RepairPanel />}
      {groups.map((group) => {
        const visible = group.items.slice(0, VISIBLE_PER_GROUP);
        const folded = group.items.slice(VISIBLE_PER_GROUP);
        return (
          <div className="attn-group" key={group.kind}>
            <div className="attn-head">
              <span className="attn-count">{group.items.length}</span>
              <span className="attn-title">{group.title}</span>
              <span className="attn-why">{group.why}</span>
            </div>
            <ul className="attn-list">
              {visible.map((item, index) => (
                <Item key={index} item={item} />
              ))}
            </ul>
            {folded.length > 0 && (
              <details className="attn-more">
                <summary>
                  show {folded.length} more
                </summary>
                <ul className="attn-list">
                  {folded.map((item, index) => (
                    <Item key={index} item={item} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}

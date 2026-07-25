// The v1 attention queue (REVIEW_UI.md §4.4): computed purely from data already available
// in ReportData — no new server-side assembly. Grows real `doctor` integration when M14
// lands.
//
// Judgment call: the spec lists "changes with origin: inferred/orphan-recovery" — but the
// change-map `origin` field is not part of ReportData (it lives on ChangeMapEntry, which
// only /api/change/:target returns), and REVIEW_UI.md §3 forbids new data assembly in the
// server. The overview-visible proxy is the ledger `provenance` field ("inferred" marks
// entries whose intent was not directly captured), so that is what v1 flags here; the
// change detail page shows the change-map origin itself.

import type { ReportData } from "../types";

export type AttentionKind =
  | "no-intent"
  | "note-unreadable"
  | "low-confidence"
  | "inferred-provenance";

export interface AttentionItem {
  kind: AttentionKind;
  /** Short human title, e.g. `no captured intent on ab12cd3`. */
  title: string;
  /** Supporting line (the commit subject or entry summary — always real data). */
  detail: string;
  /** In-app hash route to the evidence, or null when there is nowhere to link. */
  href: string | null;
}

/** Confidence below this is queue-worthy (REVIEW_UI.md §4.4). */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** One inbox group: a kind, its human title, and its items (order preserved). */
export interface AttentionGroup {
  kind: AttentionKind;
  /** Human group title — what the reader should do/know, not the internal kind name. */
  title: string;
  /** One-line explanation of why this group is worth attention. */
  why: string;
  items: AttentionItem[];
}

/**
 * Inbox severity order + human titles. Record damage first (unreadable notes), then
 * entries the agent itself was unsure about, then reconstructed intent, then the common
 * plain-git case last.
 */
const GROUPS: { kind: AttentionKind; title: string; why: string }[] = [
  {
    kind: "note-unreadable",
    title: "Unreadable notes",
    why: "A note exists but could not be read — the record is damaged, not missing.",
  },
  {
    kind: "low-confidence",
    title: "Low-confidence changes",
    why: `The agent itself rated its confidence below ${LOW_CONFIDENCE_THRESHOLD.toFixed(1)} — review these first.`,
  },
  {
    kind: "inferred-provenance",
    title: "Inferred intent",
    why: "Intent was reconstructed after the fact, not captured live from the agent.",
  },
  {
    kind: "no-intent",
    title: "Commits with no recorded reasoning",
    why: "Plain git commits — nothing recorded beyond the commit message itself.",
  },
];

/** Group attention items into the inbox's severity-ordered groups (empty groups omitted). */
export function groupAttention(items: AttentionItem[]): AttentionGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.kind === group.kind),
  })).filter((group) => group.items.length > 0);
}

export function computeAttention(data: ReportData): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const row of data.timeline) {
    if (row.summarySource === "git-subject-note-unreadable") {
      items.push({
        kind: "note-unreadable",
        title: `note unreadable on ${row.shortSha}`,
        detail: row.subject,
        href: `#/change/${row.sha}`,
      });
    } else if (!row.hasIntent) {
      items.push({
        kind: "no-intent",
        title: `no reasoning recorded on ${row.shortSha}`,
        detail: row.subject,
        href: `#/change/${row.sha}`,
      });
    }
  }

  for (const change of data.changes) {
    const effective = change.effective;
    if (effective === null) {
      continue;
    }
    const href = `#/change/c/${change.changeId}`;
    const shortId = change.changeId.slice(0, 8);
    if (effective.provenance === "inferred") {
      items.push({
        kind: "inferred-provenance",
        title: `inferred provenance on change c/${shortId}`,
        detail: effective.summary,
        href,
      });
    }
    const confidence = effective.reasoning?.confidence;
    if (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
      items.push({
        kind: "low-confidence",
        title: `low confidence (${confidence.toFixed(2)}) on change c/${shortId}`,
        detail: effective.summary,
        href,
      });
    }
  }

  return items;
}

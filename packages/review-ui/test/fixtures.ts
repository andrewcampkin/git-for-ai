// Synthetic ReportData shapes for the pure-logic tests. These mirror what runReport
// actually emits (see packages/cli/src/commands/report.test.ts) — the API contract the SPA
// renders. Types are imported types-only from the CLI package, so a drift in the contract
// fails typecheck here.

import type { LedgerEntry, ReportData, ReportTimelineRow } from "../src/types";

export function makeRow(overrides: Partial<ReportTimelineRow> = {}): ReportTimelineRow {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    subject: "a commit subject",
    authorName: "dev",
    authorEmail: "dev@example.test",
    authorDate: "2026-07-18T09:00:00+00:00",
    changeId: "0123456789abcdef0123456789abcdef",
    summary: "Ledger summary",
    hasIntent: true,
    summarySource: "ledger",
    badge: { kind: "agent", tool: "claude-code", model: "claude-opus-4-8", label: "agent · claude-code · claude-opus-4-8" },
    flags: { confidence: 0.82, scopeRisk: "medium", reversibility: "easy" },
    provenance: "agent-captured",
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: "0123456789abcdef0123456789abcdef",
    revision: "a".repeat(40),
    created_at: "2026-07-18T09:00:00Z",
    author: { type: "agent", tool: "claude-code", model: "claude-opus-4-8" },
    scope: [{ path: "src/a.ts", blob: "b".repeat(40) }],
    summary: "Ledger summary",
    session_ref: null,
    provenance: "agent-captured",
    ...overrides,
  } as LedgerEntry;
}

export function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    repoName: "fixture",
    generatedAt: "2026-07-18T10:00:00Z",
    range: {
      since: null,
      until: null,
      rev: null,
      newestCommitDate: "2026-07-18T09:00:00+00:00",
      oldestCommitDate: "2026-07-16T09:00:00+00:00",
    },
    totals: {
      commits: 0,
      changes: 0,
      agentCommits: 0,
      humanCommits: 0,
      mixedCommits: 0,
      noIntentCommits: 0,
      sessionsCaptured: 0,
      modelsSeen: [],
    },
    timeline: [],
    changes: [],
    warnings: [],
    ...overrides,
  };
}

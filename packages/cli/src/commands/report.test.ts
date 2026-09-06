// Integration tests for `git for-ai report` against a REAL temporary git repository —
// createFixtureRepo from @git-for-ai/core, never mocked — per the
// no-mocked-git testing rule. The tests exercise the structured ReportData assembly (the load-bearing
// logic) and spot-check the rendered HTML/Markdown strings.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LedgerEntry, SessionRecord } from "@git-for-ai/schemas";
import {
  appendLedgerEntry,
  assignChangeId,
  findEntryByCommitSha,
  writeSessionRecord,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runReport } from "./report.js";

const FAKE_BLOB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const INTENT_REF = "refs/notes/git-for-ai/intent";

function makeAgentEntry(params: {
  changeId: string;
  revision: string;
  summary: string;
  createdAt: string;
  sessionRef?: string;
}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: params.changeId,
    revision: params.revision,
    created_at: params.createdAt,
    author: { type: "agent", tool: "claude-code", model: "claude-opus-4-8" },
    scope: [{ path: "src/auth/session.ts", range: [40, 118], blob: FAKE_BLOB }],
    summary: params.summary,
    reasoning: {
      intent: "Make auth stateless so the API can run >1 replica",
      constraints: ["must not break existing /login clients"],
      rejected: [{ option: "Redis session store", why: "adds an infra dependency" }],
      confidence: 0.82,
      scope_risk: "medium",
      reversibility: "easy",
      tested: ["pnpm test auth", "manual: login/logout round-trip"],
    },
    session_ref: params.sessionRef ?? null,
    provenance: "agent-captured",
  };
}

function makeHumanEntry(changeId: string, revision: string): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: changeId,
    revision,
    created_at: "2026-07-18T11:00:00Z",
    author: { type: "human", human: "dev@example.test" },
    scope: [{ path: "docs/README.md", blob: FAKE_BLOB }],
    summary: "Document the signed-cookie rollout",
    session_ref: null,
    provenance: "human-authored",
  };
}

function makeSessionRecord(commitSha: string): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: "b1e2c3d4-5678-90ab-cdef-1234567890ab",
    agent: { tool: "claude-code", version: "2.x", model: "claude-opus-4-8" },
    captured_at: "2026-07-17T09:22:41Z",
    commit_range: { since: commitSha, until: commitSha },
    redaction: { applied: true, rules: [], redacted_count: 0, truncated_count: 0 },
    source_fingerprint: "claude-code-jsonl/2026.07",
    spans: [
      { span_id: "s1", kind: "agent.plan", body: { plan: "1. Do the thing" } },
      {
        span_id: "s2",
        parent_id: "s1",
        kind: "gen_ai.tool.execution",
        name: "Bash",
        attributes: { command: "pnpm test auth" },
        body: { exit: 0 },
      },
    ],
    summary: "Agent refactored auth to stateless signed-cookie sessions.",
  };
}

describe("runReport (real git fixture: agent change, human change, plain + corrupt commits)", () => {
  let repo: FixtureRepo;
  let shaPlain: string; // oldest: pre-git-for-ai, no identity, no ledger entry
  let shaAgent: string; // agent change: 2 entries (superseded + effective w/ session)
  let shaHuman: string; // human change: 1 human-authored entry, no session
  let shaCorrupt: string; // newest: a raw non-JSON intent note (unreadable)
  let cidAgent: string;
  let cidHuman: string;
  let sessionRef: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();

    shaPlain = await repo.commit("Initial scaffolding", {
      files: { "src/legacy/parser.ts": "export const legacy = true;\n" },
    });

    shaAgent = await repo.commit("agent commit (git subject, not the intent)", {
      files: { "src/auth/session.ts": "export const session = 1;\n" },
    });
    cidAgent = (await assignChangeId(shaAgent, { cwd: repo.dir })).changeId;
    sessionRef = (await writeSessionRecord(makeSessionRecord(shaAgent), { cwd: repo.dir }))
      .sessionRef;
    await appendLedgerEntry(
      cidAgent,
      makeAgentEntry({
        changeId: cidAgent,
        revision: shaAgent,
        summary: "Original (superseded) summary",
        createdAt: "2026-07-17T09:00:00Z",
      }),
      { cwd: repo.dir },
    );
    await appendLedgerEntry(
      cidAgent,
      makeAgentEntry({
        changeId: cidAgent,
        revision: shaAgent,
        summary: "Switch session store to signed-cookie tokens",
        createdAt: "2026-07-18T09:00:00Z",
        sessionRef,
      }),
      { cwd: repo.dir },
    );

    shaHuman = await repo.commit("human commit subject", {
      files: { "docs/README.md": "# readme\n" },
    });
    cidHuman = (await assignChangeId(shaHuman, { cwd: repo.dir })).changeId;
    await appendLedgerEntry(cidHuman, makeHumanEntry(cidHuman, shaHuman), { cwd: repo.dir });

    shaCorrupt = await repo.commit("commit with a corrupt note", {
      files: { "src/c.ts": "export const c = 1;\n" },
    });
    await repo.run([
      "notes",
      `--ref=${INTENT_REF}`,
      "add",
      "-m",
      "this is not JSON at all",
      shaCorrupt,
    ]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("computes honest header totals", async () => {
    const { data } = await runReport({ cwd: repo.dir });

    expect(data.totals).toEqual({
      commits: 4,
      changes: 2,
      agentCommits: 1,
      humanCommits: 1,
      mixedCommits: 0,
      noIntentCommits: 2, // the plain commit AND the unreadable-note commit
      sessionsCaptured: 1,
      modelsSeen: ["claude-opus-4-8"],
    });
    expect(data.range.newestCommitDate).toBe(data.timeline[0]!.authorDate);
    expect(data.range.oldestCommitDate).toBe(data.timeline[3]!.authorDate);
  });

  it("builds the timeline newest-first with explicit summary sources", async () => {
    const { data } = await runReport({ cwd: repo.dir });

    expect(data.timeline.map((row) => row.sha)).toEqual([
      shaCorrupt,
      shaHuman,
      shaAgent,
      shaPlain,
    ]);

    const [corrupt, human, agent, plain] = data.timeline;

    // Agent row: real ledger summary, badge, provenance, and all three flags.
    expect(agent).toMatchObject({
      changeId: cidAgent,
      summary: "Switch session store to signed-cookie tokens",
      hasIntent: true,
      summarySource: "ledger",
      provenance: "agent-captured",
      badge: { kind: "agent", tool: "claude-code", model: "claude-opus-4-8" },
      flags: { confidence: 0.82, scopeRisk: "medium", reversibility: "easy" },
    });
    expect(agent!.badge.label).toBe("agent · claude-code · claude-opus-4-8");

    // Human row.
    expect(human).toMatchObject({
      changeId: cidHuman,
      summary: "Document the signed-cookie rollout",
      hasIntent: true,
      summarySource: "ledger",
      provenance: "human-authored",
      badge: { kind: "human" },
      flags: {},
    });

    // Plain row: git subject shown, labeled — NEVER a fabricated summary.
    expect(plain).toMatchObject({
      changeId: null,
      summary: "Initial scaffolding",
      hasIntent: false,
      summarySource: "git-subject",
      badge: { kind: "none", label: "no reasoning recorded" },
    });
    expect(plain!.provenance).toBeUndefined();

    // Corrupt-note row: unreadable is labeled distinctly from absent, plus a warning.
    expect(corrupt).toMatchObject({
      summary: "commit with a corrupt note",
      hasIntent: false,
      summarySource: "git-subject-note-unreadable",
      badge: { kind: "none", label: "note unreadable" },
    });
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain(shaCorrupt);
    expect(data.warnings[0]).toContain("unreadable");
  });

  it("assembles per-change sections with effective + superseded entries and session evidence", async () => {
    const { data } = await runReport({ cwd: repo.dir });

    expect(data.changes.map((change) => change.changeId)).toEqual([cidHuman, cidAgent]);

    const agentChange = data.changes.find((change) => change.changeId === cidAgent)!;
    expect(agentChange.entries).toHaveLength(2);
    expect(agentChange.entries.map((row) => row.effective)).toEqual([false, true]);
    expect(agentChange.supersededCount).toBe(1);
    expect(agentChange.effective!.summary).toBe("Switch session store to signed-cookie tokens");
    expect(agentChange.effective!.reasoning).toMatchObject({
      intent: "Make auth stateless so the API can run >1 replica",
      constraints: ["must not break existing /login clients"],
      rejected: [{ option: "Redis session store", why: "adds an infra dependency" }],
      tested: ["pnpm test auth", "manual: login/logout round-trip"],
    });
    expect(agentChange.commits.map((commit) => commit.sha)).toEqual([shaAgent]);
    expect(agentChange.session).toMatchObject({
      ref: sessionRef,
      status: "available",
      agentTool: "claude-code",
      agentModel: "claude-opus-4-8",
      spanCount: 2,
      capturedAt: "2026-07-17T09:22:41Z",
    });

    const humanChange = data.changes.find((change) => change.changeId === cidHuman)!;
    expect(humanChange.entries).toHaveLength(1);
    expect(humanChange.supersededCount).toBe(0);
    expect(humanChange.session).toEqual({ ref: null, status: "none" });
  });

  it("never mints change-map rows for no-identity commits (read-only report)", async () => {
    await runReport({ cwd: repo.dir });
    const { data } = await runReport({ cwd: repo.dir });

    expect(data.timeline.find((row) => row.sha === shaPlain)!.changeId).toBeNull();
    expect(await findEntryByCommitSha(shaPlain, { cwd: repo.dir })).toBeNull();
  });

  it("honors maxCount", async () => {
    const { data } = await runReport({ cwd: repo.dir, maxCount: 1 });

    expect(data.timeline).toHaveLength(1);
    expect(data.timeline[0]!.sha).toBe(shaCorrupt);
    expect(data.totals.commits).toBe(1);
  });

  it("renders a self-contained HTML report with claim-next-to-evidence content", async () => {
    const { output } = await runReport({ cwd: repo.dir, format: "html" });

    // Skeleton + theming (dark and light) with no external requests.
    expect(output).toContain("<!doctype html>");
    expect(output).toContain("prefers-color-scheme: dark");
    expect(output).not.toMatch(/(src|href)=["']https?:/);
    expect(output).not.toContain("<script");

    // Header totals.
    expect(output).toContain("Agent activity report");
    expect(output).toContain("sessions captured");

    // Timeline: real summary, badge, flags; degraded rows labeled.
    expect(output).toContain("Switch session store to signed-cookie tokens");
    expect(output).toContain("agent · claude-code · claude-opus-4-8");
    expect(output).toContain("conf 0.82");
    expect(output).toContain("risk medium");
    expect(output).toContain("undo easy");
    expect(output).toContain("no reasoning recorded — showing the commit message");
    expect(output).toContain("note unreadable — showing the commit message");

    // Timeline links to the per-change detail section.
    expect(output).toContain(`href="#change-${cidAgent}"`);
    expect(output).toContain(`id="change-${cidAgent}"`);

    // Detail: intent, rejected, tested (evidence), scope, session line.
    expect(output).toContain("Make auth stateless so the API can run &gt;1 replica");
    expect(output).toContain("Redis session store");
    expect(output).toContain("pnpm test auth");
    expect(output).toContain("src/auth/session.ts");
    expect(output).toContain("2 spans");
    expect(output).toContain("no session captured"); // the human change, honestly labeled

    // Superseded entries collapsed (native <details>, no JS) but present.
    expect(output).toContain("<details class=\"superseded\">");
    expect(output).toContain("Original (superseded) summary");

    // The unreadable-note warning is visible.
    expect(output).toContain("Warnings");
  });

  it("renders the same content plainly as Markdown", async () => {
    const { output } = await runReport({ cwd: repo.dir, format: "md" });

    expect(output.startsWith("# Agent activity report —")).toBe(true);
    expect(output).toContain("- Commits: 4");
    expect(output).toContain("Switch session store to signed-cookie tokens");
    expect(output).toContain("no reasoning recorded — showing the commit message");
    expect(output).toContain("Rejected alternatives:");
    expect(output).toContain("Redis session store — adds an infra dependency");
    expect(output).toContain("`pnpm test auth`");
    expect(output).toContain("Superseded entries (1");
    expect(output).toContain("Original (superseded) summary");
    expect(output).toContain("## Warnings");
  });

  it("writes the report to the requested out path and returns it", async () => {
    const { output, path } = await runReport({
      cwd: repo.dir,
      out: join(".git-for-ai", "report.html"),
    });

    expect(path).toBe(join(repo.dir, ".git-for-ai", "report.html"));
    await access(path!);
    expect(await readFile(path!, "utf8")).toBe(output);
  });
});

describe("runReport degraded cases", () => {
  it("reports a dangling session_ref as unavailable with a reason, never as captured", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("dangling session commit", {
        files: { "src/a.ts": "export const a = 1;\n" },
      });
      const { changeId } = await assignChangeId(sha, { cwd: repo.dir });
      const dangling = `sha256:${"ab".repeat(32)}`;
      await appendLedgerEntry(
        changeId,
        makeAgentEntry({
          changeId,
          revision: sha,
          summary: "Entry with a dangling session pointer",
          createdAt: "2026-07-17T09:00:00Z",
          sessionRef: dangling,
        }),
        { cwd: repo.dir },
      );

      const { data, output } = await runReport({ cwd: repo.dir });

      const change = data.changes[0]!;
      expect(change.session.status).toBe("unavailable");
      expect(change.session.ref).toBe(dangling);
      expect(change.session.reason).toBeDefined();
      expect(data.totals.sessionsCaptured).toBe(0);
      expect(output).toContain("session trace unavailable");
    } finally {
      await repo.cleanup();
    }
  });

  it("renders an honest empty report for a repository with no commits", async () => {
    const repo = await createFixtureRepo();
    try {
      const { data, output } = await runReport({ cwd: repo.dir });

      expect(data.timeline).toEqual([]);
      expect(data.changes).toEqual([]);
      expect(data.totals.commits).toBe(0);
      expect(output).toContain("No commits in range.");
    } finally {
      await repo.cleanup();
    }
  });
});

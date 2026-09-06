// Integration tests for `git for-ai log --intent` against a REAL temporary
// git repository — createFixtureRepo from @git-for-ai/core, never mocked — per
// the no-mocked-git testing rule.
//
// The scripted history mirrors the CLI_REFERENCE.md example: some commits carry a real
// change-id + ledger entry (written through the real identity and ledger write paths in setup), others
// have nothing — and the output must render real intent summaries for the former and the
// honest `[no intent: pre-git-for-ai]` degradation (commit subject, em-dash change-id,
// never a fabricated summary) for the latter.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LedgerEntry } from "@git-for-ai/schemas";
import { appendLedgerEntry, assignChangeId } from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runLog } from "./log.js";

const FAKE_BLOB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function makeEntry(params: {
  changeId: string;
  revision: string;
  summary: string;
  confidence?: number;
  createdAt?: string;
  scopePath?: string;
}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: params.changeId,
    revision: params.revision,
    created_at: params.createdAt ?? "2026-07-17T09:22:41Z",
    author: { type: "agent", tool: "claude-code", model: "claude-opus-4-8" },
    scope: [{ path: params.scopePath ?? "src/auth/session.ts", blob: FAKE_BLOB }],
    summary: params.summary,
    ...(params.confidence !== undefined ? { reasoning: { confidence: params.confidence } } : {}),
    session_ref: null,
    provenance: "agent-captured",
  };
}

describe("runLog (real git fixture)", () => {
  let repo: FixtureRepo;
  let shaScaffold: string; // oldest: pre-git-for-ai, no change-id, no ledger entry
  let shaRateLimit: string; // middle: change-id + ledger entry (conf 0.74)
  let shaSessions: string; // newest: change-id + ledger entry (conf 0.82)
  let cidRateLimit: string;
  let cidSessions: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();

    // Commit dates are pinned so --since/--until can be tested deterministically.
    const dated = (iso: string) => ({
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    });

    shaScaffold = await repo.commit("Initial auth scaffolding", {
      files: { "src/legacy/parser.ts": "export const legacy = true;\n" },
      env: dated("2026-01-01T10:00:00Z"),
    });

    shaRateLimit = await repo.commit("rate limit commit (git subject, not the intent)", {
      files: { "src/auth/login.ts": "export const login = 1;\n" },
      env: dated("2026-02-01T10:00:00Z"),
    });
    cidRateLimit = (await assignChangeId(shaRateLimit, { cwd: repo.dir })).changeId;
    await appendLedgerEntry(
      cidRateLimit,
      makeEntry({
        changeId: cidRateLimit,
        revision: shaRateLimit,
        summary: "Add rate limiting to /login",
        confidence: 0.74,
        scopePath: "src/auth/login.ts",
      }),
      { cwd: repo.dir },
    );

    shaSessions = await repo.commit("session store commit (git subject, not the intent)", {
      files: { "src/auth/session.ts": "export const session = 1;\n" },
      env: dated("2026-03-01T10:00:00Z"),
    });
    cidSessions = (await assignChangeId(shaSessions, { cwd: repo.dir })).changeId;
    await appendLedgerEntry(
      cidSessions,
      makeEntry({
        changeId: cidSessions,
        revision: shaSessions,
        summary: "Switch session store to signed-cookie tokens",
        confidence: 0.82,
      }),
      { cwd: repo.dir },
    );
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("renders real intent summaries for commits with ledger entries, newest first", async () => {
    const result = await runLog({ cwd: repo.dir });

    expect(result.lines.map((l) => l.sha)).toEqual([shaSessions, shaRateLimit, shaScaffold]);

    const [sessions, rateLimit] = result.lines;
    expect(sessions).toMatchObject({
      sha: shaSessions,
      changeId: cidSessions,
      summary: "Switch session store to signed-cookie tokens",
      annotation: "agent, conf 0.82",
      hasIntent: true,
    });
    expect(rateLimit).toMatchObject({
      changeId: cidRateLimit,
      summary: "Add rate limiting to /login",
      annotation: "agent, conf 0.74",
      hasIntent: true,
    });

    // Rendered output: short SHA, abbreviated change-id, ledger summary, annotation —
    // the CLI_REFERENCE.md line shape.
    const rendered = result.output.split("\n");
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toMatch(
      new RegExp(
        `^${sessions!.shortSha}\\s{2,}${cidSessions.slice(0, 8)}\\s{2,}` +
          `Switch session store to signed-cookie tokens\\s+\\[agent, conf 0\\.82\\]$`,
      ),
    );
    expect(rendered[1]).toContain("Add rate limiting to /login");
    expect(rendered[1]).toContain("[agent, conf 0.74]");
    // The intent summary shown is the ledger's, not the commit message.
    expect(result.output).not.toContain("session store commit (git subject, not the intent)");
    expect(result.output).not.toContain("rate limit commit (git subject, not the intent)");
  });

  it("degrades honestly for a commit with no ledger entry: subject line, em-dash, no fabrication", async () => {
    const result = await runLog({ cwd: repo.dir });

    const scaffold = result.lines[2]!;
    expect(scaffold).toMatchObject({
      sha: shaScaffold,
      changeId: null,
      summary: "Initial auth scaffolding", // the commit's own subject — git metadata only
      annotation: "no intent: pre-git-for-ai",
      hasIntent: false,
    });

    const renderedScaffoldLine = result.output.split("\n")[2]!;
    expect(renderedScaffoldLine).toMatch(
      new RegExp(
        `^${scaffold.shortSha}\\s{2,}—\\s{2,}Initial auth scaffolding\\s+` +
          `\\[no intent: pre-git-for-ai\\]$`,
      ),
    );
  });

  it("does not mint change-map rows for pre-git-for-ai commits as a side effect", async () => {
    await runLog({ cwd: repo.dir });
    await runLog({ cwd: repo.dir });

    // After repeated log walks the no-identity commit still resolves to "no identity" —
    // i.e. the walk never wrote an orphan/inferred row for it into the change-map.
    const result = await runLog({ cwd: repo.dir });
    expect(result.lines[2]!.changeId).toBeNull();
  });

  it("honors -n <N>", async () => {
    const result = await runLog({ cwd: repo.dir, maxCount: 2 });
    expect(result.lines.map((l) => l.sha)).toEqual([shaSessions, shaRateLimit]);
  });

  it("honors a <path> scope argument", async () => {
    const result = await runLog({ cwd: repo.dir, path: "src/auth" });
    expect(result.lines.map((l) => l.sha)).toEqual([shaSessions, shaRateLimit]);

    const legacyOnly = await runLog({ cwd: repo.dir, path: "src/legacy" });
    expect(legacyOnly.lines.map((l) => l.sha)).toEqual([shaScaffold]);
    expect(legacyOnly.lines[0]!.annotation).toBe("no intent: pre-git-for-ai");
  });

  it("honors --since/--until (pinned commit dates)", async () => {
    const since = await runLog({ cwd: repo.dir, since: "2026-01-15T00:00:00Z" });
    expect(since.lines.map((l) => l.sha)).toEqual([shaSessions, shaRateLimit]);

    const until = await runLog({ cwd: repo.dir, until: "2026-02-15T00:00:00Z" });
    expect(until.lines.map((l) => l.sha)).toEqual([shaRateLimit, shaScaffold]);
  });

  it("honors --change: full change-id in place of the SHA column", async () => {
    const result = await runLog({ cwd: repo.dir, change: true });
    const rendered = result.output.split("\n");

    expect(rendered[0]!.startsWith(cidSessions)).toBe(true);
    expect(rendered[1]!.startsWith(cidRateLimit)).toBe(true);
    expect(rendered[2]!.startsWith("—")).toBe(true);
    // The SHA column is replaced, not duplicated.
    expect(rendered[0]).not.toContain(result.lines[0]!.shortSha);
  });
});

describe("runLog effective-entry resolution (append-only corrections)", () => {
  it("shows the newest appended entry's summary, not the original", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("corrected commit", {
        files: { "src/thing.ts": "export const thing = 1;\n" },
      });
      const { changeId } = await assignChangeId(sha, { cwd: repo.dir });

      await appendLedgerEntry(
        changeId,
        makeEntry({
          changeId,
          revision: sha,
          summary: "Original (superseded) summary",
          createdAt: "2026-07-17T09:00:00Z",
        }),
        { cwd: repo.dir },
      );
      await appendLedgerEntry(
        changeId,
        makeEntry({
          changeId,
          revision: sha,
          summary: "Corrected summary after review",
          confidence: 0.9,
          createdAt: "2026-07-18T09:00:00Z",
        }),
        { cwd: repo.dir },
      );

      const result = await runLog({ cwd: repo.dir });
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatchObject({
        changeId,
        summary: "Corrected summary after review",
        annotation: "agent, conf 0.90",
        hasIntent: true,
      });
      expect(result.output).toContain("Corrected summary after review");
      expect(result.output).not.toContain("Original (superseded) summary");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runLog edge cases", () => {
  it("returns an empty result for a repo with no commits yet", async () => {
    const repo = await createFixtureRepo();
    try {
      const result = await runLog({ cwd: repo.dir });
      expect(result.lines).toEqual([]);
      expect(result.output).toBe("");
    } finally {
      await repo.cleanup();
    }
  });
});

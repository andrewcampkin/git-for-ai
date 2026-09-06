// Integration tests for `git for-ai export` against REAL fixture repos (never mocked):
// the Agent Trace wire-format export (ARCHITECTURE.md §3.1) and the pr-comment markdown
// export. Export is a read — one test pins the non-minting
// guarantee.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLedgerEntry,
  upsertChangeMapEntries,
  writeSessionRecord,
  readAllChangeMapEntries,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";
import type { ChangeMapEntry, LedgerEntry, SessionRecord } from "@git-for-ai/schemas";

import { runExport } from "./export.js";

const CHANGE_ID = "9f2c1a7b6e4d0f83c5a1b2d3e4f50617";
const OTHER_CHANGE_ID = "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4";

function makeEntry(revision: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: CHANGE_ID,
    revision,
    created_at: "2026-07-17T09:22:41Z",
    author: { type: "agent", tool: "claude-code", model: "claude-fable-5" },
    scope: [
      {
        path: "src/auth/session.ts",
        range: [40, 118],
        blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
      },
      { path: "src/auth/session.ts", range: [200, 210], blob: "bf19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f" },
      { path: "README.md", blob: "cf19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f" },
    ],
    summary: "Switch session store to signed-cookie tokens.",
    reasoning: {
      intent: "Stateless auth for multi-replica deploys.",
      rejected: [{ option: "Redis session store", why: "new infra dependency" }],
      tested: ["pnpm test auth"],
      confidence: 0.82,
      scope_risk: "medium",
      reversibility: "easy",
    },
    session_ref: null,
    provenance: "agent-captured",
    ...overrides,
  };
}

function makeMapEntry(overrides: Partial<ChangeMapEntry> & { change_id: string; head: string }): ChangeMapEntry {
  return {
    schema: "git-for-ai/change-map-entry@1",
    history: [overrides.head],
    trailer_seen: true,
    origin: "post-commit",
    updated_at: "2026-07-17T09:22:41Z",
    ...overrides,
  };
}

function makeSession(id: string): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: id,
    agent: { tool: "claude-code", version: "2.0.0", model: "claude-fable-5" },
    captured_at: "2026-07-17T09:22:41Z",
    commit_range: { since: "a".repeat(40), until: "b".repeat(40) },
    redaction: { applied: true, redacted_count: 0, rules: ["builtin@1"] },
    source_fingerprint: "claude-code-jsonl@1",
    spans: [
      { span_id: "s1", kind: "agent.plan", name: "plan" },
      { span_id: "s2", kind: "gen_ai.tool.execution", name: "Bash" },
    ],
  };
}

describe("export (real git fixture)", () => {
  let repo: FixtureRepo;
  let sha: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // ── agent-trace ─────────────────────────────────────────────────────────────

  it("exports one Agent Trace record per change from the effective entry", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    const superseding = makeEntry(sha, {
      created_at: "2026-07-17T11:00:00Z",
      summary: "Corrected summary.",
    });
    await appendLedgerEntry(CHANGE_ID, superseding, { cwd: repo.dir });

    const sha2 = await repo.commit("second", { files: { "b.txt": "b" } });
    await appendLedgerEntry(
      OTHER_CHANGE_ID,
      makeEntry(sha2, { change_id: OTHER_CHANGE_ID, summary: "Second change." }),
      { cwd: repo.dir },
    );

    const result = await runExport({ cwd: repo.dir });
    expect(result.exitCode).toBe(0);
    expect(result.records).toHaveLength(2);

    const record = result.records!.find((r) => r.metadata.git_for_ai.change_id === CHANGE_ID)!;
    // Envelope per the agent-trace.dev v0.1.0 shape.
    expect(record.version).toBe("0.1.0");
    expect(record.id).toBe("9f2c1a7b-6e4d-0f83-c5a1-b2d3e4f50617"); // change-id as UUID
    expect(record.timestamp).toBe("2026-07-17T11:00:00Z"); // the EFFECTIVE entry
    expect(record.vcs).toEqual({ type: "git", revision: sha });
    expect(record.tool).toEqual({ name: "claude-code" });
    expect(record.metadata.git_for_ai.summary).toBe("Corrected summary.");
    expect(record.metadata.git_for_ai.provenance).toBe("agent-captured");
    expect(record.metadata.git_for_ai.reasoning?.rejected?.[0]?.option).toBe(
      "Redis session store",
    );

    // Files: ranges grouped per path; whole-file scope yields no ranges.
    const authFile = record.files.find((f) => f.path === "src/auth/session.ts")!;
    expect(authFile.conversations[0]!.contributor).toEqual({
      type: "ai",
      model_id: "anthropic/claude-fable-5",
    });
    expect(authFile.conversations[0]!.ranges).toEqual([
      {
        start_line: 40,
        end_line: 118,
        content_hash: "git-blob:af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
      },
      {
        start_line: 200,
        end_line: 210,
        content_hash: "git-blob:bf19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
      },
    ]);
    const readme = record.files.find((f) => f.path === "README.md")!;
    expect(readme.conversations[0]!.ranges).toEqual([]);

    // The rendered output is a valid JSON array of the same records.
    expect(JSON.parse(result.output)).toHaveLength(2);
  });

  it("carries the session pointer as a related link", async () => {
    const { sessionRef } = await writeSessionRecord(makeSession("s"), { cwd: repo.dir });
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha, { session_ref: sessionRef }), {
      cwd: repo.dir,
    });

    const result = await runExport({ cwd: repo.dir });
    const conversation = result.records![0]!.files[0]!.conversations[0]!;
    expect(conversation.related).toEqual([
      { type: "session", url: `git-for-ai:session/${sessionRef}` },
    ]);
  });

  it("skips folded (squash-absorbed) changes", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    const sha2 = await repo.commit("pre-squash commit", { files: { "b.txt": "b" } });
    await appendLedgerEntry(
      OTHER_CHANGE_ID,
      makeEntry(sha2, {
        change_id: OTHER_CHANGE_ID,
        folded_into: CHANGE_ID,
        summary: "Absorbed.",
      }),
      { cwd: repo.dir },
    );

    const result = await runExport({ cwd: repo.dir });
    expect(result.records!.map((r) => r.metadata.git_for_ai.change_id)).toEqual([CHANGE_ID]);
  });

  it("narrows to one change with a target, and --out writes the file", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    const sha2 = await repo.commit("second", { files: { "b.txt": "b" } });
    await appendLedgerEntry(
      OTHER_CHANGE_ID,
      makeEntry(sha2, { change_id: OTHER_CHANGE_ID, summary: "Second change." }),
      { cwd: repo.dir },
    );

    const outPath = join(repo.dir, "trace.json");
    const result = await runExport({ cwd: repo.dir, target: sha2, out: outPath });
    expect(result.records).toHaveLength(1);
    expect(result.records![0]!.metadata.git_for_ai.change_id).toBe(OTHER_CHANGE_ID);
    expect(result.path).toBe(outPath);
    expect(JSON.parse(await readFile(outPath, "utf8"))).toHaveLength(1);
  });

  it("an empty repo exports an empty array (exit 0)", async () => {
    const result = await runExport({ cwd: repo.dir });
    expect(result.records).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual([]);
  });

  // ── pr-comment ──────────────────────────────────────────────────────────────

  it("renders a pr-comment for HEAD's change with claim + evidence", async () => {
    const { sessionRef } = await writeSessionRecord(makeSession("s"), { cwd: repo.dir });
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha, { session_ref: sessionRef }), {
      cwd: repo.dir,
    });
    await upsertChangeMapEntries([makeMapEntry({ change_id: CHANGE_ID, head: sha })], {
      cwd: repo.dir,
    });

    const result = await runExport({ cwd: repo.dir, format: "pr-comment" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("### Agent change record");
    expect(result.output).toContain("change `c/9f2c1a7b`");
    expect(result.output).toContain("**Switch session store to signed-cookie tokens.**");
    expect(result.output).toContain("- **Author:** agent · claude-code · claude-fable-5 (agent-captured)");
    expect(result.output).toContain("- **Intent:** Stateless auth for multi-replica deploys.");
    expect(result.output).toContain("Redis session store — new infra dependency");
    expect(result.output).toContain("`pnpm test auth`");
    expect(result.output).toContain("confidence 0.82 · risk medium · undo easy");
    expect(result.output).toContain("2 spans captured");
  });

  it("pr-comment shows superseded-entry count and marks the effective claim", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    await appendLedgerEntry(
      CHANGE_ID,
      makeEntry(sha, { created_at: "2026-07-17T11:00:00Z", summary: "Corrected." }),
      { cwd: repo.dir },
    );

    const result = await runExport({ cwd: repo.dir, format: "pr-comment", target: sha });
    expect(result.output).toContain("**Corrected.**");
    expect(result.output).toContain("1 superseded entry retained");
  });

  it("pr-comment for a commit with no captured intent is honest and exits 2", async () => {
    const result = await runExport({ cwd: repo.dir, format: "pr-comment" });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("No captured intent exists for this change");
    expect(result.output).toContain("first commit"); // the git subject, labeled as such
    expect(result.output).toContain("*(commit subject)*");
  });

  it("export never mints identity (non-minting read)", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    await runExport({ cwd: repo.dir });
    await runExport({ cwd: repo.dir, format: "pr-comment" });
    expect(await readAllChangeMapEntries({ cwd: repo.dir })).toEqual([]);
  });

  it("rejects an unknown format", async () => {
    await expect(
      runExport({ cwd: repo.dir, format: "sarif" as unknown as "agent-trace" }),
    ).rejects.toThrow(/unknown export format/);
  });
});

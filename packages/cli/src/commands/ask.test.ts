// Tests for `git for-ai ask` (./ask.ts) — M12 — against a REAL fixture repo (the
// no-mocks rule, CLI_PLAN.md §4) whose index is built by the REAL runReindex pipeline
// with the deterministic BagOfWordsEmbedder (token-overlap vectors, so ranking
// assertions are meaningful; the real model is NEVER loaded in tests). The Anthropic
// HTTP layer is mocked through the sanctioned fetchImpl seam, and every test pins
// apiKey explicitly so a developer's real GIT_FOR_AI_ANTHROPIC_KEY can never leak in.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appendLedgerEntry, assignChangeId, writeSessionRecord } from "@git-for-ai/core";
import {
  BagOfWordsEmbedder,
  createFixtureRepo,
  makeLedgerEntry,
  makeSessionRecord,
  type FixtureRepo,
} from "@git-for-ai/core/testing";

import { runInit } from "./init.js";
import { runReindex } from "./reindex.js";
import { runAsk } from "./ask.js";

const AUTH_FILE = "src/auth/session.ts";
const QUESTION = "why don't we use redis for sessions";

let repo: FixtureRepo;
const embedder = new BagOfWordsEmbedder();
let changeId: string;

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };

  await runInit({ cwd: repo.dir, claudeHooks: false });
  const sha = await repo.commit("Move session state to signed cookies", {
    files: {
      [AUTH_FILE]: "export function signSessionCookie() {}\n",
      "src/config/toml.ts": "export function parseTomlScalar(raw: string) { return raw; }\n",
    },
  });
  ({ changeId } = await assignChangeId(sha, ctx));
  const blob = (await repo.run(["rev-parse", `${sha}:${AUTH_FILE}`])).stdout;
  const { sessionRef } = await writeSessionRecord(
    makeSessionRecord({
      sessionId: "sess-ask-cli",
      capturedAt: "2026-07-17T10:00:00Z",
      sinceSha: sha,
      untilSha: sha,
      summary: "Agent replaced the in-process session map with signed cookies",
    }),
    ctx,
  );
  await appendLedgerEntry(
    changeId,
    makeLedgerEntry({
      changeId,
      revision: sha,
      createdAt: "2026-07-17T10:00:00Z",
      summary: "Move session state to signed cookies",
      scopePath: AUTH_FILE,
      scopeBlob: blob,
      sessionRef,
      intent: "run more than one replica without sticky sessions",
      rejectedOption: "Redis session store",
      rejectedWhy: "avoid adding an infra dependency",
      confidence: 0.82,
    }),
    ctx,
  );

  // The real M10 pipeline builds the index (code + ledger + session, one space).
  await runReindex({ cwd: repo.dir, embedder });
});

afterAll(async () => {
  await repo.cleanup();
});

describe("runAsk — degraded ranked-raw-sources mode (no API key)", () => {
  it("renders the ranked sources with an honest no-key note, exit 0", async () => {
    const fetchImpl = vi.fn();
    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.exitCode).toBe(0);
    expect(result.data.sources[0]!.chunk.key).toBe(`ledger:${changeId}`);
    expect(result.data.synthesis.skippedReason).toBe("no-api-key");
    expect(result.data.confidence).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(result.output).toContain("No synthesized answer: no API key configured");
    expect(result.output).toContain("GIT_FOR_AI_ANTHROPIC_KEY");
    expect(result.output).toContain(`[1] ledger ${changeId.slice(0, 8)}`);
    expect(result.output).toContain(`${AUTH_FILE}:1-5`);
    expect(result.output).toContain("(agent-captured)");
    // The raw-sources view carries the actual content — genuinely useful, per plan.
    expect(result.output).toContain("Move session state to signed cookies");
    expect(result.output).toContain("rejected: Redis session store — avoid adding an infra dependency");
  });
});

describe("runAsk — synthesized answer (mocked Anthropic HTTP)", () => {
  it("renders the §9.1 shape: Answer / Sources / Confidence with [n] citations", async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "Redis was explicitly rejected to avoid an infra dependency [1]; the session confirms the switch [2].",
              },
            ],
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 30 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.exitCode).toBe(0);
    expect(result.data.synthesis.synthesized).toBe(true);
    expect(result.data.synthesis.citedSources).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledOnce();

    expect(result.output).toMatch(/^Answer \(from .*ledger entr/);
    expect(result.output).toContain("Redis was explicitly rejected");
    expect(result.output).toContain("Sources:");
    expect(result.output).toContain(`[1] ledger ${changeId.slice(0, 8)}`);
    // Deterministic retrieval-signal confidence, never model-claimed.
    expect(result.output).toMatch(/Confidence: (high|medium) \(/);
    expect(result.data.confidence).toBeDefined();
  });
});

describe("runAsk — flags", () => {
  it("--sources-only never calls the API and says why there is no prose", async () => {
    const fetchImpl = vi.fn();
    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      sourcesOnly: true,
      synthesis: { apiKey: "would-not-be-used", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.data.synthesis.skippedReason).toBe("not-requested");
    expect(result.output).toContain("Synthesis skipped (--sources-only)");
    expect(result.output).toContain("[1] ledger");
  });

  it("--k caps the source count", async () => {
    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      k: 1,
      synthesis: { apiKey: "" },
    });
    expect(result.data.sources).toHaveLength(1);
  });

  it("--until before all records yields the honest empty answer, exit 2", async () => {
    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      until: "2020-01-01",
      synthesis: { apiKey: "" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.data.sources).toHaveLength(0);
    expect(result.output).toContain("No sources found");
  });

  it("--since keeps dated records and drops undated code chunks", async () => {
    const result = await runAsk(QUESTION, {
      cwd: repo.dir,
      embedder,
      since: "2026-01-01",
      synthesis: { apiKey: "" },
    });
    expect(result.data.sources.length).toBeGreaterThan(0);
    expect(result.data.sources.every((source) => source.chunk.kind !== "code")).toBe(true);
    expect(result.data.sources[0]!.chunk.key).toBe(`ledger:${changeId}`);
  });

  it("rejects malformed flags loudly", async () => {
    await expect(runAsk(QUESTION, { cwd: repo.dir, embedder, k: 0 })).rejects.toThrow(/--k/);
    await expect(
      runAsk(QUESTION, { cwd: repo.dir, embedder, since: "not-a-date" }),
    ).rejects.toThrow(/--since/);
    await expect(runAsk("   ", { cwd: repo.dir, embedder })).rejects.toThrow(/non-empty/);
  });
});

describe("runAsk — index readiness (actionable errors, staleness warning)", () => {
  it("names `git for-ai init` for an uninitialized repository", async () => {
    const bare = await createFixtureRepo();
    try {
      await bare.commit("Initial", { files: { "a.txt": "hello\n" } });
      await expect(runAsk("anything", { cwd: bare.dir, embedder })).rejects.toThrow(
        /git for-ai init/,
      );
    } finally {
      await bare.cleanup();
    }
  });

  it("names `git for-ai reindex` when the index was never built", async () => {
    const fresh = await createFixtureRepo();
    try {
      await fresh.commit("Initial", { files: { "a.txt": "hello\n" } });
      await runInit({ cwd: fresh.dir, claudeHooks: false });
      await expect(runAsk("anything", { cwd: fresh.dir, embedder })).rejects.toThrow(
        /git for-ai reindex/,
      );
    } finally {
      await fresh.cleanup();
    }
  });

  it("warns (but answers) when HEAD moved past the index", async () => {
    await repo.commit("Unindexed follow-up", { files: { "notes.txt": "later\n" } });
    try {
      const result = await runAsk(QUESTION, {
        cwd: repo.dir,
        embedder,
        synthesis: { apiKey: "" },
      });
      expect(result.data.sources.length).toBeGreaterThan(0);
      expect(result.data.warnings.some((warning) => warning.includes("stale"))).toBe(true);
      expect(result.output).toContain("! ");
    } finally {
      // Re-sync the index so later tests (file order) see a current one again.
      await runReindex({ cwd: repo.dir, embedder });
    }
  });
});

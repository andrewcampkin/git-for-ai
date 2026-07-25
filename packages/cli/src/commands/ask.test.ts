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

// ── The tool loop, end to end (architecture/ASK_TOOLS.md) ────────────────────
//
// The live failure: "tell me what changed in the last commit" got "I cannot answer this
// question from the provided sources", because the only thing the model ever saw for
// HEAD was its eleven-word summary line. Here the model asks for the diff instead, and
// what comes back is a REAL patch read from a REAL repository — only the model's side of
// the conversation is scripted.

describe("runAsk — synthesis reads the repository for itself", () => {
  it("runs the tool the model asks for and feeds the real diff back", async () => {
    const head = (await repo.run(["rev-parse", "HEAD"])).stdout;
    const subject = (await repo.run(["log", "-1", "--format=%s"])).stdout;
    const bodies = [
      {
        content: [{ type: "tool_use", id: "toolu_1", name: "commit_diff", input: { sha: "HEAD" } }],
        model: "claude-sonnet-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 40 },
      },
      {
        content: [{ type: "text", text: `The last commit (${subject}) changed notes.txt.` }],
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 400, output_tokens: 25 },
      },
    ];
    let index = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const body = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await runAsk("tell me what changed in the last commit", {
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Request 1 declared the four v1 tools.
    const first = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect((first["tools"] as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      "blame_why",
      "commit_diff",
      "log_intent",
      "show_change",
    ]);

    // Request 2 carries the ACTUAL patch, read from the real repository.
    const second = JSON.parse(
      (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    const messages = second["messages"] as Array<{ role: string; content: unknown }>;
    const toolResult = (messages[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(toolResult["tool_use_id"]).toBe("toolu_1");
    const patch = toolResult["content"] as string;
    expect(patch).toContain(`commit ${head}`);
    expect(patch).toContain("notes.txt");

    // Provenance is carried on the result and rendered for the reader.
    expect(result.data.synthesis.toolCalls).toEqual([
      { name: "commit_diff", input: { sha: "HEAD" }, ok: true, chars: patch.length },
    ]);
    expect(result.output).toContain("Consulted:");
    expect(result.output).toContain("git show HEAD");
    expect(result.output).toContain("Confidence: high (read directly from the repository");
    // Usage is summed across both round trips — one answer, two requests.
    expect(result.data.synthesis.usage).toEqual({ inputTokens: 600, outputTokens: 65 });
  });

  it("surfaces a failed read instead of hiding it, and still answers", async () => {
    const bodies = [
      {
        content: [
          { type: "tool_use", id: "toolu_1", name: "commit_diff", input: { sha: "nope-not-a-commit" } },
        ],
        model: "claude-sonnet-5",
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "That commit is not in this repository." }],
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
      },
    ];
    let index = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const body = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await runAsk("what changed in nope-not-a-commit", {
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.data.synthesis.synthesized).toBe(true);
    expect(result.data.synthesis.toolCalls?.[0]?.ok).toBe(false);
    expect(result.output).toContain("git show nope-not-a-commit — failed:");
    // A failed read is not evidence: confidence falls back to the retrieval signals.
    expect(result.output).not.toContain("read directly from the repository");
  });

  it("--sources-only stays fully local: no API call, no tools", async () => {
    const fetchImpl = vi.fn();
    const result = await runAsk("what changed in the last commit", {
      cwd: repo.dir,
      embedder,
      sourcesOnly: true,
      synthesis: { apiKey: "would-not-be-used", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.data.synthesis.toolCalls).toBeUndefined();
  });

  it("says so when the answer never stopped reading, rather than inventing one", async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            content: [
              { type: "tool_use", id: "toolu_x", name: "log_intent", input: { n: 5 } },
            ],
            model: "claude-sonnet-5",
            stop_reason: "tool_use",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await runAsk("what changed in the last commit", {
      cwd: repo.dir,
      embedder,
      synthesis: {
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxToolIterations: 2,
      },
    });

    expect(result.data.synthesis.synthesized).toBe(false);
    expect(result.data.synthesis.skippedReason).toBe("tool-iteration-cap");
    expect(result.output).toContain("hit the read limit");
    // The ranked sources still stand on their own, and the reads are still shown.
    expect(result.output).toMatch(/\[\d+\] ledger /);
    expect(result.output).toContain("Consulted:");
    expect(result.data.synthesis.toolCalls).toHaveLength(2);
  });
});

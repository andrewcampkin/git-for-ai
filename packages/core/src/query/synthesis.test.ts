// Synthesis tests — the Anthropic HTTP layer is MOCKED via the injectable
// fetchImpl (the one place mocking the external dependency is sanctioned:
// the point under test is prompt construction, citation mapping,
// and fallback behavior — not Claude's output quality). No network, no API key,
// no model is ever touched.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredChunk } from "../embeddings/store.js";
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_SYNTHESIS_MODEL,
  SYNTHESIS_MODEL_ENV,
  buildSynthesisPrompt,
  extractCitations,
  synthesizeAnswer,
  type SynthesisTool,
} from "./synthesis.js";
import type { EnrichedSource } from "./types.js";
import { makeLedgerEntry, makeSessionRecord } from "./testSupport.js";

const CHANGE_ID = "9f2c1a7b9f2c1a7b9f2c1a7b9f2c1a7b";
const SESSION_REF = "sha256:" + "1f".repeat(32);
const SHA = "a".repeat(40);

function chunk(key: string, extra: Partial<StoredChunk> = {}): StoredChunk {
  return {
    key,
    kind: "code",
    text: `text of ${key}`,
    path: null,
    blobSha: null,
    nodePath: null,
    startLine: null,
    endLine: null,
    changeId: null,
    sessionRef: null,
    ...extra,
  };
}

function source(rank: number, c: StoredChunk, extra: Partial<EnrichedSource> = {}): EnrichedSource {
  return {
    rank,
    score: 1 / rank,
    chunk: c,
    matchedBy: ["vector"],
    changeMapEntry: null,
    ledgerEntry: null,
    sessionRecord: null,
    ...extra,
  };
}

const ledgerSource = source(
  1,
  chunk(`ledger:${CHANGE_ID}`, {
    kind: "ledger",
    text: "Move session state to signed cookies\nRejected: Redis session store — avoid infra dependency",
    changeId: CHANGE_ID,
    sessionRef: SESSION_REF,
  }),
  {
    ledgerEntry: makeLedgerEntry({
      changeId: CHANGE_ID,
      revision: SHA,
      createdAt: "2026-07-17T10:00:00Z",
      summary: "Move session state to signed cookies",
      scopePath: "src/auth/session.ts",
      scopeBlob: SHA,
    }),
  },
);

const sessionSource = source(
  2,
  chunk(`session:${"1f".repeat(32)}`, {
    kind: "session",
    text: "Agent replaced the in-process session map with signed cookies",
    sessionRef: SESSION_REF,
  }),
  {
    sessionRecord: makeSessionRecord({
      sessionId: "sess-1",
      capturedAt: "2026-07-17T10:00:00Z",
      sinceSha: SHA,
      untilSha: SHA,
    }),
  },
);

const codeSource = source(
  3,
  chunk("blob:src/auth/session.ts#0", {
    kind: "code",
    text: "export function signSessionCookie() {}",
    path: "src/auth/session.ts",
    startLine: 40,
    endLine: 118,
  }),
);

const SOURCES = [ledgerSource, sessionSource, codeSource];

/** A fetch mock returning a canned Anthropic /v1/messages response. */
function anthropicFetch(body: unknown, status = 200) {
  return vi.fn(async (): Promise<Response> => {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

const okBody = (text: string) => ({
  content: [{ type: "text", text }],
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 120, output_tokens: 34 },
});

/** A `tool_use` turn: what the API returns when the model wants a repository read. */
const toolUseBody = (
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  extraContent: unknown[] = [],
) => ({
  content: [
    ...extraContent,
    ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
  ],
  model: "claude-sonnet-5",
  stop_reason: "tool_use",
  usage: { input_tokens: 200, output_tokens: 40 },
});

/** A fetch mock walking a scripted sequence of response bodies (the tool loop needs several). */
function sequenceFetch(bodies: unknown[]) {
  let index = 0;
  return vi.fn(async (): Promise<Response> => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Parse the request body of the nth (0-based) call to a fetch mock. */
function requestBody(fetchImpl: ReturnType<typeof sequenceFetch>, n: number): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[n] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** A tool whose calls are recorded, returning canned text (or throwing). */
function fakeTool(
  name: string,
  behavior: (input: Record<string, unknown>) => string,
): SynthesisTool & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: "object", properties: { target: { type: "string" } } },
    calls,
    async run(input) {
      calls.push(input);
      return behavior(input);
    },
  };
}

afterEach(() => {
  delete process.env[SYNTHESIS_MODEL_ENV];
  vi.restoreAllMocks();
});

describe("buildSynthesisPrompt", () => {
  it("numbers sources in rank order with kind-appropriate headers", () => {
    const prompt = buildSynthesisPrompt("why not redis", SOURCES);
    expect(prompt.system).toContain("Cite every claim");
    expect(prompt.user).toContain("Question: why not redis");
    // Ledger header: number, kind, short change-id, provenance + timestamp.
    expect(prompt.user).toContain("[1] ledger change c/9f2c1a7b (agent-captured, 2026-07-17T10:00:00Z)");
    // Session header: number, kind, short ref, agent tool + capture time.
    expect(prompt.user).toContain("[2] session sha256:1f1f1f (claude-code, 2026-07-17T10:00:00Z)");
    // Code header: number, kind, path:lines.
    expect(prompt.user).toContain("[3] code src/auth/session.ts:40-118");
    // The indexed text itself is what the model reads.
    expect(prompt.user).toContain("Rejected: Redis session store");
    // Order is rank order.
    expect(prompt.user.indexOf("[1] ledger")).toBeLessThan(prompt.user.indexOf("[2] session"));
  });

  it("renders the ledger entry's scope — the per-file record of WHAT changed (§6)", () => {
    // The bug this fixes: scope was retrieved and then never shown to the model, so a
    // "what changed" question saw only the summary line and was answered "I can't tell".
    const prompt = buildSynthesisPrompt("what changed", SOURCES);
    expect(prompt.user).toContain("Files changed (1):");
    expect(prompt.user).toContain("src/auth/session.ts:1-5");
  });

  it("adds the tool instructions only when tools are available", () => {
    expect(buildSynthesisPrompt("q", SOURCES).system).not.toContain("tools that read this repository");
    const withTools = buildSynthesisPrompt("q", SOURCES, [fakeTool("show_change", () => "x")]);
    expect(withTools.system).toContain("tools that read this repository");
    expect(withTools.system).toContain("Never say you lack the information");
    // The citation contract survives — tool results are the addition, not a replacement.
    expect(withTools.system).toContain("Cite every claim");
  });
});

describe("extractCitations", () => {
  it("dedupes, preserves first-appearance order, drops out-of-range markers", () => {
    expect(extractCitations("Because [2] and [1], see [2]; bogus [7] [0]", 3)).toEqual([2, 1]);
  });
});

describe("synthesizeAnswer", () => {
  it("falls back cleanly when no API key is configured — never an error", async () => {
    const fetchImpl = anthropicFetch(okBody("unused"));
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "", fetchImpl });
    expect(result).toEqual({
      synthesized: false,
      answer: null,
      citedSources: [],
      skippedReason: "no-api-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prefers the tool-scoped GIT_FOR_AI_ANTHROPIC_KEY env var over ANTHROPIC_API_KEY", async () => {
    // The scoped var exists so users never need a global ANTHROPIC_API_KEY that other
    // tools (Claude Code itself included) would also detect and bill against.
    vi.stubEnv("GIT_FOR_AI_ANTHROPIC_KEY", "scoped-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "global-key");
    try {
      const fetchImpl = anthropicFetch(okBody("answer [1]"));
      const result = await synthesizeAnswer("q", SOURCES, { fetchImpl });
      expect(result.synthesized).toBe(true);
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("scoped-key");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips when there is nothing to synthesize from", async () => {
    const fetchImpl = anthropicFetch(okBody("unused"));
    const result = await synthesizeAnswer("q", [], { apiKey: "k", fetchImpl });
    expect(result.skippedReason).toBe("no-sources");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the documented request shape and maps the answer + citations back", async () => {
    const fetchImpl = anthropicFetch(
      okBody("Redis was explicitly rejected to avoid an infra dependency [1]; the session confirms it [2]."),
    );
    const result = await synthesizeAnswer("why don't we use redis", SOURCES, {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe(DEFAULT_SYNTHESIS_MODEL);
    expect(body["max_tokens"]).toBe(4096);
    expect(body["system"]).toContain("Cite every claim");
    // No tools configured → no `tools` key, and no thinking/effort fields that would
    // break a GIT_FOR_AI_SYNTHESIS_MODEL override (judgment call #5).
    expect(body["tools"]).toBeUndefined();
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("Question: why don't we use redis");
    expect(messages[0]!.content).toContain("[1] ledger change c/9f2c1a7b");

    expect(result.synthesized).toBe(true);
    expect(result.answer).toContain("explicitly rejected");
    expect(result.citedSources).toEqual([1, 2]);
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    expect(result.toolCalls).toBeUndefined();
  });

  it("honors a per-call model override and the env override", async () => {
    const fetchImpl = anthropicFetch(okBody("fine [1]"));
    await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl, model: "claude-sonnet-4-6" });
    let body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("claude-sonnet-4-6");

    process.env[SYNTHESIS_MODEL_ENV] = "claude-opus-4-8";
    await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl });
    body = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("claude-opus-4-8");
  });

  it("degrades (not throws) on a non-2xx response", async () => {
    const fetchImpl = anthropicFetch({ error: { type: "overloaded_error" } }, 529);
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl });
    expect(result.synthesized).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.skippedReason).toBe("api-error");
    expect(result.error).toContain("529");
  });

  it("degrades (not throws) on a network failure", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl });
    expect(result.skippedReason).toBe("api-error");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("degrades on a refusal stop_reason", async () => {
    const fetchImpl = anthropicFetch({ content: [], stop_reason: "refusal" });
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl });
    expect(result.skippedReason).toBe("refusal");
  });

  it("degrades on an empty/textless response body", async () => {
    const fetchImpl = anthropicFetch({ content: [], stop_reason: "end_turn" });
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl });
    expect(result.skippedReason).toBe("empty-response");
  });
});

// ── The tool loop (ASK_TOOLS.md §4) ──────────────────────────────────────────
//
// The live failure this fixes: asked "what changed in the last commit", the model was
// given eleven words of summary and honestly refused. With tools it reads the repository
// itself. Everything here drives the REAL loop through the fetchImpl seam — no network,
// no key, and the "tools" are plain functions, so a failing assertion means the loop is
// wrong, not that Claude had an off day.

describe("synthesizeAnswer with tools", () => {
  it("declares the tools, runs the requested one, and feeds the result back", async () => {
    const diff = fakeTool("commit_diff", () => "M packages/core/src/query/synthesis.ts");
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_1", name: "commit_diff", input: { sha: "HEAD" } }]),
      okBody("The last commit touched packages/core/src/query/synthesis.ts."),
    ]);

    const result = await synthesizeAnswer("what changed in the last commit", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [diff],
    });

    // Two round trips: ask → tool → answer.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Request 1 declares the tool in the documented wire shape.
    const first = requestBody(fetchImpl, 0);
    expect(first["tools"]).toEqual([
      {
        name: "commit_diff",
        description: "test tool commit_diff",
        input_schema: { type: "object", properties: { target: { type: "string" } } },
      },
    ]);

    // The tool ran with exactly the arguments the model chose.
    expect(diff.calls).toEqual([{ sha: "HEAD" }]);

    // Request 2 replays the assistant turn verbatim, then ONE user message of results.
    const second = requestBody(fetchImpl, 1);
    const messages = second["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "commit_diff", input: { sha: "HEAD" } },
    ]);
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "M packages/core/src/query/synthesis.ts",
      },
    ]);

    expect(result.synthesized).toBe(true);
    expect(result.answer).toContain("synthesis.ts");
    // Provenance: what was consulted, with what arguments (§5.5).
    expect(result.toolCalls).toEqual([
      { name: "commit_diff", input: { sha: "HEAD" }, ok: true, chars: 38 },
    ]);
    // Usage is summed across every request the answer cost.
    expect(result.usage).toEqual({ inputTokens: 320, outputTokens: 74 });
  });

  it("echoes thinking blocks back untouched alongside the tool call", async () => {
    // Adaptive thinking is on by default on the current model; a filtered or reordered
    // assistant turn is rejected by the API, so the loop replays content verbatim.
    const thinking = { type: "thinking", thinking: "" };
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_1", name: "show_change", input: {} }], [thinking]),
      okBody("done"),
    ]);
    await synthesizeAnswer("q", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [fakeTool("show_change", () => "change c/abc")],
    });
    const messages = requestBody(fetchImpl, 1)["messages"] as Array<{ content: unknown }>;
    expect((messages[1]!.content as unknown[])[0]).toEqual(thinking);
  });

  it("runs parallel tool calls and returns all results in one user message", async () => {
    const show = fakeTool("show_change", () => "change c/abc");
    const log = fakeTool("log_intent", () => "ce23522 Spec: ask should use the tool's own features");
    const fetchImpl = sequenceFetch([
      toolUseBody([
        { id: "toolu_1", name: "show_change", input: { target: "HEAD" } },
        { id: "toolu_2", name: "log_intent", input: { n: 3 } },
      ]),
      okBody("Both reads agree [1]."),
    ]);

    const result = await synthesizeAnswer("q", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [show, log],
    });

    expect(show.calls).toHaveLength(1);
    expect(log.calls).toHaveLength(1);
    const messages = requestBody(fetchImpl, 1)["messages"] as Array<{ content: unknown }>;
    const results = messages[2]!.content as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1 + 1);
    expect(results.map((r) => r["tool_use_id"])).toEqual(["toolu_1", "toolu_2"]);
    expect(result.toolCalls?.map((call) => call.name)).toEqual(["show_change", "log_intent"]);
  });

  it("reports a throwing tool to the model and records the failure — never swallows it", async () => {
    const boom = fakeTool("commit_diff", () => {
      throw new Error("cannot resolve commit: deadbeef");
    });
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_1", name: "commit_diff", input: { sha: "deadbeef" } }]),
      okBody("That commit is not in this repository."),
    ]);

    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl, tools: [boom] });

    const messages = requestBody(fetchImpl, 1)["messages"] as Array<{ content: unknown }>;
    const [toolResult] = messages[2]!.content as Array<Record<string, unknown>>;
    expect(toolResult!["is_error"]).toBe(true);
    expect(toolResult!["content"]).toContain("cannot resolve commit: deadbeef");

    // The answer still lands, and the failed read is visible in the provenance.
    expect(result.synthesized).toBe(true);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "commit_diff",
      ok: false,
      error: "cannot resolve commit: deadbeef",
    });
  });

  it("reports an unknown tool name as a tool error rather than crashing", async () => {
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_1", name: "rm_rf", input: {} }]),
      okBody("No such tool."),
    ]);
    const result = await synthesizeAnswer("q", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [fakeTool("show_change", () => "x")],
    });
    expect(result.synthesized).toBe(true);
    expect(result.toolCalls?.[0]).toMatchObject({ name: "rm_rf", ok: false });
    expect(result.toolCalls?.[0]?.error).toContain("unknown tool");
  });

  it("stops at the iteration cap with a labeled outcome, not a truncated answer", async () => {
    // A model that never stops calling tools: the loop must stop, say so, and still
    // report everything it read on the way (the honest-degradation rule).
    const loop = fakeTool("commit_diff", () => "diff…");
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_x", name: "commit_diff", input: { sha: "HEAD" } }]),
    ]);

    const result = await synthesizeAnswer("q", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [loop],
      maxToolIterations: 3,
    });

    expect(result.synthesized).toBe(false);
    expect(result.answer).toBeNull();
    expect(result.skippedReason).toBe("tool-iteration-cap");
    expect(result.error).toContain("3 rounds");
    expect(loop.calls).toHaveLength(3);
    expect(result.toolCalls).toHaveLength(3);
    // 3 tool rounds + the request that asked for a 4th = 4 requests, then we stop.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("defaults the cap to DEFAULT_MAX_TOOL_ITERATIONS", async () => {
    const loop = fakeTool("commit_diff", () => "diff…");
    const fetchImpl = sequenceFetch([
      toolUseBody([{ id: "toolu_x", name: "commit_diff", input: {} }]),
    ]);
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl, tools: [loop] });
    expect(result.skippedReason).toBe("tool-iteration-cap");
    expect(loop.calls).toHaveLength(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("declares no tools when the cap is zero", async () => {
    const fetchImpl = sequenceFetch([okBody("plain answer [1]")]);
    const tool = fakeTool("commit_diff", () => "diff…");
    const result = await synthesizeAnswer("q", SOURCES, {
      apiKey: "k",
      fetchImpl,
      tools: [tool],
      maxToolIterations: 0,
    });
    expect(requestBody(fetchImpl, 0)["tools"]).toBeUndefined();
    expect(result.synthesized).toBe(true);
    expect(tool.calls).toHaveLength(0);
  });

  it("keeps the no-key path fully local — tools are never run without synthesis", async () => {
    const tool = fakeTool("commit_diff", () => "diff…");
    const fetchImpl = sequenceFetch([okBody("unused")]);
    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "", fetchImpl, tools: [tool] });
    expect(result.skippedReason).toBe("no-api-key");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tool.calls).toHaveLength(0);
  });

  it("carries the reads it managed before an API failure into the fallback", async () => {
    const show = fakeTool("show_change", () => "change c/abc");
    let call = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify(toolUseBody([{ id: "toolu_1", name: "show_change", input: {} }])),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 529 });
    });

    const result = await synthesizeAnswer("q", SOURCES, { apiKey: "k", fetchImpl, tools: [show] });
    expect(result.skippedReason).toBe("api-error");
    expect(result.toolCalls?.map((c) => c.name)).toEqual(["show_change"]);
  });
});

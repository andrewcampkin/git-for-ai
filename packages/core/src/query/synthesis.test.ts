// M11 synthesis tests — the Anthropic HTTP layer is MOCKED via the injectable
// fetchImpl (the one place mocking the external dependency is sanctioned, per
// CLI_PLAN.md M11: the point under test is prompt construction, citation mapping,
// and fallback behavior — not Claude's output quality). No network, no API key,
// no model is ever touched.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredChunk } from "../embeddings/store.js";
import {
  DEFAULT_SYNTHESIS_MODEL,
  SYNTHESIS_MODEL_ENV,
  buildSynthesisPrompt,
  extractCitations,
  synthesizeAnswer,
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
  model: "claude-haiku-4-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 120, output_tokens: 34 },
});

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
      const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
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
    expect(body["max_tokens"]).toBe(1024);
    expect(body["system"]).toContain("Cite every claim");
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("Question: why don't we use redis");
    expect(messages[0]!.content).toContain("[1] ledger change c/9f2c1a7b");

    expect(result.synthesized).toBe(true);
    expect(result.answer).toContain("explicitly rejected");
    expect(result.citedSources).toEqual([1, 2]);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
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

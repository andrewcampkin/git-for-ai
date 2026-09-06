// Tests for `git for-ai mcp` (./mcp.ts) — the stdio MCP server — against a REAL fixture
// repo (the no-mocks rule) whose index is built by the REAL runReindex
// pipeline with the deterministic BagOfWordsEmbedder (the real model is NEVER loaded in
// tests). Two layers:
//
//   1. The BUILT server (dist/bin.js mcp) driven over real stdio via the SDK's client —
//      the exact artifact an agent would register with `claude mcp add`. The embedder
//      crosses the process boundary through the documented env seam
//      (GIT_FOR_AI_MCP_TEST_EMBEDDER=bag-of-words); both Anthropic key vars are pinned
//      empty so `ask` exercises the honest no-key fallback and a developer's real key
//      can never leak in.
//   2. The exact production server object (createMcpServer) over the SDK's in-memory
//      transport pair, where the sanctioned in-process seams (embedder + synthesis
//      fetchImpl mock) cover the synthesized-answer path and the actionable error
//      mapping (init → reindex) — mocked-fetch synthesis, per the query-engine test rules.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
import { createMcpServer } from "./mcp.js";

const AUTH_FILE = "src/auth/session.ts";
const QUESTION = "why don't we use redis for sessions";

/** The built CLI entry point — what `claude mcp add` would actually register. */
const BIN_PATH = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

let repo: FixtureRepo;
const embedder = new BagOfWordsEmbedder();
let changeId: string;
let commitSha: string;

/** Extract and parse the JSON text payload of a successful tool result. */
function jsonOf(result: CallToolResult): unknown {
  expect(result.isError ?? false).toBe(false);
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

/** Extract the error text of a failed tool result. */
function errorTextOf(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return (first as { type: "text"; text: string }).text;
}

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };

  await runInit({ cwd: repo.dir, claudeHooks: false });
  commitSha = await repo.commit("Move session state to signed cookies", {
    files: {
      [AUTH_FILE]: "export function signSessionCookie() {}\n",
      "src/config/toml.ts": "export function parseTomlScalar(raw: string) { return raw; }\n",
    },
  });
  ({ changeId } = await assignChangeId(commitSha, ctx));
  const blob = (await repo.run(["rev-parse", `${commitSha}:${AUTH_FILE}`])).stdout;
  const { sessionRef } = await writeSessionRecord(
    makeSessionRecord({
      sessionId: "sess-mcp-cli",
      capturedAt: "2026-07-17T10:00:00Z",
      sinceSha: commitSha,
      untilSha: commitSha,
      summary: "Agent replaced the in-process session map with signed cookies",
    }),
    ctx,
  );
  await appendLedgerEntry(
    changeId,
    makeLedgerEntry({
      changeId,
      revision: commitSha,
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

  // The real reindex pipeline builds the index (code + ledger + session, one space).
  await runReindex({ cwd: repo.dir, embedder });
});

afterAll(async () => {
  await repo.cleanup();
});

// ─── 1. The built server over real stdio ─────────────────────────────────────

describe("git for-ai mcp — the built server over stdio", () => {
  let client: Client;

  beforeAll(async () => {
    if (!existsSync(BIN_PATH)) {
      throw new Error(
        `built CLI not found at ${BIN_PATH} — run \`pnpm build\` first (turbo's test task ` +
          "depends on build, so this only happens when vitest is invoked directly on stale dist)",
      );
    }
    client = new Client({ name: "mcp-stdio-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN_PATH, "mcp", "--repo", repo.dir],
        env: {
          ...getDefaultEnvironment(),
          // Env seam: the spawned server cannot receive an in-process embedder object.
          GIT_FOR_AI_MCP_TEST_EMBEDDER: "bag-of-words",
          // Pin both key vars empty: `ask` must take the honest no-key fallback and a
          // developer's real key must never be spent by a test.
          GIT_FOR_AI_ANTHROPIC_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists the six intent-layer tools, with annotate as the one write", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["annotate", "ask", "blame_why", "doctor", "log_intent", "show"]);

    const annotate = tools.find((tool) => tool.name === "annotate")!;
    expect(annotate.description).toContain("WRITE TOOL");
    expect(annotate.annotations?.readOnlyHint).toBe(false);
    for (const name of ["ask", "blame_why", "show", "log_intent", "doctor"]) {
      expect(tools.find((tool) => tool.name === name)!.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("ask retrieves the real index and degrades honestly without a key", async () => {
    const result = (await client.callTool({
      name: "ask",
      arguments: { question: QUESTION },
    })) as CallToolResult;
    const data = jsonOf(result) as {
      sources: Array<{ chunk: { key: string } }>;
      synthesis: { synthesized: boolean; skippedReason?: string };
    };
    expect(data.sources[0]!.chunk.key).toBe(`ledger:${changeId}`);
    expect(data.synthesis.synthesized).toBe(false);
    expect(data.synthesis.skippedReason).toBe("no-api-key");
  });

  it("ask honors sources_only (synthesis not requested)", async () => {
    const result = (await client.callTool({
      name: "ask",
      arguments: { question: QUESTION, sources_only: true, k: 2 },
    })) as CallToolResult;
    const data = jsonOf(result) as {
      sources: unknown[];
      synthesis: { skippedReason?: string };
    };
    expect(data.sources.length).toBeLessThanOrEqual(2);
    expect(data.synthesis.skippedReason).toBe("not-requested");
  });

  it("show dumps the ledger entry and linked session for the commit (dogfood target)", async () => {
    const result = (await client.callTool({
      name: "show",
      arguments: { target: commitSha },
    })) as CallToolResult;
    const data = jsonOf(result) as {
      changeId: string | null;
      ledger: Array<{ entry: { summary: string }; effective: boolean }>;
      session: { status: string };
    };
    expect(data.changeId).toBe(changeId);
    expect(data.ledger).toHaveLength(1);
    expect(data.ledger[0]!.entry.summary).toBe("Move session state to signed cookies");
    expect(data.ledger[0]!.effective).toBe(true);
    expect(data.session.status).toBe("available");
  });

  it("show resolves a c/<change-id> target too", async () => {
    const result = (await client.callTool({
      name: "show",
      arguments: { target: `c/${changeId}` },
    })) as CallToolResult;
    const data = jsonOf(result) as { commit: { sha: string } | null };
    expect(data.commit?.sha).toBe(commitSha);
  });

  it("log_intent returns structured rows with the intent summary", async () => {
    const result = (await client.callTool({
      name: "log_intent",
      arguments: {},
    })) as CallToolResult;
    const lines = jsonOf(result) as Array<{
      sha: string;
      changeId: string | null;
      summary: string;
      hasIntent: boolean;
    }>;
    const row = lines.find((line) => line.sha === commitSha)!;
    expect(row.changeId).toBe(changeId);
    expect(row.summary).toBe("Move session state to signed cookies");
    expect(row.hasIntent).toBe(true);
  });

  it("blame_why resolves a line to its recorded intent", async () => {
    const result = (await client.callTool({
      name: "blame_why",
      arguments: { file: AUTH_FILE, line: 1 },
    })) as CallToolResult;
    const data = jsonOf(result) as {
      changeId: string | null;
      entry: { summary: string; reasoning?: { rejected?: Array<{ option: string }> } } | null;
    };
    expect(data.changeId).toBe(changeId);
    expect(data.entry?.summary).toBe("Move session state to signed cookies");
    expect(data.entry?.reasoning?.rejected?.[0]?.option).toBe("Redis session store");
  });

  it("doctor returns the structured report", async () => {
    const result = (await client.callTool({ name: "doctor", arguments: {} })) as CallToolResult;
    const data = jsonOf(result) as {
      checks: Array<{ name: string; status: string; remediation: string[] }>;
      exitCode: number;
    };
    expect(data.checks.length).toBeGreaterThan(0);
    expect(data.checks.some((check) => check.name === "hooks")).toBe(true);
    expect(data.checks.some((check) => check.name === "index")).toBe(true);
    expect([0, 3]).toContain(data.exitCode);
  });

  it("annotate appends a schema-validated ledger entry (the write path)", async () => {
    const result = (await client.callTool({
      name: "annotate",
      arguments: {
        target: commitSha,
        entry: {
          summary: "Documented from MCP: cookie sessions enable multi-replica deploys",
          reasoning: {
            intent: "record the deliberate rationale through the MCP write path",
            tested: ["vitest mcp.test.ts"],
          },
          author: { type: "agent", tool: "mcp-test" },
        },
      },
    })) as CallToolResult;
    const data = jsonOf(result) as {
      sha: string;
      changeId: string;
      entryCount: number;
      entry: { summary: string; provenance: string };
    };
    expect(data.sha).toBe(commitSha);
    expect(data.changeId).toBe(changeId);
    expect(data.entryCount).toBe(2);
    expect(data.entry.summary).toContain("Documented from MCP");

    // The write is visible on the read path: the new entry is now effective.
    const shown = jsonOf(
      (await client.callTool({
        name: "show",
        arguments: { target: commitSha, history: true },
      })) as CallToolResult,
    ) as { ledger: Array<{ entry: { summary: string }; effective: boolean }> };
    expect(shown.ledger).toHaveLength(2);
    expect(shown.ledger.find((row) => row.effective)!.entry.summary).toContain(
      "Documented from MCP",
    );
  });

  it("annotate rejects unknown entry keys loudly (agent typos never pass silently)", async () => {
    const result = (await client.callTool({
      name: "annotate",
      arguments: { entry: { sumary: "typo'd summary" } },
    })) as CallToolResult;
    expect(errorTextOf(result)).toMatch(/unrecognized key.*sumary/);
  });

  it("annotate without a summary is a tool error, not a crash", async () => {
    const result = (await client.callTool({
      name: "annotate",
      arguments: { entry: { reasoning: { intent: "no summary given" } } },
    })) as CallToolResult;
    expect(errorTextOf(result)).toContain("summary is required");
  });

  it("show of an unresolvable target is a tool error with the message intact", async () => {
    const result = (await client.callTool({
      name: "show",
      arguments: { target: "does-not-exist" },
    })) as CallToolResult;
    expect(errorTextOf(result)).toContain("cannot resolve 'does-not-exist' to a commit");
  });
});

// ─── 2. The production server object in-process (synthesis + error mapping) ──

/** Connect the exact production server to a fresh client over an in-memory pair. */
async function connectInProcess(
  options: Parameters<typeof createMcpServer>[0],
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(options);
  const client = new Client({ name: "mcp-inproc-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("createMcpServer — synthesized ask (mocked Anthropic HTTP)", () => {
  it("returns the cited prose answer through the sanctioned fetchImpl seam", async () => {
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

    const { client, close } = await connectInProcess({
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    try {
      const result = (await client.callTool({
        name: "ask",
        arguments: { question: QUESTION },
      })) as CallToolResult;
      const data = jsonOf(result) as {
        synthesis: { synthesized: boolean; answer: string | null; citedSources: number[] };
        confidence?: { level: string };
      };
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(data.synthesis.synthesized).toBe(true);
      expect(data.synthesis.answer).toContain("Redis was explicitly rejected");
      expect(data.synthesis.citedSources).toEqual([1, 2]);
      expect(data.confidence).toBeDefined();
    } finally {
      await close();
    }
  });
});

describe("createMcpServer — actionable tool errors (init → reindex), never crashes", () => {
  it("names `git for-ai init` for an uninitialized repository", async () => {
    const bare = await createFixtureRepo();
    try {
      await bare.commit("Initial", { files: { "a.txt": "hello\n" } });
      const { client, close } = await connectInProcess({ cwd: bare.dir, embedder });
      try {
        const result = (await client.callTool({
          name: "ask",
          arguments: { question: "anything" },
        })) as CallToolResult;
        expect(errorTextOf(result)).toContain("git for-ai init");
      } finally {
        await close();
      }
    } finally {
      await bare.cleanup();
    }
  });

  it("names `git for-ai reindex` when the index was never built", async () => {
    const fresh = await createFixtureRepo();
    try {
      await fresh.commit("Initial", { files: { "a.txt": "hello\n" } });
      await runInit({ cwd: fresh.dir, claudeHooks: false });
      const { client, close } = await connectInProcess({ cwd: fresh.dir, embedder });
      try {
        const result = (await client.callTool({
          name: "ask",
          arguments: { question: "anything" },
        })) as CallToolResult;
        expect(errorTextOf(result)).toContain("git for-ai reindex");
      } finally {
        await close();
      }
    } finally {
      await fresh.cleanup();
    }
  });
});

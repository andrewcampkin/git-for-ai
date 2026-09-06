// End-to-end `ask` tests: a fixture repo with
// real ledger entries (plus a session record), an index built with SYNTHETIC vectors
// (deterministic fake embedder — the real model is never loaded), and a query targeting
// one entry returning it as the top-ranked source — with AND without an API key.
// The Anthropic HTTP layer is mocked through the injectable fetchImpl.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SqliteVectorStore } from "../embeddings/store.js";
import { createFixtureRepo, type FixtureRepo } from "../git/testFixtures.js";
import { assignChangeId } from "../identity/assign.js";
import { appendLedgerEntry } from "../ledger/intentNotes.js";
import { writeSessionRecord } from "../sessions/store.js";

import { askQuestion } from "./engine.js";
import { BagOfWordsEmbedder, makeLedgerEntry, makeSessionRecord, storeItem } from "./testSupport.js";

const AUTH_FILE = "src/auth/session.ts";
const QUESTION = "why don't we use redis for sessions";

let repo: FixtureRepo;
let dir: string;
let store: SqliteVectorStore;
const embedder = new BagOfWordsEmbedder();

let changeId: string;
let sessionRef: string;
let contentHash: string;

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };

  // Real git records: one commit, its change identity, ledger entry, session trace.
  const sha = await repo.commit("Move session state to signed cookies", {
    files: { [AUTH_FILE]: "export function signSessionCookie() {}\n" },
  });
  ({ changeId } = await assignChangeId(sha, ctx));
  const blob = (await repo.run(["rev-parse", `${sha}:${AUTH_FILE}`])).stdout;
  const session = await writeSessionRecord(
    makeSessionRecord({
      sessionId: "sess-ask",
      capturedAt: "2026-07-17T10:00:00Z",
      sinceSha: sha,
      untilSha: sha,
      summary: "Agent replaced the in-process session map with signed cookies",
    }),
    ctx,
  );
  sessionRef = session.sessionRef;
  contentHash = session.contentHash;
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

  // The index `reindex` would have produced, with synthetic vectors (reindex.ts key/text shapes).
  dir = await mkdtemp(join(tmpdir(), "git-for-ai-ask-"));
  store = SqliteVectorStore.open({
    path: join(dir, "index.db"),
    dim: embedder.dim,
    modelFingerprint: `${embedder.id}/${embedder.dim}`,
  });
  store.upsert([
    storeItem(
      embedder,
      `ledger:${changeId}`,
      "ledger",
      "Move session state to signed cookies\n" +
        "Intent: run more than one replica without sticky sessions\n" +
        "Rejected: Redis session store — avoid adding an infra dependency",
      { changeId, sessionRef },
    ),
    storeItem(
      embedder,
      `session:${contentHash}`,
      "session",
      "Agent replaced the in-process session map with signed cookies",
      { sessionRef, changeId },
    ),
    storeItem(
      embedder,
      "blob:src/config/toml.ts#0",
      "code",
      "export function parseTomlScalar(raw) { /* quoted strings and integers */ }",
      { path: "src/config/toml.ts", blobSha: "b".repeat(40), nodePath: "#0", startLine: 1, endLine: 30 },
    ),
  ]);
});

afterAll(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await repo.cleanup();
});

describe("askQuestion", () => {
  it("without an API key: top-ranked enriched sources, clean fallback, no error", async () => {
    const fetchImpl = vi.fn();
    const result = await askQuestion(
      { store, embedder, ctx: { cwd: repo.dir } },
      QUESTION,
      { synthesis: { apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch } },
    );

    // The targeted ledger entry is the top source.
    expect(result.sources[0]!.chunk.key).toBe(`ledger:${changeId}`);

    // Enrichment carries the FULL records — the CLI renders §9.1 without re-fetching.
    const top = result.sources[0]!;
    expect(top.ledgerEntry?.summary).toBe("Move session state to signed cookies");
    expect(top.ledgerEntry?.reasoning?.rejected?.[0]?.option).toBe("Redis session store");
    expect(top.ledgerEntry?.provenance).toBe("agent-captured");
    expect(top.changeMapEntry?.change_id).toBe(changeId);
    expect(top.sessionRecord?.session_id).toBe("sess-ask");

    // The session chunk was also enriched (memoized joins, same records).
    const sessionSource = result.sources.find((s) => s.chunk.kind === "session");
    expect(sessionSource?.sessionRecord?.session_id).toBe("sess-ask");
    expect(sessionSource?.ledgerEntry?.change_id).toBe(changeId);

    // Fallback, not error.
    expect(result.synthesis).toEqual({
      synthesized: false,
      answer: null,
      citedSources: [],
      skippedReason: "no-api-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it("with an API key (mocked HTTP): synthesized prose citing the ranked sources", async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "A Redis session store was explicitly rejected to avoid an infra dependency [1]; the captured session confirms the switch to signed cookies [2].",
              },
            ],
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 200, output_tokens: 40 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await askQuestion(
      { store, embedder, ctx: { cwd: repo.dir } },
      QUESTION,
      { synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch } },
    );

    expect(result.synthesis.synthesized).toBe(true);
    expect(result.synthesis.answer).toContain("explicitly rejected");
    expect(result.synthesis.citedSources).toEqual([1, 2]);
    // Citation numbers are 1-based indexes into result.sources.
    expect(result.sources[result.synthesis.citedSources[0]! - 1]!.chunk.key).toBe(
      `ledger:${changeId}`,
    );

    // The prompt the model saw was built from the SAME ranked sources.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toContain(`Question: ${QUESTION}`);
    expect(body.messages[0]!.content).toContain("[1] ledger change");
  });

  it("restricting kinds narrows retrieval", async () => {
    const result = await askQuestion(
      { store, embedder, ctx: { cwd: repo.dir } },
      "session cookies",
      { kinds: ["session"], synthesis: { apiKey: "" } },
    );
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((s) => s.chunk.kind === "session")).toBe(true);
  });

  it("recency floor: the newest change rides along even when the index has never seen it", async () => {
    // The live failure this guards (2026-07-19): "what was the most recent change?"
    // retrieved nothing relevant because similarity has no concept of time — and the
    // index was stale on top. A brand-new change, deliberately NOT upserted into the
    // store, must still appear as a cited source, enriched from git directly.
    const ctx = { cwd: repo.dir };
    const sha = await repo.commit("Add the flux capacitor", {
      files: { "src/flux.ts": "export const flux = true;\n" },
    });
    const { changeId: newChangeId } = await assignChangeId(sha, ctx);
    const blob = (await repo.run(["rev-parse", `${sha}:src/flux.ts`])).stdout;
    await appendLedgerEntry(
      newChangeId,
      makeLedgerEntry({
        changeId: newChangeId,
        revision: sha,
        createdAt: "2026-07-19T09:00:00Z", // newer than the cookie change (07-17)
        summary: "Add the flux capacitor",
        scopePath: "src/flux.ts",
        scopeBlob: blob,
        sessionRef,
      }),
      ctx,
    );

    const result = await askQuestion(
      { store, embedder, ctx },
      "what was the most recent change and why was it made",
      { synthesis: { apiKey: "" } },
    );

    // Appended after retrieval hits, matched by recency only, fully enriched.
    const recent = result.sources.find((s) => s.chunk.key === `ledger:${newChangeId}`);
    expect(recent).toBeDefined();
    expect(recent!.matchedBy).toEqual(["recency"]);
    expect(recent!.ledgerEntry?.summary).toBe("Add the flux capacitor");
    expect(recent!.changeMapEntry?.change_id).toBe(newChangeId);
    expect(recent!.rank).toBe(result.sources.indexOf(recent!) + 1);

    // A change the retrieval DID find is not duplicated — it gains the recency side.
    const cookie = result.sources.filter((s) => s.chunk.key === `ledger:${changeId}`);
    expect(cookie).toHaveLength(1);
    expect(cookie[0]!.matchedBy).toContain("recency");

    // recent: 0 disables the floor entirely.
    const disabled = await askQuestion(
      { store, embedder, ctx },
      "what was the most recent change and why was it made",
      { recent: 0, synthesis: { apiKey: "" } },
    );
    expect(disabled.sources.find((s) => s.chunk.key === `ledger:${newChangeId}`)).toBeUndefined();
  });
});

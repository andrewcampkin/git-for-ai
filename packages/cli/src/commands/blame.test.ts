// Tests for `git for-ai blame --why` (./blame.ts) — M12 — against REAL fixture repos
// with real `git blame` under the hood (no mocks, CLI_PLAN.md §4). The core scenarios:
// the full §9.1 intent rendering WITHOUT any index (blame's identity answer is
// git-native), the LATER TOUCHED BY chain, both degraded cases (no captured intent /
// uncommitted line) with exit code 2, and the opt-in --explain synthesis over an index
// built by the real reindex pipeline with the deterministic fake embedder.

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
import { parseFileLine, runBlame } from "./blame.js";

const AUTH_FILE = "src/auth/session.ts";
const AUTH_V1 = [
  "export function signSessionCookie() {",
  "  return 'signed';",
  "}",
  "",
].join("\n");

let repo: FixtureRepo;
let shaPlain: string;
let shaAuth: string;
let cidAuth: string;
let cidLater: string;

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };

  // A pre-git-for-ai commit: no identity, no intent (the degraded case).
  shaPlain = await repo.commit("Initial parser import", {
    files: { "src/legacy/parser.ts": "export const legacy = true;\n" },
  });

  // The agent-captured change: identity + ledger + session.
  shaAuth = await repo.commit("Move session state to signed cookies", {
    files: { [AUTH_FILE]: AUTH_V1 },
  });
  ({ changeId: cidAuth } = await assignChangeId(shaAuth, ctx));
  const blob = (await repo.run(["rev-parse", `${shaAuth}:${AUTH_FILE}`])).stdout;
  const { sessionRef } = await writeSessionRecord(
    makeSessionRecord({
      sessionId: "sess-blame",
      capturedAt: "2026-07-17T09:22:41Z",
      sinceSha: shaAuth,
      untilSha: shaAuth,
      summary: "Agent switched sessions to signed cookies",
    }),
    ctx,
  );
  await appendLedgerEntry(
    cidAuth,
    makeLedgerEntry({
      changeId: cidAuth,
      revision: shaAuth,
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

  // A LATER change touching the same file (appends a line; line 1 keeps its blame).
  const shaLater = await repo.commit("Add token rotation", {
    files: { [AUTH_FILE]: `${AUTH_V1}export function rotateToken() {}\n` },
  });
  ({ changeId: cidLater } = await assignChangeId(shaLater, ctx));
  const laterBlob = (await repo.run(["rev-parse", `${shaLater}:${AUTH_FILE}`])).stdout;
  await appendLedgerEntry(
    cidLater,
    makeLedgerEntry({
      changeId: cidLater,
      revision: shaLater,
      createdAt: "2026-07-19T08:00:00Z",
      summary: "add token rotation",
      scopePath: AUTH_FILE,
      scopeBlob: laterBlob,
    }),
    ctx,
  );
});

afterAll(async () => {
  await repo.cleanup();
});

describe("parseFileLine", () => {
  it("splits at the LAST colon (Windows drive letters survive)", () => {
    expect(parseFileLine("src/auth/session.ts:73")).toEqual({ path: "src/auth/session.ts", line: 73 });
    expect(parseFileLine("C:\\repo\\src\\a.ts:12")).toEqual({ path: "C:\\repo\\src\\a.ts", line: 12 });
  });

  it("rejects malformed targets", () => {
    for (const bad of ["no-line", "file.ts:", ":12", "file.ts:0", "file.ts:x"]) {
      expect(() => parseFileLine(bad)).toThrow(/<file>:<line>/);
    }
  });
});

describe("runBlame — the §9.1 intent case (works WITHOUT any index)", () => {
  it("renders change / WHY / CONSIDERED & REJECTED / SESSION / LATER TOUCHED BY", async () => {
    const result = await runBlame(`${AUTH_FILE}:1`, { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(result.data.commit).toBe(shaAuth);
    expect(result.data.changeId).toBe(cidAuth);
    expect(result.data.entry?.summary).toBe("Move session state to signed cookies");

    const output = result.output;
    expect(output).toContain(`${AUTH_FILE}:1  change ${cidAuth.slice(0, 8)}  (agent-captured, confidence 0.82)`);
    expect(output).toMatch(/WHY: Move session state to signed cookies — run more than one replica/);
    expect(output).toContain("CONSIDERED & REJECTED: Redis session store — avoid adding an infra dependency");
    expect(output).toContain(`SESSION: claude-code, 2026-07-17  (git for-ai show c/${cidAuth.slice(0, 8)} --session)`);
    expect(output).toContain(`LATER TOUCHED BY: c/${cidLater.slice(0, 8)} (2026-07-19, "add token rotation")`);
    // No index exists — supplementary context degrades to a visible warning, never a crash.
    expect(result.data.sources).toEqual([]);
    expect(output).toContain("supplementary context skipped");
  });

  it("--session includes a span excerpt", async () => {
    const result = await runBlame(`${AUTH_FILE}:1`, { cwd: repo.dir, session: true });
    expect(result.output).toContain("SESSION TRACE (1 span)");
    expect(result.output).toContain("agent.plan");
  });

  it("--depth caps LATER TOUCHED BY visibly", async () => {
    // Only one later change exists; depth 1 shows it without a truncation marker.
    const result = await runBlame(`${AUTH_FILE}:1`, { cwd: repo.dir, depth: 1 });
    expect(result.output).toContain("LATER TOUCHED BY:");
    expect(result.output).not.toContain("more — raise --depth");
  });

  it("accepts an absolute path and normalizes it repo-relative", async () => {
    const absolute = `${repo.dir.replaceAll("\\", "/")}/${AUTH_FILE}`;
    const result = await runBlame(`${absolute}:1`, { cwd: repo.dir });
    expect(result.data.position.path).toBe(AUTH_FILE);
    expect(result.data.changeId).toBe(cidAuth);
  });
});

describe("runBlame — degraded cases (exit 2, honest floors)", () => {
  it("no captured intent: renders what git knows", async () => {
    const result = await runBlame("src/legacy/parser.ts:1", { cwd: repo.dir });

    expect(result.exitCode).toBe(2);
    expect(result.data.entry).toBeNull();
    expect(result.output).toContain("(no captured intent — pre-git-for-ai history)");
    expect(result.output).toContain("No ledger entry or session exists for this line. Here is what git knows:");
    expect(result.output).toMatch(/commit [0-9a-f]+ {2}"Initial parser import" {2}by .+ {2}\d{4}-\d{2}-\d{2}/);
    expect(result.output).toContain("Answer confidence: none — this is git metadata only");
    expect(result.data.commitInfo?.sha).toBe(shaPlain);
  });

  it("uncommitted line: honest 'no commit owns this line'", async () => {
    await repo.writeFile("src/new-uncommitted.ts", "export const brandNew = 1;\n");
    await repo.run(["add", "src/new-uncommitted.ts"]); // blame needs the path tracked
    const result = await runBlame("src/new-uncommitted.ts:1", { cwd: repo.dir });
    expect(result.exitCode).toBe(2);
    expect(result.data.commit).toBeNull();
    expect(result.output).toContain("uncommitted");
  });

  it("fails loudly for a path git cannot blame at all", async () => {
    await expect(runBlame("src/does-not-exist.ts:1", { cwd: repo.dir })).rejects.toThrow(
      /git blame failed/,
    );
  });
});

describe("runBlame — --explain (opt-in synthesis over an index)", () => {
  const embedder = new BagOfWordsEmbedder();

  beforeAll(async () => {
    await runInit({ cwd: repo.dir, claudeHooks: false });
    await runReindex({ cwd: repo.dir, embedder });
  });

  it("without a key: honest unavailable note, no API call", async () => {
    const fetchImpl = vi.fn();
    const result = await runBlame(`${AUTH_FILE}:1`, {
      cwd: repo.dir,
      embedder,
      explain: true,
      synthesis: { apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.output).toContain("SYNTHESIZED: unavailable — no API key configured");
    // The deterministic §9.1 template still rendered above it.
    expect(result.output).toContain("WHY: Move session state to signed cookies");
  });

  it("with a mocked key: synthesized prose plus the numbered context sources", async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "The line exists because sessions moved to signed cookies [1]." },
            ],
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runBlame(`${AUTH_FILE}:1`, {
      cwd: repo.dir,
      embedder,
      explain: true,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(result.exitCode).toBe(0);
    expect(result.data.synthesis.synthesized).toBe(true);
    expect(result.output).toContain("SYNTHESIZED: The line exists because sessions moved to signed cookies [1].");
    expect(result.output).toContain("Context sources:");
    expect(result.output).toMatch(/\[1\] (ledger|session|code)/);
    // Supplementary retrieval was position-boosted toward the blamed file.
    expect(result.data.sources.length).toBeGreaterThan(0);
  });

  it("--json data carries the full structured result", async () => {
    const result = await runBlame(`${AUTH_FILE}:1`, {
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "" },
    });
    const roundTripped = JSON.parse(JSON.stringify(result.data)) as typeof result.data;
    expect(roundTripped.position).toEqual({ path: AUTH_FILE, line: 1 });
    expect(roundTripped.commitInfo?.subject).toBe("Move session state to signed cookies");
    expect(roundTripped.entries.length).toBeGreaterThan(0);
    expect(roundTripped.laterTouchedBy[0]?.changeId).toBe(cidLater);
  });
});

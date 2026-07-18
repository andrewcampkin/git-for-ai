// Integration tests for `git for-ai review` per REVIEW_UI.md §5: API endpoints against a
// REAL fixture repository (createFixtureRepo — never mocked), exercised through a REAL
// listening node:http server via fetch. Also asserts the §2 server rules: 127.0.0.1-only
// binding, GET-only, and the non-minting read guarantee (every ref byte-identical after
// serving the UI — compared via `git for-each-ref`).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { LedgerEntry, SessionRecord } from "@git-for-ai/schemas";
import {
  appendLedgerEntry,
  assignChangeId,
  findEntryByCommitSha,
  writeSessionRecord,
} from "@git-for-ai/core";
import {
  BagOfWordsEmbedder,
  createFixtureRepo,
  makeLedgerEntry,
  type FixtureRepo,
} from "@git-for-ai/core/testing";

import type { ReportData } from "./report.js";
import type { ShowData } from "./show.js";
import { runInit } from "./init.js";
import { runReindex } from "./reindex.js";
import {
  startReviewServer,
  resolveUiDist,
  type ReviewAskData,
  type ReviewMeta,
  type ReviewSessionData,
  type ReviewServerHandle,
} from "./review.js";

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
      tested: ["pnpm test auth"],
    },
    session_ref: params.sessionRef ?? null,
    provenance: "agent-captured",
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

describe("git for-ai review server (real fixture repo, real listening node:http server)", () => {
  let repo: FixtureRepo;
  let handle: ReviewServerHandle;
  let base: string;
  let shaPlain: string;
  let shaAgent: string;
  let cidAgent: string;
  let sessionRef: string;
  let shaCorrupt: string;
  let refsBefore: string;

  const get = (path: string): Promise<Response> => fetch(new URL(path, base));

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

    // Snapshot every ref BEFORE the server touches the repo (non-minting guarantee).
    refsBefore = (await repo.run(["for-each-ref"])).stdout;

    handle = await startReviewServer({ cwd: repo.dir });
    base = handle.url;
  });

  afterAll(async () => {
    await handle.close();
    await repo.cleanup();
  });

  it("binds 127.0.0.1 only, on a random free port by default", () => {
    const address = handle.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    expect((address as { address: string }).address).toBe("127.0.0.1");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
  });

  it("GET /api/overview returns runReport's ReportData with honest totals", async () => {
    const response = await get("/api/overview");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const data = (await response.json()) as ReportData;

    expect(data.totals).toMatchObject({
      commits: 3,
      changes: 1,
      agentCommits: 1,
      noIntentCommits: 2, // plain + corrupt-note commits, honestly labeled
      sessionsCaptured: 1,
    });
    expect(data.timeline.map((row) => row.sha)).toEqual([shaCorrupt, shaAgent, shaPlain]);
    expect(data.timeline[1]).toMatchObject({
      changeId: cidAgent,
      summary: "Switch session store to signed-cookie tokens",
      summarySource: "ledger",
    });
    expect(data.timeline[0]!.summarySource).toBe("git-subject-note-unreadable");
    expect(data.timeline[2]!.summarySource).toBe("git-subject");
    expect(data.warnings).toHaveLength(1);
  });

  it("GET /api/overview honors the n parameter and rejects a bad one", async () => {
    const limited = (await (await get("/api/overview?n=1")).json()) as ReportData;
    expect(limited.timeline).toHaveLength(1);
    expect(limited.timeline[0]!.sha).toBe(shaCorrupt);

    const bad = await get("/api/overview?n=zero");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("invalid n");
  });

  it("GET /api/change/<sha> returns runShow's ShowData (ledger incl. superseded)", async () => {
    const response = await get(`/api/change/${shaAgent}`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as ShowData;

    expect(data.changeId).toBe(cidAgent);
    expect(data.commit!.sha).toBe(shaAgent);
    expect(data.ledger).toHaveLength(2);
    expect(data.ledger.map((row) => row.effective)).toEqual([false, true]);
    expect(data.session).toMatchObject({ ref: sessionRef, status: "available" });
  });

  it("GET /api/change/c/<change-id> resolves change-id targets (slash preserved)", async () => {
    const response = await get(`/api/change/c/${cidAgent}`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as ShowData;
    expect(data.changeId).toBe(cidAgent);
    expect(data.changeMap!.head).toBe(shaAgent);
  });

  it("GET /api/change with an unresolvable target is a 404 with the reason", async () => {
    const response = await get("/api/change/deadbeefdeadbeef");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("deadbeefdeadbeef");
  });

  it("GET /api/session/<ref> returns the full validated span list", async () => {
    const response = await get(`/api/session/${sessionRef}`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as ReviewSessionData;
    expect(data.status).toBe("available");
    expect(data.record!.spans).toHaveLength(2);
    expect(data.record!.spans[1]).toMatchObject({
      kind: "gen_ai.tool.execution",
      name: "Bash",
      attributes: { command: "pnpm test auth" },
    });
  });

  it("GET /api/session with a dangling ref is honest degradation, not an error", async () => {
    const dangling = `sha256:${"ab".repeat(32)}`;
    const data = (await (await get(`/api/session/${dangling}`)).json()) as ReviewSessionData;
    expect(data.status).toBe("unavailable");
    expect(data.reason).toBeDefined();
    expect(data.record).toBeUndefined();

    const invalid = (await (await get("/api/session/not-a-ref")).json()) as ReviewSessionData;
    expect(invalid.status).toBe("unavailable");
  });

  it("GET /api/meta reports repo identity, capture, and index state honestly", async () => {
    const response = await get("/api/meta");
    expect(response.status).toBe(200);
    const meta = (await response.json()) as ReviewMeta;

    expect(meta.head!.sha).toBe(shaCorrupt);
    expect(meta.repoName.length).toBeGreaterThan(0);
    // Fixture repos never ran `git for-ai init`: uninitialized, capture off, no index —
    // stated as such, not inflated.
    expect(meta.initialized).toBe(false);
    expect(meta.captureEnabled).toBe(false);
    expect(meta.index).toEqual({ built: false });
  });

  it("GET /api/ask on an index-less repo is honest degradation, not an error", async () => {
    const response = await get("/api/ask?q=why%20anything");
    expect(response.status).toBe(200);
    const data = (await response.json()) as ReviewAskData;
    expect(data.status).toBe("unavailable");
    expect(data.question).toBe("why anything");
    // The reason is the same actionable message the CLI prints (init first here).
    expect(data.reason).toContain("git for-ai init");
  });

  it("GET /api/ask without q (or with a bad k) is a 400", async () => {
    expect((await get("/api/ask")).status).toBe(400);
    expect((await get("/api/ask?q=")).status).toBe(400);
    expect((await get("/api/ask?q=hi&k=zero")).status).toBe(400);
  });

  it("GET /api/<unknown> is a JSON 404", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
  });

  it("serves the built SPA shell and its assets, with SPA fallback for client routes", async () => {
    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    const html = await index.text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toMatch(/(src|href)=["']https?:/i);

    // A real asset referenced by the shell resolves with the right content type.
    const assetPath = /(?:src|href)="\.?(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(assetPath).toBeDefined();
    const asset = await get(assetPath!);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    // Extensionless client routes get the shell (hash routing means this is rare, but a
    // pasted URL must never be a blank page)…
    const fallback = await get("/change/whatever");
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('<div id="root">');

    // …while a missing asset is an honest 404.
    const missing = await get("/assets/nope.js");
    expect(missing.status).toBe(404);
  });

  it("refuses path traversal out of the UI dist directory", async () => {
    for (const path of [
      "/../package.json",
      "/..%2f..%2fpackage.json",
      "/%2e%2e/%2e%2e/package.json",
    ]) {
      const response = await fetch(`${base.slice(0, -1)}${path}`);
      const text = await response.text();
      // Either the SPA shell (extensionless fallback) or a 404 — never file contents
      // from outside dist/.
      expect(text).not.toContain('"name": "@git-for-ai/review-ui"');
      expect(text).not.toContain('"name": "git-for-ai"');
    }
  });

  it("is read-only: non-GET methods are 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(new URL("/api/overview", base), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("leaves every git ref byte-identical after serving the whole surface (non-minting)", async () => {
    // Hit every endpoint once more, including the no-identity commit's detail page (the
    // path that would tempt resolveChangeId's minting branches).
    await get("/api/overview");
    await get(`/api/change/${shaPlain}`);
    await get(`/api/change/${shaCorrupt}`);
    await get("/api/meta");

    const plainDetail = (await (await get(`/api/change/${shaPlain}`)).json()) as ShowData;
    expect(plainDetail.changeId).toBeNull();
    expect(await findEntryByCommitSha(shaPlain, { cwd: repo.dir })).toBeNull();

    const refsAfter = (await repo.run(["for-each-ref"])).stdout;
    expect(refsAfter).toBe(refsBefore);
  });
});

describe("GET /api/ask against an INDEXED repo (fake embedder; mocked synthesis HTTP)", () => {
  const embedder = new BagOfWordsEmbedder();
  let repo: FixtureRepo;
  let changeId: string;
  let refsBefore: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    const ctx = { cwd: repo.dir };
    await runInit({ cwd: repo.dir, claudeHooks: false });
    const sha = await repo.commit("Move session state to signed cookies", {
      files: { "src/auth/session.ts": "export function signSessionCookie() {}\n" },
    });
    ({ changeId } = await assignChangeId(sha, ctx));
    const blob = (await repo.run(["rev-parse", `${sha}:src/auth/session.ts`])).stdout;
    await appendLedgerEntry(
      changeId,
      makeLedgerEntry({
        changeId,
        revision: sha,
        createdAt: "2026-07-17T10:00:00Z",
        summary: "Move session state to signed cookies",
        scopePath: "src/auth/session.ts",
        scopeBlob: blob,
        intent: "run more than one replica without sticky sessions",
        rejectedOption: "Redis session store",
        rejectedWhy: "avoid adding an infra dependency",
        confidence: 0.82,
      }),
      ctx,
    );
    await runReindex({ cwd: repo.dir, embedder });
    refsBefore = (await repo.run(["for-each-ref"])).stdout;
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("no key: ranked sources + honest skippedReason; asking mints nothing", async () => {
    const handle = await startReviewServer({
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "" }, // pin: a developer's real key must never leak into tests
    });
    try {
      const response = await fetch(
        new URL("/api/ask?q=why%20don%27t%20we%20use%20redis%20for%20sessions", handle.url),
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as ReviewAskData;

      expect(data.status).toBe("ok");
      expect(data.sources!.length).toBeGreaterThan(0);
      const top = data.sources![0]!;
      expect(top.kind).toBe("ledger");
      expect(top.changeId).toBe(changeId);
      expect(top.provenance).toBe("agent-captured");
      expect(top.scope).toBe("src/auth/session.ts:1-5");
      expect(top.summary).toBe("Move session state to signed cookies");
      expect(data.synthesis).toMatchObject({ synthesized: false, skippedReason: "no-api-key" });

      // Serving ask left every ref byte-identical (the non-minting guarantee).
      expect((await repo.run(["for-each-ref"])).stdout).toBe(refsBefore);
    } finally {
      await handle.close();
    }
  });

  it("with a mocked key: synthesized answer with citations in the JSON", async () => {
    const fetchImpl = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "Redis was rejected to avoid an infra dependency [1]." },
            ],
            model: "claude-haiku-4-5",
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const handle = await startReviewServer({
      cwd: repo.dir,
      embedder,
      synthesis: { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    try {
      const response = await fetch(new URL("/api/ask?q=redis%20sessions&k=3", handle.url));
      const data = (await response.json()) as ReviewAskData;
      expect(data.status).toBe("ok");
      expect(data.sources!.length).toBeLessThanOrEqual(3);
      expect(data.synthesis).toMatchObject({
        synthesized: true,
        answer: "Redis was rejected to avoid an infra dependency [1].",
        citedSources: [1],
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });
});

describe("review server startup failures are loud and actionable", () => {
  it("rejects a non-repo cwd", async () => {
    // A fresh temp dir with no .git anywhere above it would be ideal, but any OS temp dir
    // could itself live under a repo on a dev machine; GIT_CEILING is overkill here. Use a
    // directory that certainly is not a work tree: a fixture repo's .git directory is a
    // git dir, so instead create a plain temp dir and assert the GitError surfaces.
    const dir = await mkdtemp(join(tmpdir(), "git-for-ai-review-nonrepo-"));
    try {
      await expect(startReviewServer({ cwd: dir, port: 0 })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("rejects an invalid port", async () => {
    const repo = await createFixtureRepo();
    try {
      await expect(startReviewServer({ cwd: repo.dir, port: 70000 })).rejects.toThrow(
        /invalid --port/,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("resolveUiDist finds the built SPA through the workspace dependency", () => {
    // The actionable-error branch (unbuilt UI) can't be exercised without deleting the
    // build this very test suite depends on; the message is asserted by inspection and
    // the happy path proves the workspace resolution works.
    expect(resolveUiDist()).toContain("review-ui");
  });
});

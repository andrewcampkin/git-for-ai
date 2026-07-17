// Integration tests for `git for-ai show` (Milestone 8) against a REAL temporary git
// repository — createFixtureRepo from @git-for-ai/core, never mocked — per
// architecture/CLI_PLAN.md §4's testing strategy.
//
// The session-trace fixture is planted by hand through the M2 plumbing primitives,
// following the storage layout pinned by DATA_MODEL.md §3 / ARCHITECTURE.md §8.1:
// `refs/git-for-ai/sessions` -> commit -> tree sharded by first hash byte, one
// content-addressed blob per session record, `session_ref` = sha256 of the canonical
// serialization. This deliberately does NOT go through core's sessions module (Milestone 7
// runs in parallel) — the layout is pinned by the spec, not by that code.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LedgerEntry, SessionRecord } from "@git-for-ai/schemas";
import {
  appendLedgerEntry,
  assignChangeId,
  canonicalJsonStringify,
  commitTree,
  hashObject,
  mktree,
  updateRef,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runShow, type ShowData } from "./show.js";

const FAKE_BLOB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SESSIONS_REF = "refs/git-for-ai/sessions";
const INTENT_REF = "refs/notes/git-for-ai/intent";

function makeEntry(params: {
  changeId: string;
  revision: string;
  summary: string;
  createdAt: string;
  sessionRef?: string;
  confidence?: number;
  intent?: string;
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
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
      ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
      rejected: [{ option: "Redis session store", why: "adds an infra dependency" }],
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
    redaction: { applied: true, rules: ["aws-key"], redacted_count: 3, truncated_count: 0 },
    source_fingerprint: "claude-code-jsonl/2026.07",
    spans: [
      {
        span_id: "s1",
        kind: "agent.plan",
        start: "2026-07-17T09:05:00Z",
        end: "2026-07-17T09:05:02Z",
        body: { plan: "1. Extract session logic\n2. Replace map with signed cookie" },
      },
      {
        span_id: "s2",
        parent_id: "s1",
        kind: "gen_ai.tool.execution",
        name: "Edit",
        attributes: { file: "src/auth/session.ts" },
        body: { diff_summary: "replace HashMap store with cookie codec" },
      },
    ],
    summary: "Agent refactored auth to stateless signed-cookie sessions.",
  };
}

/**
 * Plant a session record into the sessions ref by hand, per DATA_MODEL.md §3's layout:
 * canonical serialization -> sha256 -> blob at `<aa>/<full-hash>` in a tree the ref's
 * commit points at. Returns the `sha256:<hash>` session_ref for the ledger entry.
 */
async function plantSessionRecord(record: SessionRecord, cwd: string): Promise<string> {
  const canonical = canonicalJsonStringify(record);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");

  const blobSha = await hashObject(canonical, { cwd, write: true });
  const shardTree = await mktree(
    [{ mode: "100644", type: "blob", sha: blobSha, path: hash }],
    { cwd },
  );
  const rootTree = await mktree(
    [{ mode: "040000", type: "tree", sha: shardTree, path: hash.slice(0, 2) }],
    { cwd },
  );
  const commit = await commitTree(rootTree, { cwd, message: "git-for-ai: store session" });
  await updateRef(SESSIONS_REF, commit, { cwd });

  return `sha256:${hash}`;
}

describe("runShow (real git fixture with identity, ledger, and a planted session)", () => {
  let repo: FixtureRepo;
  let shaPlain: string; // pre-git-for-ai: no identity, no ledger entry
  let shaAuth: string; // change-id + two ledger entries (superseded + effective w/ session)
  let cidAuth: string;
  let sessionRef: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();

    shaPlain = await repo.commit("Initial auth scaffolding", {
      files: { "src/legacy/parser.ts": "export const legacy = true;\n" },
    });

    shaAuth = await repo.commit("auth commit (git subject, not the intent)", {
      files: { "src/auth/session.ts": "export const session = 1;\n" },
    });
    cidAuth = (await assignChangeId(shaAuth, { cwd: repo.dir })).changeId;

    sessionRef = await plantSessionRecord(makeSessionRecord(shaAuth), repo.dir);

    await appendLedgerEntry(
      cidAuth,
      makeEntry({
        changeId: cidAuth,
        revision: shaAuth,
        summary: "Original (superseded) summary",
        createdAt: "2026-07-17T09:00:00Z",
      }),
      { cwd: repo.dir },
    );
    await appendLedgerEntry(
      cidAuth,
      makeEntry({
        changeId: cidAuth,
        revision: shaAuth,
        summary: "Switch session store to signed-cookie tokens",
        createdAt: "2026-07-18T09:00:00Z",
        sessionRef,
        confidence: 0.82,
        intent: "Make auth stateless so the API can run >1 replica",
      }),
      { cwd: repo.dir },
    );
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("renders commit, change-id, change-map facts, and all ledger entries with the effective one marked", async () => {
    const { data, output } = await runShow(shaAuth, { cwd: repo.dir });

    expect(data.commit).toMatchObject({
      sha: shaAuth,
      subject: "auth commit (git subject, not the intent)",
    });
    expect(data.changeId).toBe(cidAuth);
    expect(data.changeMap).toMatchObject({
      change_id: cidAuth,
      head: shaAuth,
      history: [shaAuth],
    });

    // Both entries present, oldest first, effective marked on the newer one only.
    expect(data.ledger).toHaveLength(2);
    expect(data.ledger.map((row) => row.effective)).toEqual([false, true]);
    expect(data.ledger[0]!.entry.summary).toBe("Original (superseded) summary");
    expect(data.ledger[1]!.entry.summary).toBe("Switch session store to signed-cookie tokens");
    expect(data.ledger[1]!.noteCommit).toBe(shaAuth);
    expect(data.warnings).toEqual([]);

    // Rendered output covers the same facts.
    expect(output).toContain(`commit       ${shaAuth}`);
    expect(output).toContain("subject      auth commit (git subject, not the intent)");
    expect(output).toContain(`change       ${cidAuth}`);
    expect(output).toContain(`head         ${shaAuth}`);
    expect(output).toContain(`origin       ${data.changeMap!.origin}`);
    expect(output).toContain("ledger       2 entries (* = effective)");
    expect(output).toContain("Switch session store to signed-cookie tokens");
    expect(output).toContain("Original (superseded) summary");
    expect(output).toContain("(effective)");
    expect(output).toContain("(superseded)");
    expect(output).toContain("intent     Make auth stateless so the API can run >1 replica");
    expect(output).toContain("rejected   Redis session store — adds an infra dependency");
    expect(output).toContain("scope      src/auth/session.ts:40-118");
    expect(output).toContain("conf 0.82");
  });

  it("accepts HEAD and short-SHA commit-ish targets", async () => {
    const viaHead = await runShow("HEAD", { cwd: repo.dir });
    expect(viaHead.data.commit!.sha).toBe(shaAuth);
    expect(viaHead.data.changeId).toBe(cidAuth);

    const viaShort = await runShow(shaAuth.slice(0, 7), { cwd: repo.dir });
    expect(viaShort.data.commit!.sha).toBe(shaAuth);
    expect(viaShort.data.changeId).toBe(cidAuth);
  });

  it("resolves a c/<change-id> target through the change-map", async () => {
    const { data, output } = await runShow(`c/${cidAuth}`, { cwd: repo.dir });

    expect(data.changeId).toBe(cidAuth);
    expect(data.commit!.sha).toBe(shaAuth);
    expect(data.ledger).toHaveLength(2);
    expect(output).toContain("Switch session store to signed-cookie tokens");

    // Unambiguous prefix form (as used across the CLI_REFERENCE examples) also resolves.
    const viaPrefix = await runShow(`c/${cidAuth.slice(0, 8)}`, { cwd: repo.dir });
    expect(viaPrefix.data.changeId).toBe(cidAuth);
  });

  it("errors clearly for an unknown c/<change-id>", async () => {
    await expect(
      runShow("c/00000000000000000000000000000000", { cwd: repo.dir }),
    ).rejects.toThrow(/not found in the change-map/);
  });

  it("renders honest absence for a commit with no identity and no ledger entry", async () => {
    const { data, output } = await runShow(shaPlain, { cwd: repo.dir });

    expect(data.commit!.sha).toBe(shaPlain);
    expect(data.changeId).toBeNull();
    expect(data.changeMap).toBeNull();
    expect(data.ledger).toEqual([]);
    expect(data.session).toEqual({ ref: null, status: "none" });

    expect(output).toContain("no identity: no change-map entry and no Change-Id trailer");
    expect(output).toContain("ledger       no captured intent");
    expect(output).toContain("session      none recorded");
    // Never fabricated: the only summary-ish text is the commit's own subject line.
    expect(output).toContain("subject      Initial auth scaffolding");
  });

  it("does not mint change-map rows for no-identity commits as a side effect", async () => {
    await runShow(shaPlain, { cwd: repo.dir });
    const again = await runShow(shaPlain, { cwd: repo.dir });
    expect(again.data.changeId).toBeNull();
  });

  it("reads the planted session record and summarizes it without --session", async () => {
    const { data, output } = await runShow(shaAuth, { cwd: repo.dir });

    expect(data.session.status).toBe("available");
    expect(data.session.ref).toBe(sessionRef);
    expect(data.session.record).toMatchObject({
      session_id: "b1e2c3d4-5678-90ab-cdef-1234567890ab",
      source_fingerprint: "claude-code-jsonl/2026.07",
    });

    expect(output).toContain(`session      ${sessionRef}`);
    expect(output).toContain("agent      claude-code 2.x (claude-opus-4-8)");
    expect(output).toContain("spans      2  (run with --session to include the span trace)");
    // Without --session the span trace itself is not dumped.
    expect(output).not.toContain("Extract session logic");
  });

  it("--session includes the full span trace", async () => {
    const { output } = await runShow(shaAuth, { cwd: repo.dir, session: true });

    expect(output).toContain("s1  agent.plan");
    expect(output).toContain("Extract session logic");
    expect(output).toContain("s2  gen_ai.tool.execution  Edit");
    expect(output).toContain('"file":"src/auth/session.ts"');
    expect(output).not.toContain("run with --session");
  });

  it("--json output parses and contains the same facts", async () => {
    const { output } = await runShow(shaAuth, { cwd: repo.dir, json: true });

    const parsed = JSON.parse(output) as ShowData;
    expect(parsed.commit!.sha).toBe(shaAuth);
    expect(parsed.changeId).toBe(cidAuth);
    expect(parsed.changeMap!.head).toBe(shaAuth);
    expect(parsed.ledger).toHaveLength(2);
    expect(parsed.ledger[1]!.effective).toBe(true);
    expect(parsed.ledger[1]!.entry.summary).toBe("Switch session store to signed-cookie tokens");
    expect(parsed.session.status).toBe("available");
    expect(parsed.session.record!.session_id).toBe("b1e2c3d4-5678-90ab-cdef-1234567890ab");
    expect(parsed.warnings).toEqual([]);
  });

  it("throws a clear error for an unresolvable commit-ish target", async () => {
    await expect(runShow("no-such-ref", { cwd: repo.dir })).rejects.toThrow(
      /cannot resolve 'no-such-ref' to a commit/,
    );
  });
});

describe("runShow degraded session cases", () => {
  it("renders 'session trace unavailable' for a dangling session_ref (no sessions ref at all)", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("dangling session commit", {
        files: { "src/a.ts": "export const a = 1;\n" },
      });
      const { changeId } = await assignChangeId(sha, { cwd: repo.dir });
      const danglingRef = `sha256:${"ab".repeat(32)}`;
      await appendLedgerEntry(
        changeId,
        makeEntry({
          changeId,
          revision: sha,
          summary: "Entry with a dangling session pointer",
          createdAt: "2026-07-17T09:00:00Z",
          sessionRef: danglingRef,
        }),
        { cwd: repo.dir },
      );

      const { data, output } = await runShow(sha, { cwd: repo.dir });

      expect(data.session.status).toBe("unavailable");
      expect(data.session.ref).toBe(danglingRef);
      expect(data.session.reason).toContain("does not exist");
      expect(output).toContain("session trace unavailable");
      // The ledger itself still renders normally.
      expect(output).toContain("Entry with a dangling session pointer");
    } finally {
      await repo.cleanup();
    }
  });

  it("renders 'session trace unavailable' when the sessions ref exists but lacks the object", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("missing object commit", {
        files: { "src/b.ts": "export const b = 1;\n" },
      });
      const { changeId } = await assignChangeId(sha, { cwd: repo.dir });
      // Plant SOME session so the ref exists, but point the entry at a different hash.
      await plantSessionRecord(makeSessionRecord(sha), repo.dir);
      const missingRef = `sha256:${"cd".repeat(32)}`;
      await appendLedgerEntry(
        changeId,
        makeEntry({
          changeId,
          revision: sha,
          summary: "Entry pointing at a missing session object",
          createdAt: "2026-07-17T09:00:00Z",
          sessionRef: missingRef,
        }),
        { cwd: repo.dir },
      );

      const { data, output } = await runShow(sha, { cwd: repo.dir });

      expect(data.session.status).toBe("unavailable");
      expect(data.session.reason).toContain("no session object");
      expect(output).toContain("session trace unavailable");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runShow malformed ledger note", () => {
  it("surfaces an unreadable note as an explicit warning instead of crashing or hiding it", async () => {
    const repo = await createFixtureRepo();
    try {
      const sha = await repo.commit("commit with a corrupt note", {
        files: { "src/c.ts": "export const c = 1;\n" },
      });
      await repo.run(["notes", `--ref=${INTENT_REF}`, "add", "-m", "this is not JSON at all", sha]);

      const { data, output } = await runShow(sha, { cwd: repo.dir });

      expect(data.ledger).toEqual([]);
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0]).toContain(sha);
      expect(data.warnings[0]).toContain("unreadable");
      expect(output).toContain("ledger       no captured intent");
      expect(output).toContain("warnings");
      expect(output).toContain("! ledger note on commit");
    } finally {
      await repo.cleanup();
    }
  });
});

// Blame-position tests — real fixture repo, real git blame, real change-map /
// ledger / session write paths from the identity, ledger and session modules. No embedding model, no vector store:
// `explainLine` must produce the full §9.1 blame payload from git-native records alone.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "../git/testFixtures.js";
import { assignChangeId } from "../identity/assign.js";
import { formatChangeIdTrailer, mintChangeId } from "../identity/changeId.js";
import { readChangeMapEntry } from "../identity/changeMap.js";
import { appendLedgerEntry } from "../ledger/intentNotes.js";
import { writeSessionRecord } from "../sessions/store.js";

import { blameLineCommit } from "./blame.js";
import { resolveChangeIdReadOnly } from "./enrich.js";
import { explainLine } from "./engine.js";
import { makeLedgerEntry, makeSessionRecord } from "./testSupport.js";

const AUTH_FILE = "src/auth/session.ts";
const AUTH_V1 = "export function signSessionCookie() {}\nexport const SESSION_TTL = 3600;\n";
const AUTH_V2 = AUTH_V1 + "export function rotateToken() {}\n";

let repo: FixtureRepo;
let sha1: string; // introduces AUTH_FILE — has ledger entry + session
let sha2: string; // later touch on AUTH_FILE — has its own ledger entry
let sha3: string; // pre-git-for-ai commit (no identity at all)
let changeId1: string;
let changeId2: string;
let sessionRef: string;

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };

  // Change 1: agent-captured change with session trace (the §9.1 happy path).
  sha1 = await repo.commit("Move session state to signed cookies", {
    files: { [AUTH_FILE]: AUTH_V1 },
  });
  ({ changeId: changeId1 } = await assignChangeId(sha1, ctx));
  const blob1 = (await repo.run(["rev-parse", `${sha1}:${AUTH_FILE}`])).stdout;
  ({ sessionRef } = await writeSessionRecord(
    makeSessionRecord({
      sessionId: "sess-1",
      capturedAt: "2026-07-17T10:00:00Z",
      sinceSha: sha1,
      untilSha: sha1,
      summary: "Replaced the in-process session map with signed cookies",
    }),
    ctx,
  ));
  await appendLedgerEntry(
    changeId1,
    makeLedgerEntry({
      changeId: changeId1,
      revision: sha1,
      createdAt: "2026-07-17T10:00:00Z",
      summary: "Move session state to signed cookies",
      scopePath: AUTH_FILE,
      scopeBlob: blob1,
      sessionRef,
      intent: "run more than one replica without sticky sessions",
      rejectedOption: "Redis session store",
      rejectedWhy: "avoid adding an infra dependency",
      confidence: 0.82,
    }),
    ctx,
  );

  // Change 2: a later touch on the same file (feeds "LATER TOUCHED BY").
  sha2 = await repo.commit("add token rotation", { files: { [AUTH_FILE]: AUTH_V2 } });
  ({ changeId: changeId2 } = await assignChangeId(sha2, ctx));
  const blob2 = (await repo.run(["rev-parse", `${sha2}:${AUTH_FILE}`])).stdout;
  await appendLedgerEntry(
    changeId2,
    makeLedgerEntry({
      changeId: changeId2,
      revision: sha2,
      createdAt: "2026-07-19T09:00:00Z",
      summary: "add token rotation",
      scopePath: AUTH_FILE,
      scopeBlob: blob2,
    }),
    ctx,
  );

  // A commit with no git-for-ai identity at all (pre-adoption history).
  sha3 = await repo.commit("legacy docs", { files: { "docs/legacy.md": "old notes\n" } });
});

afterAll(async () => {
  await repo.cleanup();
});

describe("blameLineCommit", () => {
  it("attributes an unchanged line to the commit that introduced it", async () => {
    expect(await blameLineCommit({ path: AUTH_FILE, line: 1 }, { cwd: repo.dir })).toBe(sha1);
  });

  it("attributes a later-added line to the later commit", async () => {
    expect(await blameLineCommit({ path: AUTH_FILE, line: 3 }, { cwd: repo.dir })).toBe(sha2);
  });

  it("returns null for an uncommitted line", async () => {
    await repo.writeFile("docs/legacy.md", "old notes\nnew uncommitted line\n");
    expect(await blameLineCommit({ path: "docs/legacy.md", line: 2 }, { cwd: repo.dir })).toBeNull();
    // Restore for later tests.
    await repo.writeFile("docs/legacy.md", "old notes\n");
  });

  it("throws (caller error) for a path git cannot blame", async () => {
    await expect(
      blameLineCommit({ path: "no/such/file.ts", line: 1 }, { cwd: repo.dir }),
    ).rejects.toThrow(/git blame failed/);
  });
});

describe("explainLine (no index — git records only)", () => {
  it("produces the full §9.1 blame payload for an agent-captured line", async () => {
    const result = await explainLine({ ctx: { cwd: repo.dir } }, { path: AUTH_FILE, line: 1 });

    expect(result.commit).toBe(sha1);
    expect(result.changeId).toBe(changeId1);
    expect(result.resolvedVia).toBe("map");
    expect(result.changeMapEntry?.head).toBe(sha1);

    // The WHY payload the CLI renders.
    expect(result.entry?.summary).toBe("Move session state to signed cookies");
    expect(result.entry?.provenance).toBe("agent-captured");
    expect(result.entry?.reasoning?.confidence).toBe(0.82);
    expect(result.entry?.reasoning?.rejected?.[0]?.option).toBe("Redis session store");
    expect(result.entries).toHaveLength(1);

    // Full session record, no re-fetch needed downstream.
    expect(result.sessionRecord?.session_id).toBe("sess-1");
    expect(result.sessionRecord?.agent.tool).toBe("claude-code");

    // LATER TOUCHED BY: change 2 touched the same file, later.
    expect(result.laterTouchedBy).toEqual([
      { changeId: changeId2, createdAt: "2026-07-19T09:00:00Z", summary: "add token rotation" },
    ]);

    // No index provided → no supplementary sources; synthesis off by default.
    expect(result.sources).toEqual([]);
    expect(result.synthesis.synthesized).toBe(false);
    expect(result.synthesis.skippedReason).toBe("not-requested");
    expect(result.warnings).toEqual([]);
  });

  it("does not list the blamed change itself, or earlier changes, as later touches", async () => {
    const result = await explainLine({ ctx: { cwd: repo.dir } }, { path: AUTH_FILE, line: 3 });
    expect(result.changeId).toBe(changeId2);
    expect(result.laterTouchedBy).toEqual([]);
  });

  it("degrades honestly for a pre-git-for-ai line: no identity, no intent", async () => {
    const result = await explainLine({ ctx: { cwd: repo.dir } }, { path: "docs/legacy.md", line: 1 });
    expect(result.commit).toBe(sha3);
    expect(result.changeId).toBeNull();
    expect(result.resolvedVia).toBeNull();
    expect(result.entry).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.sessionRecord).toBeNull();
    expect(result.laterTouchedBy).toEqual([]);
  });
});

describe("resolveChangeIdReadOnly", () => {
  it("recovers identity from a Change-Id trailer WITHOUT writing a map row", async () => {
    const trailerId = mintChangeId();
    const sha = await repo.commit(`trailer-only commit\n\n${formatChangeIdTrailer(trailerId)}`, {
      files: { "docs/trailer.md": "x\n" },
    });

    const resolved = await resolveChangeIdReadOnly(sha, { cwd: repo.dir });
    expect(resolved).toEqual({ changeId: trailerId, entry: null, via: "trailer" });

    // Read path healed nothing: the map still has no row (read commands never mint).
    expect(await readChangeMapEntry(trailerId, { cwd: repo.dir })).toBeNull();
  });

  it("returns null for a commit with no identity anywhere", async () => {
    expect(await resolveChangeIdReadOnly(sha3, { cwd: repo.dir })).toBeNull();
  });
});

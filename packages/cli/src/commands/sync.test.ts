// Integration tests for `git for-ai sync` against REAL local bare remotes
// (createFixtureRepo bare:true — never mocked):
// push from one repo, fetch into a second, round-trip intact; and the divergent-notes
// scenario proving the JSONL note format union-merges cleanly
// under git's real cat_sort_uniq.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendLedgerEntry,
  readLedgerEntries,
  resolveEffectiveEntry,
  writeSessionRecord,
  readSessionRecord,
  upsertChangeMapEntries,
  readChangeMapEntry,
  INTENT_NOTES_REF,
  SESSIONS_REF,
  CHANGE_MAP_REF,
  runGit,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";
import type { ChangeMapEntry, LedgerEntry, SessionRecord } from "@git-for-ai/schemas";

import { GIT_FOR_AI_REFSPECS, REFSPEC_CONFIG_KEY } from "./init.js";
import { runSync } from "./sync.js";

const CHANGE_ID = "9f2c1a7b6e4d0f83c5a1b2d3e4f50617";

function makeEntry(revision: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: CHANGE_ID,
    revision,
    created_at: "2026-07-17T09:22:41Z",
    author: { type: "agent", tool: "claude-code", model: "claude-fable-5" },
    scope: [{ path: "a.txt", blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f" }],
    summary: "Initial entry.",
    session_ref: null,
    provenance: "agent-captured",
    ...overrides,
  };
}

function makeSession(id: string): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: id,
    agent: { tool: "claude-code", version: "2.0.0", model: "claude-fable-5" },
    captured_at: "2026-07-17T09:22:41Z",
    commit_range: {
      since: "a".repeat(40),
      until: "b".repeat(40),
    },
    redaction: { applied: true, redacted_count: 0, rules: ["builtin@1"] },
    source_fingerprint: "claude-code-jsonl@1",
    spans: [
      { span_id: "s1", kind: "agent.plan", name: "plan", body: { text: `hello ${id}` } },
    ],
  };
}

function makeMapEntry(changeId: string, head: string, history: string[]): ChangeMapEntry {
  return {
    schema: "git-for-ai/change-map-entry@1",
    change_id: changeId,
    head,
    history,
    trailer_seen: true,
    origin: "post-commit",
    updated_at: "2026-07-17T09:22:41Z",
  };
}

/** Configure a working repo for sync: refspecs + a remote pointing at the bare repo. */
async function wireForSync(repo: FixtureRepo, bare: FixtureRepo, remote = "origin"): Promise<void> {
  for (const spec of GIT_FOR_AI_REFSPECS) {
    await repo.run(["config", "--add", REFSPEC_CONFIG_KEY, spec]);
  }
  await repo.run(["remote", "add", remote, bare.dir.replace(/\\/g, "/")]);
}

describe("sync (real bare remotes)", () => {
  let repoA: FixtureRepo;
  let repoB: FixtureRepo;
  let bare: FixtureRepo;
  let shaA: string;

  beforeEach(async () => {
    bare = await createFixtureRepo({ bare: true });
    repoA = await createFixtureRepo();
    shaA = await repoA.commit("first commit", { files: { "a.txt": "a" } });
    await wireForSync(repoA, bare);

    // Second clone: same commit history (clone from A via the bare after A pushes main),
    // built lazily inside tests that need it.
    repoB = await createFixtureRepo();
  });

  afterEach(async () => {
    await repoA.cleanup();
    await repoB.cleanup();
    await bare.cleanup();
  });

  /** Push A's main branch into the bare and clone-equivalent into B (fetch + reset). */
  async function mirrorHistoryIntoB(): Promise<void> {
    await repoA.run(["push", bare.dir.replace(/\\/g, "/"), "main:main"]);
    await wireForSync(repoB, bare);
    await repoB.run(["fetch", "origin", "main"]);
    await repoB.run(["reset", "--hard", "FETCH_HEAD"]);
  }

  it("fails with an actionable error when refspecs are not configured (no init)", async () => {
    const raw = await createFixtureRepo();
    try {
      await raw.commit("c", { files: { "x.txt": "x" } });
      await expect(runSync({ cwd: raw.dir })).rejects.toThrow(/git for-ai init/);
    } finally {
      await raw.cleanup();
    }
  });

  it("fails with an actionable error when the remote does not exist", async () => {
    await expect(runSync({ cwd: repoA.dir, remote: "upstream" })).rejects.toThrow(
      /remote 'upstream' is not configured/,
    );
  });

  it("pushes all three refs to a bare remote, with per-ref reporting and the consent gate", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(shaA), { cwd: repoA.dir });
    await writeSessionRecord(makeSession("session-a"), { cwd: repoA.dir });
    await upsertChangeMapEntries([makeMapEntry(CHANGE_ID, shaA, [shaA])], { cwd: repoA.dir });

    // Off-TTY without --yes: refused, nothing pushed.
    await expect(runSync({ cwd: repoA.dir, push: true })).rejects.toThrow(/--yes/);
    let remoteRefs = await repoA.run(["ls-remote", "origin"]);
    expect(remoteRefs.stdout).not.toContain("refs/notes/git-for-ai/intent");

    // Declined confirmation: aborted, nothing pushed.
    const decline = vi.fn().mockResolvedValue(false);
    const aborted = await runSync({ cwd: repoA.dir, push: true, confirm: decline });
    expect(aborted.pushAborted).toBe(true);
    expect(decline.mock.calls[0]![0]).toContain("About to push session data to origin");
    remoteRefs = await repoA.run(["ls-remote", "origin"]);
    expect(remoteRefs.stdout).not.toContain("refs/notes/git-for-ai/intent");

    // Confirmed: all three refs land, each reported.
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await runSync({ cwd: repoA.dir, push: true, confirm });
    expect(result.exitCode).toBe(0);
    expect(result.pushed.map((r) => [r.ref, r.action])).toEqual([
      [CHANGE_MAP_REF, "pushed"],
      [SESSIONS_REF, "pushed"],
      [INTENT_NOTES_REF, "pushed"],
    ]);
    expect(result.output).toContain("✓ pushed 3 refs to origin");
    // The privacy reminder names payloads honestly.
    expect(confirm.mock.calls[0]![0]).toMatch(/1 entry on 1 commit/);
    expect(confirm.mock.calls[0]![0]).toMatch(/1 trace, redacted/);
    expect(confirm.mock.calls[0]![0]).toMatch(/1 change/);

    remoteRefs = await repoA.run(["ls-remote", "origin"]);
    expect(remoteRefs.stdout).toContain(INTENT_NOTES_REF);
    expect(remoteRefs.stdout).toContain(SESSIONS_REF);
    expect(remoteRefs.stdout).toContain(CHANGE_MAP_REF);

    // Idempotent re-push: up to date.
    const again = await runSync({ cwd: repoA.dir, push: true, yes: true });
    expect(again.pushed.every((r) => r.action === "up-to-date")).toBe(true);
  });

  it("configures notes.git-for-ai/intent.mergeStrategy = cat_sort_uniq", async () => {
    await runSync({ cwd: repoA.dir, fetch: true });
    const strategy = await repoA.run(["config", "--get", "notes.git-for-ai/intent.mergeStrategy"]);
    expect(strategy.stdout.trim()).toBe("cat_sort_uniq");
  });

  it("round-trips: push from A, fetch into B, all three refs adopted intact", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(shaA), { cwd: repoA.dir });
    const { sessionRef } = await writeSessionRecord(makeSession("session-a"), { cwd: repoA.dir });
    await upsertChangeMapEntries([makeMapEntry(CHANGE_ID, shaA, [shaA])], { cwd: repoA.dir });
    await mirrorHistoryIntoB();
    await runSync({ cwd: repoA.dir, push: true, yes: true });

    const result = await runSync({ cwd: repoB.dir, fetch: true });
    expect(result.exitCode).toBe(0);
    expect(result.fetched.map((r) => [r.ref, r.action])).toEqual([
      [CHANGE_MAP_REF, "adopted"],
      [SESSIONS_REF, "adopted"],
      [INTENT_NOTES_REF, "adopted"],
    ]);

    // Data readable in B through the normal read paths.
    expect(await readLedgerEntries(shaA, { cwd: repoB.dir })).toEqual([makeEntry(shaA)]);
    expect(await readSessionRecord(sessionRef, { cwd: repoB.dir })).not.toBeNull();
    expect(await readChangeMapEntry(CHANGE_ID, { cwd: repoB.dir })).not.toBeNull();
  });

  it("divergent notes union-merge cleanly via cat_sort_uniq (the JSONL payoff)", async () => {
    // Shared base: A records an entry and pushes everything.
    const shared = makeEntry(shaA);
    await appendLedgerEntry(CHANGE_ID, shared, { cwd: repoA.dir });
    await mirrorHistoryIntoB();
    await runSync({ cwd: repoA.dir, push: true, yes: true });
    await runSync({ cwd: repoB.dir, fetch: true });

    // Divergence: A appends its own correction and pushes; B appends a different one.
    const fromA = makeEntry(shaA, { created_at: "2026-07-17T10:00:00Z", summary: "A's correction." });
    const fromB = makeEntry(shaA, { created_at: "2026-07-17T10:30:00Z", summary: "B's correction." });
    await appendLedgerEntry(CHANGE_ID, fromA, { cwd: repoA.dir });
    await runSync({ cwd: repoA.dir, push: true, yes: true });
    await appendLedgerEntry(CHANGE_ID, fromB, { cwd: repoB.dir });

    // B syncs (fetch then push): the fetch must MERGE, not clobber or conflict.
    const syncB = await runSync({ cwd: repoB.dir, yes: true });
    expect(syncB.exitCode).toBe(0);
    const notesReport = syncB.fetched.find((r) => r.ref === INTENT_NOTES_REF);
    expect(notesReport?.action).toBe("merged");
    expect(notesReport?.detail).toBe("cat_sort_uniq union");

    // B now holds the UNION, parsed cleanly through the normal reader.
    const inB = await readLedgerEntries(shaA, { cwd: repoB.dir });
    expect(inB).toEqual([shared, fromA, fromB]);
    expect(resolveEffectiveEntry(inB!)).toEqual(fromB);

    // A fetches B's push: same union, no conflict, byte-identical shared entry deduped.
    const syncA = await runSync({ cwd: repoA.dir, fetch: true });
    expect(syncA.exitCode).toBe(0);
    const inA = await readLedgerEntries(shaA, { cwd: repoA.dir });
    expect(inA).toEqual([shared, fromA, fromB]);
  });

  it("divergent sessions union-merge (content-addressed, both traces kept)", async () => {
    const writeA = await writeSessionRecord(makeSession("only-in-a"), { cwd: repoA.dir });
    await mirrorHistoryIntoB();
    await runSync({ cwd: repoA.dir, push: true, yes: true });

    // B writes its own session WITHOUT fetching first — divergence by construction.
    const writeB = await writeSessionRecord(makeSession("only-in-b"), { cwd: repoB.dir });

    const syncB = await runSync({ cwd: repoB.dir, yes: true });
    const sessionsReport = syncB.fetched.find((r) => r.ref === SESSIONS_REF);
    expect(sessionsReport?.action).toBe("merged");
    expect(sessionsReport?.detail).toBe("content-addressed union");

    // Both traces resolvable in B; after A fetches, both resolvable in A too.
    expect(await readSessionRecord(writeA.sessionRef, { cwd: repoB.dir })).not.toBeNull();
    expect(await readSessionRecord(writeB.sessionRef, { cwd: repoB.dir })).not.toBeNull();

    await runSync({ cwd: repoA.dir, fetch: true });
    expect(await readSessionRecord(writeB.sessionRef, { cwd: repoA.dir })).not.toBeNull();
  });

  it("a divergent change-map is reported and kept local (exit 2), never silently merged", async () => {
    await upsertChangeMapEntries([makeMapEntry(CHANGE_ID, shaA, [shaA])], { cwd: repoA.dir });
    await mirrorHistoryIntoB();
    await runSync({ cwd: repoA.dir, push: true, yes: true });
    await runSync({ cwd: repoB.dir, fetch: true });

    // Both sides mutate the map independently.
    const otherId = "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4";
    await upsertChangeMapEntries([makeMapEntry(otherId, shaA, [shaA])], { cwd: repoA.dir });
    await runSync({ cwd: repoA.dir, push: true, yes: true });
    const thirdId = "11112222333344445555666677778888";
    await upsertChangeMapEntries([makeMapEntry(thirdId, shaA, [shaA])], { cwd: repoB.dir });

    const before = await repoB.run(["rev-parse", CHANGE_MAP_REF]);
    const syncB = await runSync({ cwd: repoB.dir, fetch: true });
    expect(syncB.exitCode).toBe(2);
    const mapReport = syncB.fetched.find((r) => r.ref === CHANGE_MAP_REF);
    expect(mapReport?.action).toBe("divergent-kept-local");
    expect(syncB.warnings.some((w) => w.includes("diverged"))).toBe(true);
    // Local map untouched.
    const after = await repoB.run(["rev-parse", CHANGE_MAP_REF]);
    expect(after.stdout).toBe(before.stdout);
  });

  it("--dry-run moves no data in either direction", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(shaA), { cwd: repoA.dir });

    const result = await runSync({ cwd: repoA.dir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.pushed.every((r) => r.action === "would-push")).toBe(true);

    const remoteRefs = await repoA.run(["ls-remote", "origin"]);
    expect(remoteRefs.stdout).not.toContain(INTENT_NOTES_REF);
  });

  it("fetch leaves no staging refs behind", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(shaA), { cwd: repoA.dir });
    await mirrorHistoryIntoB();
    await runSync({ cwd: repoA.dir, push: true, yes: true });
    await runSync({ cwd: repoB.dir, fetch: true });

    const refs = await repoB.run(["for-each-ref", "--format=%(refname)"]);
    expect(refs.stdout).not.toMatch(/git-for-ai-sync/);
  });
});

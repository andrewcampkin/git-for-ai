// Integration tests for `git for-ai doctor` against REAL fixture repos (never mocked),
// covering the CLI_REFERENCE checks plus the PLAN_2026-07-18.md W3-#11 audits: inferred/
// orphan-recovery origin rows, dangling session refs, unreadable + legacy-format notes,
// and the hooks-installed-but-dispatcher-missing class.
//
// Doctor is READ-ONLY: several tests assert it minted/changed nothing.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLedgerEntry,
  notesAppend,
  upsertChangeMapEntries,
  writeSessionRecord,
  readAllChangeMapEntries,
  updateIndexState,
  modelFingerprint,
  resolveTransformersDevice,
  INTENT_NOTES_REF,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";
import type { ChangeMapEntry, LedgerEntry, SessionRecord } from "@git-for-ai/schemas";

import { runInit } from "./init.js";
import { runDoctor, findDispatcherOnPath, type DoctorCheck } from "./doctor.js";

const CHANGE_ID = "9f2c1a7b6e4d0f83c5a1b2d3e4f50617";

function makeEntry(revision: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: CHANGE_ID,
    revision,
    created_at: "2026-07-17T09:22:41Z",
    author: { type: "agent", tool: "claude-code", model: "claude-fable-5" },
    scope: [{ path: "a.txt", blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f" }],
    summary: "Entry.",
    session_ref: null,
    provenance: "agent-captured",
    ...overrides,
  };
}

function makeMapEntry(overrides: Partial<ChangeMapEntry> & { change_id: string; head: string }): ChangeMapEntry {
  return {
    schema: "git-for-ai/change-map-entry@1",
    history: [overrides.head],
    trailer_seen: true,
    origin: "post-commit",
    updated_at: "2026-07-17T09:22:41Z",
    ...overrides,
  };
}

function makeSession(id: string): SessionRecord {
  return {
    schema: "git-for-ai/session@1",
    session_id: id,
    agent: { tool: "claude-code", version: "2.0.0", model: "claude-fable-5" },
    captured_at: "2026-07-17T09:22:41Z",
    commit_range: { since: "a".repeat(40), until: "b".repeat(40) },
    redaction: { applied: true, redacted_count: 0, rules: ["builtin@1"] },
    source_fingerprint: "claude-code-jsonl@1",
    spans: [{ span_id: "s1", kind: "agent.plan", name: "plan" }],
  };
}

/** A PATH that contains a fake git-for-ai executable (so `dispatcher` reads ✓). */
async function makeDispatcherPath(repo: FixtureRepo): Promise<string> {
  const binDir = join(repo.dir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const name = process.platform === "win32" ? "git-for-ai.cmd" : "git-for-ai";
  const path = join(binDir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return binDir;
}

const byName = (checks: DoctorCheck[], name: string): DoctorCheck => {
  const found = checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(`no doctor check named ${name} (have: ${checks.map((c) => c.name).join(", ")})`);
  }
  return found;
};

describe("doctor (real git fixture)", () => {
  let repo: FixtureRepo;
  let sha: string;
  let goodPath: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
    goodPath = await makeDispatcherPath(repo);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("reports an uninitialized repo as unhealthy with `init` remediation, without crashing", async () => {
    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    expect(result.data.exitCode).toBe(3);
    expect(byName(result.data.checks, "hooks").status).toBe("error");
    expect(byName(result.data.checks, "config").status).toBe("error");
    expect(byName(result.data.checks, "refspecs").status).toBe("error");
    expect(result.output).toContain("git for-ai init");
    expect(result.output).toMatch(/\[exit 3\]/);
  });

  it("a freshly-initialized repo is warnings-only (index not built, model not cached)", async () => {
    await runInit({ cwd: repo.dir });
    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });

    expect(byName(result.data.checks, "hooks").status).toBe("ok");
    expect(byName(result.data.checks, "dispatcher").status).toBe("ok");
    expect(byName(result.data.checks, "claude hooks").status).toBe("ok");
    expect(byName(result.data.checks, "refspecs").status).toBe("ok");
    expect(byName(result.data.checks, "config").status).toBe("ok");
    expect(byName(result.data.checks, "index").status).toBe("warn"); // never built
    expect(byName(result.data.checks, "identity").status).toBe("ok");
    expect(byName(result.data.checks, "ledger").status).toBe("ok");
    expect(byName(result.data.checks, "sessions").status).toBe("ok");
    expect(byName(result.data.checks, "captures").status).toBe("ok");
    expect(result.data.errors).toBe(0);
  });

  it("detects hooks-installed-but-dispatcher-missing (the HANDOFF #1 failure class)", async () => {
    await runInit({ cwd: repo.dir });
    // An empty PATH: hooks are installed but nothing can dispatch them.
    const result = await runDoctor({ cwd: repo.dir, pathEnv: join(repo.dir, "no-such-dir") });
    const dispatcher = byName(result.data.checks, "dispatcher");
    expect(dispatcher.status).toBe("error");
    expect(dispatcher.message).toContain("hooks are installed but no `git-for-ai` executable is on PATH");
    expect(result.data.exitCode).toBe(3);
  });

  it("findDispatcherOnPath finds the executable PATHEXT-style", async () => {
    expect(findDispatcherOnPath(goodPath)).not.toBeNull();
    expect(findDispatcherOnPath(join(repo.dir, "definitely-absent"))).toBeNull();
  });

  it("warns when .claude/settings.json lacks the capture hooks", async () => {
    await runInit({ cwd: repo.dir, claudeHooks: false });
    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const claude = byName(result.data.checks, "claude hooks");
    expect(claude.status).toBe("warn");
    expect(claude.remediation.join(" ")).toContain("git for-ai init");
  });

  it("audits identity origins: inferred, orphan-recovery, trailer-recovery, divergent heads", async () => {
    await runInit({ cwd: repo.dir });
    const sha2 = await repo.commit("second", { files: { "b.txt": "b" } });
    await upsertChangeMapEntries(
      [
        makeMapEntry({ change_id: CHANGE_ID, head: sha, origin: "inferred" }),
        makeMapEntry({
          change_id: "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4",
          head: sha2,
          origin: "orphan-recovery",
        }),
        makeMapEntry({
          change_id: "11112222333344445555666677778888",
          head: sha2,
          origin: "trailer-recovery",
          divergent_heads: [sha, sha2],
        }),
      ],
      { cwd: repo.dir },
    );

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const identity = byName(result.data.checks, "identity");
    expect(identity.status).toBe("warn");
    expect(identity.message).toContain("origin `inferred`");
    expect(identity.message).toContain("orphan-recovery");
    expect(identity.message).toContain("recovered via trailer");
    expect(identity.message).toContain("divergent heads");
    expect(identity.remediation.join("\n")).toContain("git for-ai reconcile");
    expect(identity.remediation.join("\n")).toContain("relink");
  });

  it("flags change heads no branch/tag reaches (DESKTOP.md G1: squash-then-delete)", async () => {
    await runInit({ cwd: repo.dir });
    // A change whose head is a commit on a deleted branch: create it, map it, delete it.
    await repo.run(["checkout", "-b", "doomed"]);
    const doomedSha = await repo.commit("doomed work", { files: { "d.txt": "d" } });
    await repo.run(["checkout", "main"]);
    await repo.run(["branch", "-D", "doomed"]);
    await upsertChangeMapEntries(
      [
        makeMapEntry({ change_id: CHANGE_ID, head: sha, origin: "post-commit" }), // reachable
        makeMapEntry({
          change_id: "beefbeefbeefbeefbeefbeefbeefbeef",
          head: doomedSha,
          origin: "post-commit",
        }),
      ],
      { cwd: repo.dir },
    );

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const identity = byName(result.data.checks, "identity");
    expect(identity.status).toBe("warn");
    expect(identity.message).toContain("no branch/tag reaches");
    expect(identity.remediation.join("\n")).toContain("c/beefbeef");
    expect(identity.remediation.join("\n")).toContain("relink");
  });

  it("flags unreadable notes and dangling session refs; healthy refs stay quiet", async () => {
    await runInit({ cwd: repo.dir });
    const sha2 = await repo.commit("second", { files: { "b.txt": "b" } });

    // A stored session, a dangling ref, and an unreadable note.
    const { sessionRef } = await writeSessionRecord(makeSession("real"), { cwd: repo.dir });
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha, { session_ref: sessionRef }), {
      cwd: repo.dir,
    });
    await appendLedgerEntry(
      "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4",
      makeEntry(sha2, {
        change_id: "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4",
        session_ref: `sha256:${"f".repeat(64)}`,
      }),
      { cwd: repo.dir },
    );
    const sha3 = await repo.commit("third", { files: { "c.txt": "c" } });
    await notesAppend(INTENT_NOTES_REF, sha3, "this is not json", { cwd: repo.dir });

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const ledger = byName(result.data.checks, "ledger");
    expect(ledger.status).toBe("error");
    expect(ledger.message).toContain("1 unreadable note");
    const sessions = byName(result.data.checks, "sessions");
    expect(sessions.status).toBe("warn");
    expect(sessions.message).toContain("1 dangling session ref");
    expect(result.data.exitCode).toBe(3);
  });

  it("warns about legacy-envelope notes (they cannot union-merge until migrated)", async () => {
    await runInit({ cwd: repo.dir });
    const legacyBody = JSON.stringify(
      { schema: "git-for-ai/ledger-note@1", change_id: CHANGE_ID, entries: [makeEntry(sha)] },
      null,
      2,
    );
    await notesAppend(INTENT_NOTES_REF, sha, legacyBody, { cwd: repo.dir });

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const ledger = byName(result.data.checks, "ledger");
    expect(ledger.status).toBe("warn");
    expect(ledger.message).toContain("legacy envelope format");
    expect(ledger.remediation.join(" ")).toContain("migrate to JSONL on their next append");
  });

  it("surfaces fail-closed skipped captures via redaction_note", async () => {
    await runInit({ cwd: repo.dir });
    await appendLedgerEntry(
      CHANGE_ID,
      makeEntry(sha, { redaction_note: "session dropped: redaction pass failed" }),
      { cwd: repo.dir },
    );
    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const captures = byName(result.data.checks, "captures");
    expect(captures.status).toBe("warn");
    expect(captures.message).toContain("redaction fail-closed");
  });

  it("reports index fingerprint mismatch as an error naming reindex --full", async () => {
    await runInit({ cwd: repo.dir });
    const gitForAiDir = join(repo.dir, ".git-for-ai");
    await updateIndexState(gitForAiDir, {
      last_indexed_commit: sha,
      model_fingerprint: "someone-else/123",
      vec_schema_version: 1,
      chunk_count: 7,
    });

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const index = byName(result.data.checks, "index");
    expect(index.status).toBe("error");
    expect(index.message).toContain("someone-else/123");
    expect(index.remediation.join(" ")).toContain("reindex --full");
  });

  it("reports index staleness as a warning when HEAD moved past last_indexed_commit", async () => {
    await runInit({ cwd: repo.dir });
    const gitForAiDir = join(repo.dir, ".git-for-ai");
    await updateIndexState(gitForAiDir, {
      last_indexed_commit: sha,
      // The CURRENT platform's resolved fingerprint (GPU machines fold fp16 in) — a
      // hard-coded legacy value would read as a fingerprint MISMATCH here, not staleness.
      model_fingerprint: modelFingerprint("jina-v2-code", 768, resolveTransformersDevice().dtype),
      vec_schema_version: 1,
      chunk_count: 7,
    });
    await repo.commit("newer", { files: { "d.txt": "d" } });

    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    const index = byName(result.data.checks, "index");
    expect(index.status).toBe("warn");
    expect(index.message).toContain("STALE");
    expect(index.remediation.join(" ")).toContain("git for-ai reindex");
  });

  it("is read-only: never mints change-map rows or touches notes", async () => {
    await runInit({ cwd: repo.dir });
    // A commit with a note but NO identity: a minting read (resolveChangeId) would
    // create an orphan map row for it.
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });
    const notesBefore = await repo.run(["rev-parse", INTENT_NOTES_REF]);

    await runDoctor({ cwd: repo.dir, pathEnv: goodPath });

    expect(await readAllChangeMapEntries({ cwd: repo.dir })).toEqual([]);
    const notesAfter = await repo.run(["rev-parse", INTENT_NOTES_REF]);
    expect(notesAfter.stdout).toBe(notesBefore.stdout);
  });

  it("renders the CLI_REFERENCE row shape", async () => {
    await runInit({ cwd: repo.dir });
    const result = await runDoctor({ cwd: repo.dir, pathEnv: goodPath });
    expect(result.output.split("\n")[0]).toBe("git-for-ai doctor");
    expect(result.output).toMatch(/hooks \.+ ✓/);
    expect(result.output).toMatch(/Overall: \d+ warnings?, \d+ errors?\./);
  });
});

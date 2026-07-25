// Batched read paths (added 2026-07-25 after `report` over 41 commits took 123 SECONDS —
// almost all of it git process spawns, because every identity lookup re-read the whole
// change-map one `cat-file` at a time). The fix is these bulk readers; what they must
// guarantee is not "fast" but "identical": every one is tested here against the
// single-item reader it replaces, on real repositories.
//
// Speed itself is deliberately NOT asserted — a wall-clock threshold on a shared machine
// is a flaky test. Equivalence is the property that can actually be checked, and it is the
// one that would break silently.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { createFixtureRepo, makeLedgerEntry, type FixtureRepo } from "../testing.js";
import {
  appendLedgerEntry,
  readLedgerNote,
  readLedgerNotesForCommits,
  LedgerNoteFormatError,
} from "../ledger/index.js";
import {
  assignChangeId,
  findEntryByCommitSha,
  readAllChangeMapEntries,
  readChangeMapSnapshot,
  upsertChangeMapEntries,
} from "../identity/index.js";
import { readSessionRecord, readSessionRecords, writeSessionRecord } from "../sessions/index.js";
import { makeSessionRecord } from "../query/testSupport.js";
import { catFileBatch } from "./read.js";
import { hashObject } from "./plumbing.js";

const FAKE_BLOB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("catFileBatch", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    await repo.commit("seed", { files: { "a.txt": "one\n" } });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("reads many blobs in one pass, byte-for-byte", async () => {
    const first = await hashObject("hello\n", { cwd: repo.dir, write: true });
    const second = await hashObject("no trailing newline", { cwd: repo.dir, write: true });

    const bodies = await catFileBatch([first, second], { cwd: repo.dir });
    expect(bodies.get(first)).toBe("hello\n");
    expect(bodies.get(second)).toBe("no trailing newline");
  });

  it("keeps multi-byte characters intact (the framing is by BYTES, not characters)", async () => {
    // The exact hazard this parser has to get right: em-dashes and emoji make git's
    // byte-length header disagree with JS string length. This repo's own ledger is full
    // of em-dashes, so a naive parser corrupts every subsequent object in the batch.
    const unicode = "— naïve “quoted” 🎯 —\nsecond line\n";
    const plain = "plain\n";
    const a = await hashObject(unicode, { cwd: repo.dir, write: true });
    const b = await hashObject(plain, { cwd: repo.dir, write: true });

    const bodies = await catFileBatch([a, b], { cwd: repo.dir });
    expect(bodies.get(a)).toBe(unicode);
    // The object AFTER a multi-byte one is where mis-framing shows up first.
    expect(bodies.get(b)).toBe(plain);
  });

  it("reports missing objects as null instead of throwing", async () => {
    const bodies = await catFileBatch(["0".repeat(40)], { cwd: repo.dir });
    expect(bodies.get("0".repeat(40))).toBeNull();
  });

  it("accepts <tree-ish>:<path> revisions and an empty request", async () => {
    const head = await repo.revParse("HEAD");
    const bodies = await catFileBatch([`${head}:a.txt`, `${head}:nope.txt`], { cwd: repo.dir });
    expect(bodies.get(`${head}:a.txt`)).toBe("one\n");
    expect(bodies.get(`${head}:nope.txt`)).toBeNull();
    expect((await catFileBatch([], { cwd: repo.dir })).size).toBe(0);
  });
});

describe("readChangeMapSnapshot answers exactly what findEntryByCommitSha does", () => {
  let repo: FixtureRepo;
  const shas: string[] = [];

  beforeAll(async () => {
    repo = await createFixtureRepo();
    for (let index = 0; index < 5; index += 1) {
      const sha = await repo.commit(`commit ${index}`, {
        files: { [`file${index}.txt`]: `content ${index}\n` },
      });
      shas.push(sha);
      await assignChangeId(sha, { cwd: repo.dir });
    }
    // One commit deliberately left unmapped.
    shas.push(await repo.commit("unmapped", { files: { "x.txt": "x\n" } }));
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("matches the per-commit lookup for every commit, mapped or not", async () => {
    const snapshot = await readChangeMapSnapshot({ cwd: repo.dir });
    for (const sha of shas) {
      const direct = await findEntryByCommitSha(sha, { cwd: repo.dir });
      const fromSnapshot = snapshot.entryForCommit(sha);
      expect(fromSnapshot?.change_id ?? null).toBe(direct?.change_id ?? null);
    }
    expect(snapshot.entries).toHaveLength((await readAllChangeMapEntries({ cwd: repo.dir })).length);
  });

  it("follows folded_into redirects to the surviving change", async () => {
    const snapshot = await readChangeMapSnapshot({ cwd: repo.dir });
    const absorbed = snapshot.entryForCommit(shas[1]!)!;
    const survivor = snapshot.entryForCommit(shas[0]!)!;

    await upsertChangeMapEntries(
      [{ ...absorbed, folded_into: survivor.change_id, updated_at: new Date().toISOString() }],
      { cwd: repo.dir, message: "test: fold" },
    );

    const after = await readChangeMapSnapshot({ cwd: repo.dir });
    const folded = after.entryForCommit(shas[1]!)!;
    expect(folded.folded_into).toBe(survivor.change_id);
    expect(after.surviving(folded).change_id).toBe(survivor.change_id);
  });
});

describe("readLedgerNotesForCommits matches readLedgerNote", () => {
  let repo: FixtureRepo;
  let withNote: string;
  let withoutNote: string;
  let corrupt: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    withNote = await repo.commit("has intent", { files: { "a.ts": "export const a = 1;\n" } });
    const changeId = (await assignChangeId(withNote, { cwd: repo.dir })).changeId;
    await appendLedgerEntry(
      changeId,
      makeLedgerEntry({
        changeId,
        revision: withNote,
        createdAt: "2026-07-20T10:00:00Z",
        summary: "Switch to signed cookies — the em-dash matters here",
        scopePath: "a.ts",
        scopeBlob: FAKE_BLOB,
      }),
      { cwd: repo.dir },
    );
    withoutNote = await repo.commit("no intent", { files: { "b.ts": "export const b = 2;\n" } });
    corrupt = await repo.commit("corrupt note", { files: { "c.ts": "export const c = 3;\n" } });
    await repo.run(["notes", "--ref=git-for-ai/intent", "add", "-m", "not json at all", corrupt]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("returns the same entries the single-commit reader does", async () => {
    const batch = await readLedgerNotesForCommits([withNote, withoutNote, corrupt], {
      cwd: repo.dir,
    });
    const single = await readLedgerNote(withNote, { cwd: repo.dir });

    const batched = batch.get(withNote);
    expect(batched).not.toBeInstanceOf(LedgerNoteFormatError);
    expect((batched as { note: { entries: unknown[] } }).note.entries).toEqual(single!.entries);
  });

  it("omits commits with no note, and reports a malformed note instead of throwing", async () => {
    const batch = await readLedgerNotesForCommits([withNote, withoutNote, corrupt], {
      cwd: repo.dir,
    });
    expect(batch.has(withoutNote)).toBe(false);
    expect(batch.get(corrupt)).toBeInstanceOf(LedgerNoteFormatError);
    // …and the single-commit reader agrees about that note being malformed.
    await expect(readLedgerNote(corrupt, { cwd: repo.dir })).rejects.toBeInstanceOf(
      LedgerNoteFormatError,
    );
  });

  it("is empty for a repo with no notes ref at all", async () => {
    const bare = await createFixtureRepo();
    try {
      const sha = await bare.commit("only commit", { files: { "a.txt": "a\n" } });
      expect((await readLedgerNotesForCommits([sha], { cwd: bare.dir })).size).toBe(0);
    } finally {
      await bare.cleanup();
    }
  });
});

describe("readSessionRecords matches readSessionRecord", () => {
  let repo: FixtureRepo;
  const refs: string[] = [];

  beforeAll(async () => {
    repo = await createFixtureRepo();
    const sha = await repo.commit("seed", { files: { "a.txt": "a\n" } });
    for (const [index, summary] of ["first session", "second session"].entries()) {
      const written = await writeSessionRecord(
        makeSessionRecord({
          sessionId: `session-${index}`,
          capturedAt: "2026-07-20T10:00:00Z",
          sinceSha: sha,
          untilSha: sha,
          summary,
        }),
        { cwd: repo.dir },
      );
      refs.push(written.sessionRef);
    }
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("returns identical records for every ref, in one read", async () => {
    const batch = await readSessionRecords(refs, { cwd: repo.dir });
    for (const ref of refs) {
      expect(batch.get(ref)).toEqual(await readSessionRecord(ref, { cwd: repo.dir }));
    }
  });

  it("silently omits refs that are absent or malformed (callers label them)", async () => {
    const missing = `sha256:${"f".repeat(64)}`;
    const batch = await readSessionRecords([...refs, missing, "not-a-session-ref"], {
      cwd: repo.dir,
    });
    expect(batch.has(missing)).toBe(false);
    expect(batch.has("not-a-session-ref")).toBe(false);
    expect(batch.size).toBe(refs.length);
  });
});

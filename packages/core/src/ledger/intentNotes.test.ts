// Integration tests for ledger note read/write against a REAL temporary git repository
// (createFixtureRepo — never mocked), per CLI_PLAN.md §4's testing strategy and M4's
// definition of done.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ledgerNoteSchema, type LedgerEntry } from "@git-for-ai/schemas";

import { createFixtureRepo, notesAppend, notesShow, type FixtureRepo } from "../git/index.js";
import { resolveEffectiveEntry } from "./effective.js";
import {
  INTENT_NOTES_REF,
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerEntries,
  readLedgerNote,
} from "./intentNotes.js";

const CHANGE_ID = "9f2c1a7b6e4d0f83c5a1b2d3e4f50617";
const OTHER_CHANGE_ID = "7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4";

function makeEntry(revision: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: CHANGE_ID,
    revision,
    created_at: "2026-07-17T09:22:41Z",
    author: {
      type: "agent",
      tool: "claude-code",
      model: "claude-opus-4-8",
      human: "andrewcampkin@gmail.com",
    },
    scope: [
      {
        path: "src/auth/session.ts",
        range: [40, 118],
        blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
      },
    ],
    summary: "Switch session store from in-proc map to signed-cookie tokens.",
    session_ref: null,
    provenance: "agent-captured",
    ...overrides,
  };
}

describe("ledger intent notes (real git fixture)", () => {
  let repo: FixtureRepo;
  let sha: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    sha = await repo.commit("first commit", { files: { "a.txt": "a" } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("appends a first entry, and the on-disk note body is exactly the ledger-note envelope", async () => {
    const entry = makeEntry(sha);

    const written = await appendLedgerEntry(CHANGE_ID, entry, { cwd: repo.dir });
    expect(written.entries).toEqual([entry]);

    // Inspect the raw note via notesShow directly — not through our own read function —
    // to confirm what actually landed on disk (M4 definition of done).
    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    expect(raw).not.toBeNull();

    const parsed: unknown = JSON.parse(raw!);
    // The envelope shape is exact: schema literal + change_id + entries, nothing else.
    expect(Object.keys(parsed as object).sort()).toEqual(["change_id", "entries", "schema"]);
    expect(ledgerNoteSchema.parse(parsed)).toEqual({
      schema: "git-for-ai/ledger-note@1",
      change_id: CHANGE_ID,
      entries: [entry],
    });

    // And the module's own read path agrees.
    expect(await readLedgerEntries(sha, { cwd: repo.dir })).toEqual([entry]);
    expect(await readLedgerNote(sha, { cwd: repo.dir })).toEqual(written);
  });

  it("appends a second entry without touching the first, and the newer one is effective", async () => {
    const first = makeEntry(sha);
    const second = makeEntry(sha, {
      created_at: "2026-07-17T10:00:00Z",
      summary: "Correction: tokens are rotated hourly, not daily.",
    });

    await appendLedgerEntry(CHANGE_ID, first, { cwd: repo.dir });
    await appendLedgerEntry(CHANGE_ID, second, { cwd: repo.dir });

    // Raw on-disk body is still ONE JSON envelope (append into the array, not a second
    // concatenated note paragraph), holding both entries in append order.
    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    const note = ledgerNoteSchema.parse(JSON.parse(raw!));
    expect(note.entries).toHaveLength(2);
    expect(note.entries[0]).toEqual(first); // existing entry never mutated
    expect(note.entries[1]).toEqual(second);

    const entries = await readLedgerEntries(sha, { cwd: repo.dir });
    expect(entries).toEqual([first, second]);
    expect(resolveEffectiveEntry(entries!)).toEqual(second);
  });

  it("returns null (not an empty array) for a commit with no ledger note", async () => {
    expect(await readLedgerEntries(sha, { cwd: repo.dir })).toBeNull();
    expect(await readLedgerNote(sha, { cwd: repo.dir })).toBeNull();
  });

  it("preserves unknown fields written by a newer client across an append round-trip", async () => {
    const withExtras = {
      ...makeEntry(sha),
      future_field: "written by a newer client",
    } as LedgerEntry;

    await appendLedgerEntry(CHANGE_ID, withExtras, { cwd: repo.dir });
    await appendLedgerEntry(
      CHANGE_ID,
      makeEntry(sha, { created_at: "2026-07-17T10:00:00Z" }),
      { cwd: repo.dir },
    );

    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    const parsed = JSON.parse(raw!) as { entries: Record<string, unknown>[] };
    expect(parsed.entries[0]!["future_field"]).toBe("written by a newer client");
  });

  it("throws LedgerNoteFormatError on a pre-existing non-JSON note, leaving it intact", async () => {
    await notesAppend(INTENT_NOTES_REF, sha, "this is not json", { cwd: repo.dir });

    await expect(readLedgerEntries(sha, { cwd: repo.dir })).rejects.toBeInstanceOf(
      LedgerNoteFormatError,
    );
    await expect(
      appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir }),
    ).rejects.toBeInstanceOf(LedgerNoteFormatError);

    // The malformed note was never overwritten or "repaired" — no silent data loss.
    expect(await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir })).toBe("this is not json");
  });

  it("throws LedgerNoteFormatError on valid JSON that is not a ledger-note envelope", async () => {
    await notesAppend(INTENT_NOTES_REF, sha, JSON.stringify({ schema: "something-else@9" }), {
      cwd: repo.dir,
    });

    await expect(readLedgerNote(sha, { cwd: repo.dir })).rejects.toBeInstanceOf(
      LedgerNoteFormatError,
    );
    await expect(
      appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir }),
    ).rejects.toBeInstanceOf(LedgerNoteFormatError);
  });

  it("rejects an entry whose change_id does not match the changeId argument, writing nothing", async () => {
    await expect(
      appendLedgerEntry(OTHER_CHANGE_ID, makeEntry(sha), { cwd: repo.dir }),
    ).rejects.toThrow(/does not match the change-id being written/);

    expect(await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir })).toBeNull();
  });

  it("rejects an entry that fails ledgerEntrySchema validation, writing nothing", async () => {
    const invalid = makeEntry(sha, { created_at: "yesterday" });

    await expect(appendLedgerEntry(CHANGE_ID, invalid, { cwd: repo.dir })).rejects.toThrow(
      /refusing to write invalid ledger entry/,
    );

    expect(await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir })).toBeNull();
  });

  it("refuses to append to a note anchored to a different change-id, leaving it intact", async () => {
    await appendLedgerEntry(CHANGE_ID, makeEntry(sha), { cwd: repo.dir });

    const foreign = makeEntry(sha, { change_id: OTHER_CHANGE_ID });
    await expect(
      appendLedgerEntry(OTHER_CHANGE_ID, foreign, { cwd: repo.dir }),
    ).rejects.toBeInstanceOf(LedgerNoteFormatError);

    const note = await readLedgerNote(sha, { cwd: repo.dir });
    expect(note!.change_id).toBe(CHANGE_ID);
    expect(note!.entries).toHaveLength(1);
  });

  it("supports a non-default notes ref via opts.ref", async () => {
    const altRef = "refs/notes/git-for-ai/intent-test-alt";
    const entry = makeEntry(sha);

    await appendLedgerEntry(CHANGE_ID, entry, { cwd: repo.dir, ref: altRef });

    expect(await readLedgerEntries(sha, { cwd: repo.dir, ref: altRef })).toEqual([entry]);
    // Nothing leaked into the default ref.
    expect(await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir })).toBeNull();
  });
});

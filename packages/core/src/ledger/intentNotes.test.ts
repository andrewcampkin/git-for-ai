// Integration tests for ledger note read/write against a REAL temporary git repository
// (createFixtureRepo — never mocked), per CLI_PLAN.md §4's testing strategy and M4's
// definition of done, updated for the PLAN_2026-07-18.md W3 JSONL reformat: writers emit
// only JSONL (one canonical-JSON ledger-note line per entry), readers accept BOTH the
// JSONL format and the legacy single-envelope format, and a legacy note is migrated
// opportunistically on its next append.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ledgerNoteLineSchema,
  LEDGER_NOTE_JSONL_SCHEMA,
  type LedgerEntry,
} from "@git-for-ai/schemas";

import { createFixtureRepo, notesAppend, notesShow, notesMerge, type FixtureRepo } from "../git/index.js";
import { resolveEffectiveEntry, canonicalJsonStringify } from "./effective.js";
import {
  INTENT_NOTES_REF,
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerEntries,
  readLedgerNote,
  readLedgerNoteWithFormat,
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

/** The legacy (@1) single-envelope body, pretty-printed exactly as the old writer did. */
function legacyEnvelopeBody(entries: LedgerEntry[], changeId = CHANGE_ID): string {
  return JSON.stringify(
    { schema: "git-for-ai/ledger-note@1", change_id: changeId, entries },
    null,
    2,
  );
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

  it("appends a first entry, and the on-disk note body is exactly one canonical JSONL line", async () => {
    const entry = makeEntry(sha);

    const written = await appendLedgerEntry(CHANGE_ID, entry, { cwd: repo.dir });
    expect(written.schema).toBe(LEDGER_NOTE_JSONL_SCHEMA);
    expect(written.entries).toEqual([entry]);

    // Inspect the raw note via notesShow directly — not through our own read function —
    // to confirm what actually landed on disk (M4 definition of done, W3 format).
    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    expect(raw).not.toBeNull();

    const lines = raw!.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    // Each line is the canonical serialization of a self-describing note line.
    expect(lines[0]).toBe(
      canonicalJsonStringify({ schema: LEDGER_NOTE_JSONL_SCHEMA, change_id: CHANGE_ID, entry }),
    );
    expect(ledgerNoteLineSchema.parse(JSON.parse(lines[0]!))).toEqual({
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: CHANGE_ID,
      entry,
    });

    // And the module's own read path agrees.
    expect(await readLedgerEntries(sha, { cwd: repo.dir })).toEqual([entry]);
    expect(await readLedgerNote(sha, { cwd: repo.dir })).toEqual(written);
    expect((await readLedgerNoteWithFormat(sha, { cwd: repo.dir }))!.format).toBe("jsonl");
  });

  it("appends a second entry without touching the first, and the newer one is effective", async () => {
    const first = makeEntry(sha);
    const second = makeEntry(sha, {
      created_at: "2026-07-17T10:00:00Z",
      summary: "Correction: tokens are rotated hourly, not daily.",
    });

    await appendLedgerEntry(CHANGE_ID, first, { cwd: repo.dir });
    await appendLedgerEntry(CHANGE_ID, second, { cwd: repo.dir });

    // Raw on-disk body is two JSONL lines — one per entry, each independently valid.
    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    const lines = raw!.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    const parsedLines = lines.map((line) => ledgerNoteLineSchema.parse(JSON.parse(line)));
    expect(parsedLines.map((line) => line.entry)).toEqual([first, second]);

    const entries = await readLedgerEntries(sha, { cwd: repo.dir });
    expect(entries).toEqual([first, second]);
    expect(resolveEffectiveEntry(entries!)).toEqual(second);
  });

  it("returns null (not an empty array) for a commit with no ledger note", async () => {
    expect(await readLedgerEntries(sha, { cwd: repo.dir })).toBeNull();
    expect(await readLedgerNote(sha, { cwd: repo.dir })).toBeNull();
    expect(await readLedgerNoteWithFormat(sha, { cwd: repo.dir })).toBeNull();
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
    const lines = raw!.split("\n").filter((line) => line.trim() !== "");
    const entries = lines.map((line) => (JSON.parse(line) as { entry: Record<string, unknown> }).entry);
    expect(entries.some((entry) => entry["future_field"] === "written by a newer client")).toBe(true);

    const read = await readLedgerEntries(sha, { cwd: repo.dir });
    expect((read![0] as Record<string, unknown>)["future_field"]).toBe("written by a newer client");
  });

  // ── Legacy (@1 envelope) compatibility ────────────────────────────────────────────

  it("reads a legacy single-envelope note (readers accept both formats)", async () => {
    const first = makeEntry(sha);
    const second = makeEntry(sha, { created_at: "2026-07-17T10:00:00Z", summary: "Corrected." });
    await notesAppend(INTENT_NOTES_REF, sha, legacyEnvelopeBody([first, second]), {
      cwd: repo.dir,
    });

    const read = await readLedgerNoteWithFormat(sha, { cwd: repo.dir });
    expect(read!.format).toBe("legacy-envelope");
    expect(read!.note.schema).toBe("git-for-ai/ledger-note@1");
    expect(read!.note.entries).toEqual([first, second]);
    expect(await readLedgerEntries(sha, { cwd: repo.dir })).toEqual([first, second]);
  });

  it("migrates a legacy note to JSONL opportunistically on the next append, losing nothing", async () => {
    const legacyEntry = makeEntry(sha);
    await notesAppend(INTENT_NOTES_REF, sha, legacyEnvelopeBody([legacyEntry]), {
      cwd: repo.dir,
    });

    const appended = makeEntry(sha, {
      created_at: "2026-07-17T11:00:00Z",
      summary: "Second thoughts, recorded.",
    });
    await appendLedgerEntry(CHANGE_ID, appended, { cwd: repo.dir });

    // On disk: now pure JSONL, one line per entry — the legacy entry survived intact.
    const raw = await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir });
    const lines = raw!.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(ledgerNoteLineSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }

    const read = await readLedgerNoteWithFormat(sha, { cwd: repo.dir });
    expect(read!.format).toBe("jsonl");
    expect(read!.note.entries).toEqual([legacyEntry, appended]);
  });

  it("reading a legacy note never rewrites it (migration only happens on write)", async () => {
    const body = legacyEnvelopeBody([makeEntry(sha)]);
    await notesAppend(INTENT_NOTES_REF, sha, body, { cwd: repo.dir });

    await readLedgerNote(sha, { cwd: repo.dir });
    await readLedgerEntries(sha, { cwd: repo.dir });

    expect(await notesShow(INTENT_NOTES_REF, sha, { cwd: repo.dir })).toBe(body);
  });

  // ── Merge shape: the reason the format exists ────────────────────────────────────

  it("cat_sort_uniq union-merges divergently-appended JSONL notes into the entry union", async () => {
    // Two "clones" diverge: each appends a different entry for the same commit. Model
    // the divergence as two notes refs and drive git's REAL cat_sort_uniq merge.
    const refA = "refs/notes/git-for-ai/intent-merge-a";
    const refB = "refs/notes/git-for-ai/intent-merge-b";
    const shared = makeEntry(sha);
    const fromA = makeEntry(sha, { created_at: "2026-07-17T10:00:00Z", summary: "A's correction." });
    const fromB = makeEntry(sha, { created_at: "2026-07-17T10:30:00Z", summary: "B's correction." });

    // Both sides start from the same shared entry, then diverge.
    await appendLedgerEntry(CHANGE_ID, shared, { cwd: repo.dir, ref: refA });
    await appendLedgerEntry(CHANGE_ID, fromA, { cwd: repo.dir, ref: refA });
    await appendLedgerEntry(CHANGE_ID, shared, { cwd: repo.dir, ref: refB });
    await appendLedgerEntry(CHANGE_ID, fromB, { cwd: repo.dir, ref: refB });

    await notesMerge(refA, refB, { cwd: repo.dir, strategy: "cat_sort_uniq" });

    // The merged note parses cleanly and contains the UNION: the shared entry once
    // (byte-identical lines dedupe via uniq), plus both sides' divergent entries.
    const merged = await readLedgerEntries(sha, { cwd: repo.dir, ref: refA });
    expect(merged).toHaveLength(3);
    expect(merged).toEqual([shared, fromA, fromB]); // oldest-first by created_at
    expect(resolveEffectiveEntry(merged!)).toEqual(fromB);
  });

  it("parses a JSONL body with blank lines and duplicate lines (sort/uniq tolerance)", async () => {
    const entry = makeEntry(sha);
    const line = canonicalJsonStringify({
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: CHANGE_ID,
      entry,
    });
    // Simulate what `git notes append` paragraph-joins or a hand merge could produce.
    await notesAppend(INTENT_NOTES_REF, sha, `${line}\n\n${line}`, { cwd: repo.dir });

    const read = await readLedgerEntries(sha, { cwd: repo.dir });
    expect(read).toEqual([entry]); // deduped, blank line ignored
  });

  // ── Failure modes ─────────────────────────────────────────────────────────────────

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

  it("throws LedgerNoteFormatError on valid JSON that is neither format", async () => {
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

  it("throws LedgerNoteFormatError on a JSONL body mixing change-ids", async () => {
    const lineA = canonicalJsonStringify({
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: CHANGE_ID,
      entry: makeEntry(sha),
    });
    const lineB = canonicalJsonStringify({
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: OTHER_CHANGE_ID,
      entry: makeEntry(sha, { change_id: OTHER_CHANGE_ID }),
    });
    await notesAppend(INTENT_NOTES_REF, sha, `${lineA}\n${lineB}`, { cwd: repo.dir });

    await expect(readLedgerNote(sha, { cwd: repo.dir })).rejects.toThrow(
      /mixes entries for multiple change-ids/,
    );
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

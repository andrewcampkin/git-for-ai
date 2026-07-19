// Ledger intent read/write over git notes — architecture/ARCHITECTURE.md §6.1 and §12.2;
// exact field shapes in architecture/DATA_MODEL.md §2.
//
// The note attached to a commit under `refs/notes/git-for-ai/intent` is an APPEND-ONLY
// entry log: a correction is a new entry with a later `created_at`, never an in-place
// edit of an existing entry (DATA_MODEL.md §2.4). This module enforces that invariant —
// every write copies the existing entries untouched and adds exactly one new entry.
//
// ── On-disk format (the PLAN_2026-07-18.md W3 decision, owner-approved) ──
//
// Two encodings exist; readers accept BOTH, writers emit ONLY the second:
//
//   @1 (legacy)   The whole note body is one pretty-printed `ledgerNoteSchema` JSON
//                 envelope. Line-oriented `cat_sort_uniq` notes-merge would interleave
//                 two divergently-appended envelopes into invalid JSON — the exact
//                 problem CLI_PLAN.md M13's writeup identified.
//
//   @2 (current)  JSONL: one `ledgerNoteLineSchema` object per line, each serialized
//                 CANONICALLY (keys sorted, no insignificant whitespace) and carrying
//                 the schema tag + change-id + exactly one entry. This makes
//                 `cat_sort_uniq` union-merge conflict-free BY CONSTRUCTION:
//                   - every line is an independently-valid record, so cat/sort/uniq of
//                     two divergent notes yields the union of their entry lines;
//                   - canonical serialization makes identical entries byte-identical,
//                     so `uniq` dedupes them instead of double-counting;
//                   - line order carries no meaning — entries are ordered by
//                     `created_at` on read, and the effective entry (./effective.ts)
//                     is order-independent anyway.
//
// Migration is OPPORTUNISTIC, never a mass rewrite: a legacy note is converted to JSONL
// the next time an entry is appended to it (the whole updated log is rewritten in one
// atomic `git notes add -f`, which any append already required — see below). Reads
// never write.
//
// Write mechanics (a deliberate judgment call, documented here): `git notes append` on a
// commit that already has a note concatenates the new text as a separate paragraph
// (`old\n\nnew`) — the blank separator line is harmless to a JSONL reader but the
// append path cannot migrate a legacy note, so:
//   - first entry (no note yet): written via notesAppend, which creates the note;
//   - subsequent entries: the whole updated entry log is rewritten as JSONL in one
//     atomic `git notes add -f` — the note blob changes (as any append implies), but no
//     existing entry inside it is ever mutated or dropped.

import {
  ledgerEntrySchema,
  ledgerNoteSchema,
  ledgerNoteLineSchema,
  LEDGER_NOTE_JSONL_SCHEMA,
  type LedgerEntry,
  type LedgerNote,
} from "@git-for-ai/schemas";

import { notesAppend, notesShow, runGit, type RunGitOptions } from "../git/index.js";
import { canonicalJsonStringify } from "./effective.js";

/** The notes ref the semantic commit ledger lives under (ARCHITECTURE.md §8.1). */
export const INTENT_NOTES_REF = "refs/notes/git-for-ai/intent";

/** Options accepted by the ledger note read/write functions. */
export interface LedgerNoteOptions extends Pick<RunGitOptions, "cwd" | "env"> {
  /** Notes ref to read/write. Defaults to {@link INTENT_NOTES_REF}. */
  ref?: string;
}

/** How a note was encoded on disk when read (see the module header). */
export type LedgerNoteStoredFormat = "jsonl" | "legacy-envelope";

/** A parsed note plus the on-disk encoding it was read from (doctor audits the latter). */
export interface LedgerNoteReadResult {
  note: LedgerNote;
  format: LedgerNoteStoredFormat;
}

/**
 * Thrown when a note that exists on disk under the intent ref cannot be used: its body is
 * neither a legacy envelope nor valid JSONL lines, or it is anchored to a different
 * change-id than the caller expected. This is deliberately an error rather than
 * "treat as absent": treating an unparseable note as absent would let the next write
 * silently overwrite (and so destroy) whatever data is actually in it.
 */
export class LedgerNoteFormatError extends Error {
  readonly ref: string;
  readonly sha: string;

  constructor(params: { ref: string; sha: string; reason: string; cause?: unknown }) {
    super(
      `ledger note for commit ${params.sha} under ${params.ref} is unusable: ${params.reason}`,
      params.cause === undefined ? undefined : { cause: params.cause },
    );
    this.name = "LedgerNoteFormatError";
    this.ref = params.ref;
    this.sha = params.sha;
  }
}

/** Serialize one JSONL line: canonical JSON so identical entries are byte-identical. */
function serializeLedgerNoteLine(changeId: string, entry: LedgerEntry): string {
  return canonicalJsonStringify({
    schema: LEDGER_NOTE_JSONL_SCHEMA,
    change_id: changeId,
    entry,
  });
}

/**
 * Serialize a full note as JSONL — the ONLY format git-for-ai ever writes. Exported for
 * the rare non-append writer (relink's change-id rewrite), which must emit the same wire
 * format as every other write path.
 */
export function serializeLedgerNote(note: LedgerNote): string {
  return note.entries
    .map((entry) => serializeLedgerNoteLine(note.change_id, entry))
    .join("\n");
}

/** Zod issues → one readable reason string. */
function issueSummary(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Epoch ms for ordering entries oldest-first on read; unparseable sorts first. */
function createdAtMs(entry: LedgerEntry): number {
  const ms = Date.parse(entry.created_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Decode a raw note body into the in-memory envelope, accepting both encodings.
 *
 * Detection: the whole body is tried as a single JSON document first — that matches the
 * legacy pretty-printed envelope AND a one-line JSONL note (a complete JSON document
 * itself, disambiguated by which schema it validates against). Anything else is decoded
 * line-by-line as JSONL. Failures throw {@link LedgerNoteFormatError}.
 *
 * JSONL decode semantics (all deliberate, matching `cat_sort_uniq`'s cat/sort/uniq):
 *   - blank lines are ignored (git normalizes trailing newlines; `notes append`
 *     separates paragraphs with a blank line);
 *   - byte-identical duplicate lines are deduped, as `uniq` would;
 *   - every line must carry the SAME change-id (one note anchors one change);
 *   - entries are returned oldest-first by `created_at` (line order is meaningless
 *     after a sort-based merge), with the lexicographic line order as a deterministic
 *     tiebreak for equal timestamps.
 */
export function parseLedgerNoteBody(
  raw: string,
  context: { ref: string; sha: string },
): LedgerNoteReadResult {
  const { ref, sha } = context;

  // 1. Whole-body JSON document? (legacy envelope, or a single-line JSONL note)
  let whole: unknown;
  let wholeParsed = false;
  try {
    whole = JSON.parse(raw);
    wholeParsed = true;
  } catch {
    wholeParsed = false;
  }
  if (wholeParsed) {
    const line = ledgerNoteLineSchema.safeParse(whole);
    if (line.success) {
      return {
        note: {
          schema: LEDGER_NOTE_JSONL_SCHEMA,
          change_id: line.data.change_id,
          entries: [line.data.entry],
        },
        format: "jsonl",
      };
    }
    const envelope = ledgerNoteSchema.safeParse(whole);
    if (envelope.success) {
      return { note: envelope.data, format: "legacy-envelope" };
    }
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason:
        `note body is a JSON document but matches neither the JSONL line shape nor the ` +
        `legacy ledger-note envelope (${issueSummary(envelope.error)})`,
      cause: envelope.error,
    });
  }

  // 2. JSONL: parse each non-blank line independently.
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new LedgerNoteFormatError({ ref, sha, reason: "note body is empty" });
  }
  // Dedupe byte-identical lines (uniq semantics), then sort lexicographically so the
  // result is deterministic regardless of on-disk line order.
  const uniqueLines = [...new Set(lines)].sort();

  const parsed: Array<{ changeId: string; entry: LedgerEntry }> = [];
  for (const [index, line] of uniqueLines.entries()) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (cause) {
      throw new LedgerNoteFormatError({
        ref,
        sha,
        reason: `note body is not valid JSON (JSONL line ${index + 1} failed to parse)`,
        cause,
      });
    }
    const result = ledgerNoteLineSchema.safeParse(json);
    if (!result.success) {
      throw new LedgerNoteFormatError({
        ref,
        sha,
        reason: `JSONL line ${index + 1} does not match the ledger-note line shape (${issueSummary(result.error)})`,
        cause: result.error,
      });
    }
    parsed.push({ changeId: result.data.change_id, entry: result.data.entry });
  }

  const changeIds = new Set(parsed.map((item) => item.changeId));
  if (changeIds.size > 1) {
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason: `note mixes entries for multiple change-ids (${[...changeIds].join(", ")})`,
    });
  }

  // Oldest first; stable sort keeps the lexicographic line order for equal timestamps.
  const entries = parsed
    .map((item) => item.entry)
    .sort((a, b) => createdAtMs(a) - createdAtMs(b));

  return {
    note: {
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: [...changeIds][0]!,
      entries,
    },
    format: "jsonl",
  };
}

/** Extract the RunGitOptions subset without materializing `undefined` keys (exactOptionalPropertyTypes). */
function toRunGitOptions(opts: LedgerNoteOptions): RunGitOptions {
  return {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
}

/**
 * Read and parse the ledger note for a commit, also reporting which on-disk encoding it
 * was stored in — `doctor` audits `legacy-envelope` notes because they cannot survive a
 * divergent `cat_sort_uniq` merge until their next (migrating) append.
 *
 * Returns `null` when the commit has no note under the intent ref. A note that exists
 * but is malformed throws {@link LedgerNoteFormatError} instead of being treated as
 * absent.
 */
export async function readLedgerNoteWithFormat(
  sha: string,
  opts: LedgerNoteOptions = {},
): Promise<LedgerNoteReadResult | null> {
  const { ref = INTENT_NOTES_REF } = opts;
  const raw = await notesShow(ref, sha, toRunGitOptions(opts));
  if (raw === null) {
    return null;
  }
  return parseLedgerNoteBody(raw, { ref, sha });
}

/**
 * Read and parse the full ledger note envelope for a commit.
 *
 * Returns `null` when the commit has no note under the intent ref — the unambiguous
 * "no captured intent for this commit" signal that `log --intent` (M6) and `show` (M8)
 * render their degraded case from. A note that exists but is malformed throws
 * {@link LedgerNoteFormatError} instead of being treated as absent.
 */
export async function readLedgerNote(sha: string, opts: LedgerNoteOptions = {}): Promise<LedgerNote | null> {
  const result = await readLedgerNoteWithFormat(sha, opts);
  return result === null ? null : result.note;
}

/**
 * Read the ledger entries recorded for a commit, oldest first.
 *
 * Returns `null` when no ledger note exists for the commit at all — callers must treat
 * that as "no captured intent", distinct from any array value. (An empty array can never
 * occur: both note encodings require at least one entry.)
 */
export async function readLedgerEntries(
  sha: string,
  opts: LedgerNoteOptions = {},
): Promise<LedgerEntry[] | null> {
  const note = await readLedgerNote(sha, opts);
  return note === null ? null : note.entries;
}

/**
 * Append one ledger entry to the note for the commit the entry was authored against
 * (`entry.revision`), creating the note if this is the commit's first entry.
 *
 * Guarantees:
 * - the entry is validated against `ledgerEntrySchema` before anything is written;
 * - `entry.change_id` must equal `changeId`, and must match the existing note's
 *   `change_id` when a note already exists;
 * - existing entries are never mutated or dropped — the new entry joins the log
 *   (append-only, ARCHITECTURE.md §12.2);
 * - the write is always emitted in the current JSONL format; appending to a
 *   legacy-envelope note migrates it opportunistically (module header);
 * - unknown fields written by newer clients survive the round-trip (the schemas are
 *   passthrough, per DATA_MODEL.md §6);
 * - a malformed pre-existing note throws {@link LedgerNoteFormatError} and is left
 *   byte-for-byte intact — this function never overwrites data it could not parse.
 *
 * Returns the updated note envelope as written.
 */
export async function appendLedgerEntry(
  changeId: string,
  entry: LedgerEntry,
  opts: LedgerNoteOptions = {},
): Promise<LedgerNote> {
  const { ref = INTENT_NOTES_REF } = opts;
  const runGitOptions = toRunGitOptions(opts);

  const entryResult = ledgerEntrySchema.safeParse(entry);
  if (!entryResult.success) {
    throw new Error(
      `refusing to write invalid ledger entry: ${issueSummary(entryResult.error)}`,
    );
  }
  const validEntry = entryResult.data;

  if (validEntry.change_id !== changeId) {
    throw new Error(
      `entry.change_id (${validEntry.change_id}) does not match the change-id being written (${changeId})`,
    );
  }

  const sha = validEntry.revision;
  const existing = await readLedgerNoteWithFormat(sha, { ...runGitOptions, ref });

  if (existing === null) {
    const note: LedgerNote = {
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: changeId,
      entries: [validEntry],
    };
    // No note yet: notesAppend creates it, and the body is one JSONL line.
    await notesAppend(ref, sha, serializeLedgerNote(note), runGitOptions);
    return note;
  }

  if (existing.note.change_id !== changeId) {
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason:
        `note is anchored to change-id ${existing.note.change_id}, ` +
        `refusing to append an entry for change-id ${changeId}`,
    });
  }

  // Append-only: copy the existing entries untouched and add the new one. The rewrite is
  // always emitted as JSONL — which is also the opportunistic legacy→JSONL migration
  // path (never a mass rewrite; reads never write).
  const updated: LedgerNote = {
    schema: LEDGER_NOTE_JSONL_SCHEMA,
    change_id: changeId,
    entries: [...existing.note.entries, validEntry],
  };

  // `git notes append` would concatenate a second paragraph and could not migrate a
  // legacy envelope, so a note that already exists is rewritten whole (one atomic
  // `notes add -f`) with the new entry included. See module header.
  await runGit(["notes", `--ref=${ref}`, "add", "-f", "-F", "-", sha], {
    ...runGitOptions,
    input: serializeLedgerNote(updated),
  });

  return updated;
}

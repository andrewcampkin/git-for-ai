// Ledger intent read/write over git notes — architecture/ARCHITECTURE.md §6.1 and §12.2;
// exact field shapes in architecture/DATA_MODEL.md §2.
//
// The note attached to a commit under `refs/notes/git-for-ai/intent` is a single JSON
// envelope (ledgerNoteSchema) whose `entries` array is APPEND-ONLY: a correction is a new
// entry appended with a later `created_at`, never an in-place edit of an existing entry
// (DATA_MODEL.md §2.4). This module enforces that invariant — every write copies the
// existing entries untouched and adds exactly one new entry at the end.
//
// Write mechanics (a deliberate judgment call, documented here): `git notes append` on a
// commit that already has a note concatenates the new text as a separate paragraph
// (`old\n\nnew`), which would corrupt a note whose body must remain ONE valid JSON
// document. So:
//   - first entry (no note yet): written via notesAppend, which creates the note;
//   - subsequent entries: the whole updated envelope is rewritten in one atomic
//     `git notes add -f` — the note blob changes (as any array append implies), but no
//     existing entry inside it is ever mutated or dropped.

import {
  ledgerEntrySchema,
  ledgerNoteSchema,
  type LedgerEntry,
  type LedgerNote,
} from "@git-for-ai/schemas";

import { notesAppend, notesShow, runGit, type RunGitOptions } from "../git/index.js";

/** The notes ref the semantic commit ledger lives under (ARCHITECTURE.md §8.1). */
export const INTENT_NOTES_REF = "refs/notes/git-for-ai/intent";

/** Options accepted by the ledger note read/write functions. */
export interface LedgerNoteOptions extends Pick<RunGitOptions, "cwd" | "env"> {
  /** Notes ref to read/write. Defaults to {@link INTENT_NOTES_REF}. */
  ref?: string;
}

/**
 * Thrown when a note that exists on disk under the intent ref cannot be used: its body is
 * not valid JSON, does not match the `ledgerNoteSchema` envelope, or is anchored to a
 * different change-id than the caller expected. This is deliberately an error rather than
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

/** Serialize a ledger note envelope for storage: pretty-printed so `git notes show` is human-readable (CLI_PLAN.md M4 definition of done). */
function serializeLedgerNote(note: LedgerNote): string {
  return JSON.stringify(note, null, 2);
}

/** Extract the RunGitOptions subset without materializing `undefined` keys (exactOptionalPropertyTypes). */
function toRunGitOptions(opts: LedgerNoteOptions): RunGitOptions {
  return {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
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
  const { ref = INTENT_NOTES_REF } = opts;

  const raw = await notesShow(ref, sha, toRunGitOptions(opts));
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason: "note body is not valid JSON",
      cause,
    });
  }

  const result = ledgerNoteSchema.safeParse(parsed);
  if (!result.success) {
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason: `note body does not match the ledger-note envelope (${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
      cause: result.error,
    });
  }

  return result.data;
}

/**
 * Read the ledger entries recorded for a commit, in append (oldest-first) order.
 *
 * Returns `null` when no ledger note exists for the commit at all — callers must treat
 * that as "no captured intent", distinct from any array value. (An empty array can never
 * occur: the envelope schema requires at least one entry.)
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
 * (`entry.revision`), creating the note envelope if this is the commit's first entry.
 *
 * Guarantees:
 * - the entry is validated against `ledgerEntrySchema` before anything is written;
 * - `entry.change_id` must equal `changeId`, and must match the existing envelope's
 *   `change_id` when a note already exists;
 * - existing entries are never mutated, reordered, or dropped — the new entry is appended
 *   at the end (append-only array, ARCHITECTURE.md §12.2);
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
      `refusing to write invalid ledger entry: ${entryResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const validEntry = entryResult.data;

  if (validEntry.change_id !== changeId) {
    throw new Error(
      `entry.change_id (${validEntry.change_id}) does not match the change-id being written (${changeId})`,
    );
  }

  const sha = validEntry.revision;
  const existing = await readLedgerNote(sha, { ...runGitOptions, ref });

  if (existing === null) {
    const note: LedgerNote = {
      schema: "git-for-ai/ledger-note@1",
      change_id: changeId,
      entries: [validEntry],
    };
    // No note yet: notesAppend creates it, and the body is the fresh envelope.
    await notesAppend(ref, sha, serializeLedgerNote(note), runGitOptions);
    return note;
  }

  if (existing.change_id !== changeId) {
    throw new LedgerNoteFormatError({
      ref,
      sha,
      reason:
        `note is anchored to change-id ${existing.change_id}, ` +
        `refusing to append an entry for change-id ${changeId}`,
    });
  }

  // Append-only: copy the existing entries untouched and add the new one at the end.
  const updated: LedgerNote = { ...existing, entries: [...existing.entries, validEntry] };

  // `git notes append` would concatenate a second paragraph and break the single-JSON-
  // envelope invariant, so a note that already exists is rewritten whole (one atomic
  // `notes add -f`) with the new entry appended inside the array. See module header.
  await runGit(["notes", `--ref=${ref}`, "add", "-f", "-F", "-", sha], {
    ...runGitOptions,
    input: serializeLedgerNote(updated),
  });

  return updated;
}

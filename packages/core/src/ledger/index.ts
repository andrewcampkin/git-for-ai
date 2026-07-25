// Ledger entry read/write — architecture/ARCHITECTURE.md §6.1, §12.2; schemas in
// architecture/DATA_MODEL.md §2. Notes are an append-only entry log; writes always
// append, never mutate in place, and always emit the JSONL wire format (one canonical
// JSON entry per line — see intentNotes.ts) so `cat_sort_uniq` union merge is
// conflict-free by construction. Effective-entry resolution is newest `created_at` with
// the deterministic tiebreak documented in ./effective.ts.

export {
  INTENT_NOTES_REF,
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerNote,
  readLedgerNoteWithFormat,
  readLedgerEntries,
  readLedgerNotesForCommits,
  parseLedgerNoteBody,
  serializeLedgerNote,
} from "./intentNotes.js";
export type {
  LedgerNoteOptions,
  LedgerNoteStoredFormat,
  LedgerNoteReadResult,
} from "./intentNotes.js";

export { resolveEffectiveEntry, canonicalJsonStringify } from "./effective.js";

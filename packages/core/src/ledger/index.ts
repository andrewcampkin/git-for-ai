// Ledger entry read/write — architecture/ARCHITECTURE.md §6.1, §12.2; schemas in
// architecture/DATA_MODEL.md §2. Notes are an append-only JSON array; writes always
// append, never mutate in place. Effective-entry resolution is newest `created_at` with
// the deterministic tiebreak documented in ./effective.ts.

export {
  INTENT_NOTES_REF,
  LedgerNoteFormatError,
  appendLedgerEntry,
  readLedgerNote,
  readLedgerEntries,
} from "./intentNotes.js";
export type { LedgerNoteOptions } from "./intentNotes.js";

export { resolveEffectiveEntry, canonicalJsonStringify } from "./effective.js";

// Placeholder. Ledger entry read/write — architecture/ARCHITECTURE.md §6.1, §12.2; schemas in
// architecture/DATA_MODEL.md §2. Notes are an append-only JSON array; writes always append,
// never mutate in place. Planned exports: appendLedgerEntry(changeId, entry), readLedgerEntries
// (changeId), resolveEffectiveEntry(entries).
export {};

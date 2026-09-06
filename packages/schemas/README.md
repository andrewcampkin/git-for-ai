# @git-for-ai/schemas

Zod schemas and inferred TypeScript types for every git-for-ai record shape: `LedgerEntry`,
`SessionRecord`, `ChangeMapEntry`, `RepoConfig`, and the JSONL ledger-note line. This
package is the code form of [`architecture/DATA_MODEL.md`](../../architecture/DATA_MODEL.md).

Every schema pins its major version as a literal (an unknown version is rejected by
construction) and uses `.passthrough()` so unknown fields survive a round trip.

No internal dependencies. `core`, `cli` and `desktop` depend on it.

```sh
pnpm vitest run
```

# @git-for-ai/schemas

Zod schemas and inferred TypeScript types for every git-for-ai record shape: `LedgerEntry`,
`SessionRecord`, `ChangeMapEntry`, `RepoConfig`. This package is the code form of
[`architecture/DATA_MODEL.md`](../../architecture/DATA_MODEL.md) — that document is the spec,
this package implements it.

No other internal dependencies. `core`, `cli`, `server`, and `desktop` all depend on this.

Status: scaffolded, not yet implemented. See
[`architecture/CLI_PLAN.md`](../../architecture/CLI_PLAN.md), Milestone 1.

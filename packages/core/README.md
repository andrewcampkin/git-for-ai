# @git-for-ai/core

The engine. Everything in [`architecture/ARCHITECTURE.md`](../../architecture/ARCHITECTURE.md)
that isn't CLI parsing, a UI, or an HTTP layer lives here: git access, the identity resolver,
ledger and session read/write, redaction, the embedding pipeline, and the vector store.

```
src/
├── git/          git access layer — always shells out to the real `git` (§4.1)
├── identity/     change-id assignment + resolution algorithm (§7) — the hardest part
├── ledger/       ledger entry read/write, git-notes-backed (§6.1, §12.2)
├── sessions/     agent session capture + redaction (§10, §13)
└── embeddings/   embedding pipeline + VectorStore (§11)
```

Depends on `@git-for-ai/schemas`. Depended on by `cli`, and later `server`/`desktop`.

Status: scaffolded, not yet implemented. See
[`architecture/CLI_PLAN.md`](../../architecture/CLI_PLAN.md), Milestones 2–4 and 7–9.

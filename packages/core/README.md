# @git-for-ai/core

The engine. Everything in [`architecture/ARCHITECTURE.md`](../../architecture/ARCHITECTURE.md)
that is not CLI parsing, a UI, or an HTTP layer lives here.

```
src/
├── git/          git access layer — always shells out to the real `git` (§4.1),
│                 including the batched readers whole-history commands use
├── identity/     change-id assignment and the R1–R5 resolution algorithm (§7)
├── ledger/       ledger entry read/write over git notes, effective-entry resolution (§6.1, §12.2)
├── sessions/     session capture, redaction, content-addressed session store (§10, §13)
├── embeddings/   tree-sitter chunking, embedder providers, blob-hash cache, sqlite-vec store (§11)
├── query/        hybrid retrieval, enrichment, blame, synthesis with the tool loop (§9.1, §11.5)
└── testing.ts    test-only exports: real-git fixture repos and deterministic embedders
```

Depends only on `@git-for-ai/schemas`. It never imports the CLI or any UI framework.

Tests use real temporary git repositories and never load the real embedding model
(`BagOfWordsEmbedder` and synthetic vectors stand in). The one real-model test is gated
behind `GIT_FOR_AI_REAL_EMBEDDER=1`.

```sh
pnpm vitest run
```

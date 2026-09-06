# Developing git-for-ai

This guide is for a developer working on git-for-ai itself, in their own fork; the intended
way to change it is to fork it and point your own AI agent at the fork. Everything an agent
needs to know to work here safely is in [`../CLAUDE.md`](../CLAUDE.md), and this file covers
the human side: layout, build, test, and how the repo uses itself.

## Prerequisites

- git.
- Node.js 22.5 or later (`.nvmrc` pins a major). `node:sqlite` is the SQLite driver; nothing
  native is compiled.
- pnpm 9 through corepack: `corepack enable` (once per Node version).
- Windows is the primary development platform. Everything runs on macOS and Linux with the
  CPU embedder; the DirectML GPU path is Windows-only.

## Layout

```
packages/
├── schemas/     Zod schemas + types for every record shape (DATA_MODEL.md in code); no deps
├── core/        the engine: git access, identity, ledger, sessions, embeddings, query
├── cli/         Commander wrapper, one file per command; also the review server and MCP server
├── review-ui/   Vite + React SPA served by `git for-ai review` and the desktop app
└── desktop/     Electron shell around the same server + SPA
architecture/    design documents: ARCHITECTURE, DATA_MODEL, CLI_REFERENCE, REVIEW_UI, DESKTOP,
                 ASK_TOOLS, ROADMAP
docs/            user and team guides
config/          shared tsconfig / eslint / prettier config
```

Dependency direction: `schemas` ← `core` ← `cli` ← `desktop`; `review-ui` imports only
type declarations from `cli` and never imports `core`. `core` never imports a CLI or UI
framework.

## Build and test

```sh
pnpm install
pnpm build            # turbo: tsc -b per package, vite build for review-ui, asset copy for desktop
pnpm test             # turbo: vitest in every package (~700 tests)
pnpm typecheck
```

Per package: `pnpm vitest run [path]` inside `packages/<name>`. `pnpm lint` does not run
(no ESLint dependency is wired up); `tsc -b` through build and typecheck is the gate.

Run the gating command unpiped. A pipe such as `pnpm build | tail` hides the build's exit
code.

### Testing rules

- Tests drive a real git through `createFixtureRepo()` from `@git-for-ai/core/testing`.
  Git is never mocked. The one mocked seam is external HTTP (Anthropic, Voyage) through an
  injectable `fetchImpl`.
- The real embedding model is never loaded in tests. `BagOfWordsEmbedder` and synthetic
  vectors stand in; the single real-model test is gated behind `GIT_FOR_AI_REAL_EMBEDDER=1`.
- Tests pin `GIT_FOR_AI_ANTHROPIC_KEY` and `ANTHROPIC_API_KEY` to empty or explicit values
  so a real key is never spent.
- Server and UI tests assert that reads leave every ref byte-identical
  (`git for-each-ref` before and after).

## Running the app

```sh
git for-ai review                            # browser: read-only page on 127.0.0.1
pnpm --filter @git-for-ai/desktop start      # desktop shell from source
pnpm --filter @git-for-ai/desktop smoke      # launch, hit /api/meta, quit
```

To run the freshly built CLI without linking it globally: `node packages/cli/dist/bin.js`.

## The repository uses itself

This repository has `git for-ai init` applied. With `git-for-ai` on `PATH`, every commit
gets a `Change-Id` trailer and a change-map row, and Claude Code sessions are captured into
`refs/git-for-ai/sessions` and linked from the ledger. The refs are pushed to the same
GitHub remote, so a clone followed by `git for-ai sync --fetch` gives you the full record of
how the code came to be, and `git for-ai ask "..."` answers from it.

If the executable is not on `PATH` (for example after a Node version switch), the hooks are
no-ops and `doctor` reports it. Relink with `npm link` from `packages/cli`
([`GETTING_STARTED.md`](GETTING_STARTED.md) has the details), and unlink with
`npm unlink -g git-for-ai` while you want commits to go unrecorded.

## Environment notes

- Line endings are pinned to LF by `.gitattributes` for every platform. Blob SHAs key the
  embedding cache and the ledger's scope items, so endings must never flip. A CRLF warning
  means something is writing CRLF; fix the writer.
- `node:sqlite` prints an `ExperimentalWarning` when loaded, which is why its require is
  deferred until a store is opened.
- The model cache is per user under `%LOCALAPPDATA%\git-for-ai\models`
  (`GIT_FOR_AI_MODEL_CACHE` overrides). A full reindex of this repository takes about 80
  seconds on a GPU and tens of minutes on a CPU.
- Keep total memory of spawned work under about 5 GB, and never run the embedder at the same
  time as the test suites.
- A git spawn costs 25 to 30 ms on Windows. Any read that touches many commits must use the
  batched readers in `core/src/git` (`catFileBatch`, `readChangeMapSnapshot`,
  `readLedgerNotesForCommits`, `readSessionRecords`) rather than one process per commit.

## Design documents

The `architecture/` folder is the specification the code conforms to. `ARCHITECTURE.md` §7
(identity and rewrite survival) is the heart of the system; `DATA_MODEL.md` pins every record
shape and `CLI_REFERENCE.md` every command. `REVIEW_UI.md`, `DESKTOP.md` and `ASK_TOOLS.md`
specify the review page, the desktop shell and the tool loop behind `ask`. Code comments cite
these by section. `ROADMAP.md` lists known gaps.

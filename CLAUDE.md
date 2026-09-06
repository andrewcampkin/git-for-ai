# CLAUDE.md — working context for agents in this repo

git-for-ai: intent-aware source control layered on Git (TypeScript/Node pnpm+turbo monorepo,
Windows-first). Specs: `architecture/ARCHITECTURE.md` (identity model §7 is the heart),
`DATA_MODEL.md`, `CLI_REFERENCE.md`, `REVIEW_UI.md`, `DESKTOP.md`, `ASK_TOOLS.md`. Known gaps:
`architecture/ROADMAP.md`. Human-facing guides: `docs/`.

## The repo dogfoods itself — act accordingly

This repo runs git-for-ai on its own history. When `git-for-ai` is on PATH, hooks fire on
every commit: a Change-Id trailer is injected, the change-map is updated, and YOUR session
transcript is captured (redacted) into `refs/git-for-ai/sessions` and linked from the
ledger. This is a feature, not a surprise. It also means `git for-ai ask "..."` can answer
questions about why past code is the way it is — use it before re-deriving old decisions.

## Build / test

- Root: `pnpm turbo build`, `pnpm turbo test` (all packages; ~700 tests, all green is the
  baseline). Per package: `pnpm vitest run [path]` inside `packages/<name>`.
- `pnpm lint` does not run (no ESLint dependency is wired up). `tsc -b` via build/typecheck
  is the effective gate.
- Piped commands mask build failures (`build | tail` exits 0 via the pipe). Run the gating
  command unpiped before claiming green.
- pnpm comes from corepack (`corepack enable`). If `git-for-ai` is not on PATH the hooks
  silently no-op; `git for-ai doctor` says so.

## Hard rules (each one encoded in tests where possible)

- **Never mock git.** All tests use real temp repos via `createFixtureRepo()` from
  `@git-for-ai/core/testing`. The one sanctioned mock seam is external HTTP (Anthropic /
  Voyage) via injectable `fetchImpl`.
- **Reads never mint identity.** `log`/`show`/`report`/`review`/query paths must not create
  change-map rows as a side effect (see the non-minting pattern in `show.ts`). Only
  deliberate writes (`annotate`, hooks, `relink`) may. Server/UI tests assert ref
  byte-identity (`git for-each-ref`); keep that property.
- **A hook must never break a commit.** Hook-invoked commands always exit 0 and log
  failures instead (`capture-session`, `internal-hook`).
- **Ledger is append-only; writes emit JSONL** (`ledger-note@2`, one line per entry).
  Readers accept the legacy `@1` envelope forever. Reads never rewrite storage.
- **Honest degradation.** Missing data gets an explicit label ("no captured intent"), never
  fabrication. Confidence lines are derived from retrieval signals, never model-self-reported.
- **Package boundaries.** `core` never imports CLI/UI frameworks; `review-ui` never imports
  core (types-only bridges are fine). `schemas` depends on nothing internal.
- **RAM rule.** Keep spawned work under about 5 GB total. Never load the real embedding model
  in tests (use `BagOfWordsEmbedder` / synthetic vectors; env-gated seams exist). Never run
  the embedder concurrently with test suites or other heavy work.
- **API keys.** The tool-scoped `GIT_FOR_AI_ANTHROPIC_KEY` is preferred over
  `ANTHROPIC_API_KEY` (a global key would be picked up by Claude Code itself). Tests pin keys
  empty/explicit so a real key is never spent. Never print key values; check
  existence/length only.
- **Audience split.** The review page is for HUMANS only; design it opinionated. Agents
  consume `--json` output and the MCP tools; those surfaces carry everything and must stay
  complete and stable.
- **The UI speaks product, not process.** On-screen text must never contain internal
  vocabulary (ledger, change-map, spans, "captured intent"), design rationale ("never
  inferred or fabricated"), plumbing (that a local read-only server on 127.0.0.1 serves the
  page), or what OTHER audiences use instead (`--json`, MCP). The user is someone reviewing
  what agents did to their repo; write only what helps them do that. Honest empty states
  stay honest: "No reasoning recorded" is required, the essay defending it is not.
  Rationale belongs in code comments and the architecture docs.
- **Whole-history reads batch their git calls.** A git spawn is ~25–30 ms on Windows, so
  per-commit reads are what make a page hang. Use `readChangeMapSnapshot`,
  `readLedgerNotesForCommits`, `readSessionRecords` and `catFileBatch` on any path that
  touches many commits, and keep new bulk readers equivalence-tested against the single-item
  reader they replace (`core/src/git/batchReads.test.ts`).

## Working practices

- Spec first: a nontrivial new surface gets an `architecture/*.md` spec before code.
- Document judgment calls in file headers, in present tense, as what the code does and why.
- Independently re-run build and tests before committing; never trust a report alone. Read
  the highest-risk files personally (identity, redaction, key handling, storage migrations).
- Stage explicit paths, never `git add -A` / `-u`, and run `git show --stat` right after each
  commit.
- Long runs must checkpoint observable progress: batch with per-batch checkpoints, write a log
  file, and set a no-progress timeout.
- Report honestly: failures stated plainly with output, skipped steps named.
- Do not leave processes running.

## Environment quirks

- Windows: line endings are pinned LF by `.gitattributes` (blob SHAs key the embedding cache,
  so endings must never flip). A CRLF warning means something is writing CRLF; fix the
  writer, don't silence the warning. The Bash tool is POSIX; PowerShell is primary; don't mix
  syntaxes. 8.3 short paths can differ from what git reports; canonicalize via realpath when
  comparing paths.
- `node:sqlite` is the sqlite (never better-sqlite3; it cannot build here); it prints an
  ExperimentalWarning when loaded, which is why its require is deferred in `store.ts`.
- The model cache is per-user under `%LOCALAPPDATA%\git-for-ai\models`
  (`GIT_FOR_AI_MODEL_CACHE` overrides).

## Documentation

- Bring documentation up to date as part of finishing any task. Document what the project
  does, not what it might do or used to do. Prefer deleting a stale section to updating it.
- Reference rules by name, never by number.

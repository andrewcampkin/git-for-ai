# CLAUDE.md — working context for agents in this repo

git-for-ai: intent-aware source control layered on Git (TypeScript/Node pnpm+turbo monorepo,
Windows-first dev environment). The CLI is feature-complete; current direction lives in
[`architecture/ROADMAP.md`](architecture/ROADMAP.md). Specs: `architecture/ARCHITECTURE.md`
(identity model §7 is the heart), `DATA_MODEL.md`, `CLI_REFERENCE.md`, `REVIEW_UI.md`.
How the project evolved: `architecture/history/` — but prefer the live ledger:
`git for-ai log --intent` and `git for-ai show <sha>` give ground truth with reasoning.

## The repo dogfoods itself — act accordingly

This repo runs git-for-ai on its own history. Hooks fire on every commit: a Change-Id
trailer is injected, the change-map is updated, and YOUR session transcript is captured
(redacted) into `refs/git-for-ai/sessions` and linked from the ledger. This is a feature,
not a surprise. It also means `git for-ai ask "..."` can answer questions about why past
code is the way it is — use it before re-deriving old decisions.

## Build / test

- Root: `pnpm turbo build`, `pnpm turbo test` (all packages; ~570+ tests, all green is the
  baseline). Per package: `pnpm vitest run [path]` inside `packages/<name>`.
- `pnpm lint` is broken repo-wide (pre-existing, known, on the roadmap). Don't chase it;
  `tsc -b` via build/typecheck is the effective gate.
- Piped commands can mask build failures (`build | tail` exits 0 via the pipe) — this bit us
  once; run the gating command unpiped before claiming green.

## Hard rules (each one earned, most encoded in tests)

1. **Never mock git.** All tests use real temp repos via `createFixtureRepo()` from
   `@git-for-ai/core/testing`. The one sanctioned mock seam is external HTTP (Anthropic /
   Voyage) via injectable `fetchImpl`.
2. **Reads never mint identity.** `log`/`show`/`report`/`review`/query paths must not create
   change-map rows as a side effect (see the non-minting pattern in `show.ts`). Only
   deliberate writes (`annotate`, hooks, `relink`) may. Server/UI tests assert ref
   byte-identity (`git for-each-ref`) — keep that property.
3. **A hook must never break a commit** — hook-invoked commands always exit 0 and log
   failures instead (`capture-session`, `internal-hook`).
4. **Ledger is append-only; writes emit JSONL** (`ledger-note@2`, one line per entry).
   Readers accept the legacy `@1` envelope forever. Reads never rewrite storage.
5. **Honest degradation.** Missing data gets an explicit label ("no captured intent"),
   never fabrication. Confidence lines are derived from retrieval signals, never
   model-self-reported.
6. **`core` never imports CLI/UI frameworks**; `review-ui` never imports core (types-only
   bridges are fine). `schemas` depends on nothing internal.
7. **RAM < 5GB total for spawned work** (owner rule; their machine). Never load the real
   embedding model in tests (use `BagOfWordsEmbedder` / synthetic vectors; env-gated seams
   exist). Never run the embedder concurrently with test suites or other heavy work.
8. **API keys**: the tool-scoped `GIT_FOR_AI_ANTHROPIC_KEY` is preferred over
   `ANTHROPIC_API_KEY` (a global key would be picked up by Claude Code itself — the owner
   explicitly doesn't want that). Tests pin keys empty/explicit so the real key is never
   spent. Never print key values; check existence/length only.
9. **Audience split** (owner direction): the review page is for HUMANS only — design it
   opinionated. Agents consume `--json` output and the MCP tools; those surfaces carry
   everything and must stay complete/stable.

## How multi-agent work runs here (the pattern that built this)

- One background agent per milestone, briefed with: exact doc sections to read, exact
  prior modules to build on, a HARD file-scope boundary (critical when agents run in
  parallel — bin.ts was the classic conflict), test requirements, and an instruction to
  document judgment calls in file headers and report them.
- Spec-first: nontrivial new surfaces get an `architecture/*.md` spec before code (that's
  how REVIEW_UI.md happened, at the owner's own prompting).
- Agents NEVER commit. The orchestrating session independently re-runs build+tests (never
  trust the report alone), personally reads the highest-risk files (identity, redaction,
  key handling, storage migrations), then commits with a message explaining what was built,
  the judgment calls, and attribution.
- **Stage explicit paths, never `git add -A` / `-u`, while any agent shares the tree** —
  a half-written agent file got swept into a commit once; caught on the immediate
  post-commit `git show --stat`, which is itself a habit worth keeping.
- Long runs must checkpoint observable progress (the first real-model reindex stalled for
  an hour inside one giant call with zero durable output; batching with per-batch
  checkpoints is now the law of the land). Instrument background runs with a log file and
  a no-progress timeout.

## Working with this owner

- Wants honest reporting above all: failures stated plainly with output, skipped steps
  named, confessions over cover-ups (mistakes were always forgiven when reported; the
  commit history openly records two process slips).
- Approves direction at decision points, then expects autonomous execution ("continue")
  without permission-seeking. Surface genuine decisions (format migrations, surface
  ordering) as explicit options with a recommendation; everything else, just do.
- Values visible/tangible progress — when a stretch of work is all plumbing, say so and
  point at the nearest visible artifact (`report`, the review UI, real `ask` answers).
- Their machine is a shared resource: respect the RAM rule, and don't leave processes
  running.

## Environment quirks

- Windows: CRLF warnings on commit are normal noise. Bash tool is POSIX; PowerShell is
  primary — don't mix syntaxes. 8.3 short paths broke a blame test once (canonicalize via
  realpath when comparing paths git reports).
- `node:sqlite` is the sqlite (never better-sqlite3 — it can't build here); it prints an
  ExperimentalWarning when loaded, which is why its require is deferred in `store.ts`.
- The model cache is per-user under `%LOCALAPPDATA%\git-for-ai\models`
  (`GIT_FOR_AI_MODEL_CACHE` overrides).

## Documentation

- Always bring documentation up to date at the end of a task. The user will ask you immediately to do it anyway so you can just always include it within standard task finish up.

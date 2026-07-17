# Session Handoff — Resume Here

Written 2026-07-17, end of session (hit the usage limit for the 4-hour window). Read this
file first before doing anything else — it's the fastest path back to full context.

## TL;DR

**M1–M8 are done, tested (203 tests, all passing), committed, and dogfooded on two real
repos.** The engine (schemas, git layer, identity resolver, ledger) and the first four CLI
commands (`init`, `log --intent`, `show`, `capture-session`) all work. Remaining:
**M9–M14** (embeddings, `reindex`, `ask`/`blame --why`, `sync`, `doctor`) — see
[`architecture/CLI_PLAN.md`](architecture/CLI_PLAN.md) for their full specs, unchanged.

There's also one real gap discovered *during* dogfooding that isn't one of the numbered
milestones: the **`internal-hook` dispatcher doesn't exist yet** (see below) — decide whether
to fix that before or alongside M9.

## What's built and verified

| Milestone | What | Status |
|---|---|---|
| M1 | `@git-for-ai/schemas` — Zod schemas for every DATA_MODEL.md record | ✅ commit `35e9a98` |
| M2 | `@git-for-ai/core` git access layer (execa-wrapped, real git only) | ✅ commit `8bf04e4` |
| M3 | Identity resolver (change-map, `resolveChangeId`, `onPostRewrite`) | ✅ commit `8b27d08` |
| M4 | Ledger read/write (append-only notes) | ✅ commit `73bda1f` |
| M5 | `git for-ai init` | ✅ commit `5ce284f` |
| M6 | `git for-ai log --intent` | ✅ commit `5ce284f` |
| M7 | Session capture (redaction, transcript adapter, content-addressed store) | ✅ commit `8e25afb` |
| M8 | `git for-ai show <commit\|c/change-id>` | ✅ commit `b2c9038` |

All built by parallel background agents on **Fable 5**, reviewed and independently
re-verified (build + test, and a manual read of the highest-risk code — the identity
resolver and the redaction module) by the orchestrating session before each commit.
Fable's output across all 8 milestones was consistently careful: real git fixtures (no
mocking), honest documentation of judgment calls, and it caught real bugs on its own
(e.g. git notes' concatenating-append behavior in M4, the autosquash double-emission in M3).

**Test status**: 156 core tests + 47 CLI tests = 203, all passing, all against real
temporary git repos via `createFixtureRepo()` (`@git-for-ai/core/testing`).

## The two dogfood repos

1. **`C:\src\git-for-ai`** (this repo) — now a real git repo (`git init` done this session),
   `git for-ai init`-ed on itself. Has a real change-map, a real ledger with entries seeded
   for the M3 and M5+M6 commits (see the seed scripts' approach — manually calling
   `assignChangeId`/`appendLedgerEntry` to simulate what automatic capture will eventually
   do for every commit), **and one REAL captured session**: committing M7 actually triggered
   the real Claude Code hook, which captured **348 real spans of this actual conversation**
   into `refs/git-for-ai/sessions`. Run `git for-ai show 8e25afb --session` to see it.
2. **`C:\src\git-for-ai-testbed`** (sibling repo, not nested) — a small vanilla HTML/CSS/JS
   reading-list app with a deliberately realistic history (9 commits + 1 merge, one real
   amend, real rationale in every commit message). Also `init`-ed, with 2 seeded ledger
   entries. This is the intended long-term testbed for manual CLI evaluation.

**`git-for-ai` is npm-linked globally** (`npm link` was run in `packages/cli`), so
`git for-ai <cmd>` works as a native git subcommand in any repo on this machine right now.
No need to re-link tomorrow unless `node_modules` gets wiped.

## Known issues to resolve

### 1. `internal-hook` dispatcher doesn't exist — real commits don't get proper identity yet

`git for-ai init` installs `commit-msg`/`post-commit`/`post-rewrite` hooks that all invoke:

```sh
git-for-ai internal-hook <hook-name> "$@" || true
```

`internal-hook` was a **placeholder dispatch target** (a judgment call the M5 agent made
explicitly, documented in `init.ts`'s header) — it was never meant to be built by M5, but
nothing since has built it either. Consequence: every real commit you make right now prints
`error: unknown command 'internal-hook'` (harmless — `|| true` swallows it) and gets **no
Change-Id trailer and no automatic change-map entry**. This is why `git for-ai show HEAD` on
real commits shows `origin: orphan-recovery` / `trailer: not seen` instead of a properly
assigned identity — the only reason identity exists at all right now is that
`capture-session`'s own call to `resolveChangeId` mints one via the R5 fallback branch.

**This needs to get built** — likely a new command `git for-ai internal-hook <name>` in
`packages/cli/src/commands/`, dispatching to:
- `commit-msg`: inject a `Change-Id` trailer into the commit message file *before* the SHA
  is finalized (per §7.2 — this is a message-file rewrite, not a post-commit action).
- `post-commit`: call `assignChangeId(HEAD)` to record the change into the change-map.
- `post-rewrite`: parse stdin (`parsePostRewriteInput`, already implemented in M3) and call
  `onPostRewrite(pairs)`.

This isn't one of the numbered milestones in `CLI_PLAN.md` — it's real work the dogfooding
session surfaced that the plan didn't anticipate needing this early. Worth deciding: fix this
first (makes every future dogfood commit behave correctly), or press on with M9 and circle
back. Given how much of the system's value depends on identity actually working on real
commits (not just synthetic test fixtures), **fixing this first is probably the better call.**

### 2. `better-sqlite3` native build is broken on this machine — blocks M9

Node 24.8.0 has no published prebuilt binary yet, and building from source fails (installed
VS2022's ClangCL component is missing). `better-sqlite3` was removed from
`packages/core/package.json` to unblock M1–M8. **Before starting M9**, resolve via (in order
of preference, per `CLI_PLAN.md`'s M9 risk register):
1. Try Node's built-in **`node:sqlite`** module (available since Node 22.5, zero native
   compile) — check whether it supports `loadExtension` for loading `sqlite-vec`. If yes,
   this is strictly better than `better-sqlite3` for this project (removes the native-build
   dependency entirely).
2. Install the missing VS "C++ Clang Compiler for Windows" component and retry.
3. Pin Node to a version with a published prebuilt binary.

### 3. M13 (`sync`) has an open design issue, already documented in `CLI_PLAN.md`

`cat_sort_uniq` notes-merge (§12.2) assumes line-oriented content, but the ledger note body
is one multi-line JSON envelope — a literal `cat_sort_uniq` merge of two divergent envelopes
won't produce valid JSON. `CLI_PLAN.md`'s M13 section already has the full writeup and two
candidate fixes (custom merge driver vs. JSONL reformat). Decide before M13 starts.

## Remaining milestones (unchanged from CLI_PLAN.md)

- **M9** — embeddings/vector index (tree-sitter chunking, `Embedder` interface +
  transformers.js default, `VectorStore` + sqlite-vec/`node:sqlite`). Blocked on issue #2 above.
- **M10** — `git for-ai reindex`.
- **M11** — query engine (hybrid FTS5+vector retrieval + synthesis). Honest scope note
  already in the plan: synthesis likely needs an Anthropic API key; retrieval stays offline.
- **M12** — `git for-ai ask` / `git for-ai blame --why`.
- **M13** — `git for-ai sync`. Blocked on issue #3 above.
- **M14** — `git for-ai doctor`.

## Environment notes (for whichever machine resumes this)

- Node v24.8.0, pnpm 9.15.0, git 2.45.1, Windows 11, VS2022 Enterprise (ClangCL missing).
- Global git identity already configured: `Andrew Campkin <andrewcampkin@gmail.com>`.
- `.nvmrc` says Node 22 (the original recommendation); the machine actually runs Node 24.
  Worth reconsidering whether to actually pin to 22 given the `better-sqlite3` friction.

## How milestone agents were briefed (the pattern to keep using)

Each milestone was one `Agent` call, `subagent_type: general-purpose`, `model: fable`,
`run_in_background: true` (default), with a prompt that always:
1. Named the exact doc sections to read first (never assume — cite `architecture/*.md` §s).
2. Named the exact prior-milestone modules to build on (imports, not re-derivation).
3. Set a hard scope boundary (which files/directories it may touch; explicitly not
   `bin.ts` when two agents ran in parallel, to avoid a shared-file conflict — `bin.ts`
   wiring was always done by the orchestrating session afterward, once both landed).
4. Required real git fixtures (`createFixtureRepo()` / `@git-for-ai/core/testing`) —
   never mocked git.
5. Required the agent to run build+test itself and fix failures before reporting done.
6. Asked explicitly for judgment calls the docs didn't pin down, documented in-code.

After each completion notification: independently re-run build+test (never trust the
agent's own report alone), read the highest-risk files personally (identity resolver,
redaction), then commit with a message explaining what was built, key judgment calls, and
attributing the implementation to the agent/model.

## Commit log so far

```
91a01fc Initial commit: research, design docs, and monorepo scaffold
35e9a98 M1: implement @git-for-ai/schemas
8bf04e4 M2: implement @git-for-ai/core git access layer
8b27d08 M3: implement @git-for-ai/core identity resolver
73bda1f M4: implement @git-for-ai/core ledger read/write
5ce284f M5+M6: implement cli init and log --intent, wire bin.ts
b2c9038 M8: implement cli show, wire into bin.ts
8e25afb M7: implement session capture - the differentiator
```

(Note: M4 was committed before M3 despite the numbering — both landed the same wave, order
was just completion order, not a dependency issue; M3 doesn't depend on M4.)

## Suggested first steps tomorrow

1. Skim this file, then `architecture/CLI_PLAN.md`'s M9 section and the risk-register note.
2. Decide: fix `internal-hook` first, or press on with M9 (recommend: fix `internal-hook`
   first — it's small, and it makes every subsequent dogfood commit behave correctly instead
   of minting orphan identities).
3. Resolve the `better-sqlite3`/`node:sqlite` question before touching M9's actual code.
4. Keep using the Fable-agent-per-milestone pattern above; it's working well.

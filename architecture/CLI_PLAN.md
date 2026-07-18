# git-for-ai — CLI Implementation Plan

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`DATA_MODEL.md`](./DATA_MODEL.md),
[`CLI_REFERENCE.md`](./CLI_REFERENCE.md), and [`MONOREPO_PLAN.md`](./MONOREPO_PLAN.md). Those
documents say *what* to build. This one says *in what order*, with a definition of done for each
step, so building can start without re-deriving sequencing decisions from scratch.

Scope: this plan covers exactly the three packages that make up a working CLI —
`@git-for-ai/schemas`, `@git-for-ai/core`, and `git-for-ai` (the `cli` package) — which are already
scaffolded under `packages/`. `server`, `desktop`, and `website` are out of scope here; see
[`MONOREPO_PLAN.md`](./MONOREPO_PLAN.md) for when they come up.

> **Status (2026-07-19): M0–M10 are done, tested, committed, and dogfooded on this repo.**
> M11 (query engine) is in progress; then M12 `ask`/`blame --why`, M13 `sync`, M14 `doctor`.
> Additions beyond this plan (internal-hook dispatcher, `annotate`, `report`,
> `relink`/`reconcile`, the R4 redesign) are sequenced in
> [`./PLAN_2026-07-18.md`](./PLAN_2026-07-18.md), which supersedes this file's ordering.
> Historical session notes live in [`./history/`](./history/HANDOFF_2026-07-17.md).
> Milestone sections below are unchanged as specs; only the checkmarks are new.

---

## 1. What "done" means

A CLI is done for personal-use v0.1 when this sequence works, on a real repo, without manual
intervention:

1. `git for-ai init` in a repo you already work in.
2. You do a piece of work through Claude Code (a plan, some edits, a commit).
3. `git for-ai log --intent` shows that commit with a real one-line intent summary, not "no
   captured intent."
4. `git for-ai blame --why <file>:<line>` on a line from that change gives back the actual
   reasoning, not just the commit message.
5. `git for-ai ask "<some real question about your own repo>"` gives a plausible, sourced answer.
6. `git for-ai sync --push` to a scratch remote round-trips correctly onto a second clone.
7. `git for-ai doctor` reports healthy.

Everything below is sequenced to hit step 3 (the first genuinely satisfying moment) as early as
possible, then build outward.

---

## 2. Package dependency graph (recap)

```
@git-for-ai/schemas   (no internal deps)
        ↑
@git-for-ai/core      (depends on schemas)
        ↑
git-for-ai (cli)      (depends on core, schemas)
```

Build and test in this order; nothing in `core` should ever import from `cli`, and nothing in
`schemas` should ever import from `core` (see `MONOREPO_PLAN.md` §3.2 for why this boundary is
worth protecting from day one).

---

## 3. Milestones

Each milestone lists: what gets built, where, how it's tested, and its definition of done. They're
numbered for reference, not necessarily meant as separate PRs — group them however makes sense, but
don't skip ahead of a milestone's dependencies.

### M0 — Verify the scaffold actually builds ✅ DONE

Run `pnpm install` at the repo root, then `pnpm build` and `pnpm typecheck` through Turborepo. At
this point every package only has placeholder files (`export {}`), so this should succeed trivially
— the point is to catch monorepo-wiring problems (bad `tsconfig` references, workspace protocol
issues) before there's real logic to debug alongside them.

**Watch for on Windows specifically** (per the dev environment): `better-sqlite3` ships prebuilt
binaries for common platform/Node-version combinations, so it *usually* avoids needing a native
build toolchain (Visual Studio Build Tools) — but it's worth confirming `pnpm install` succeeds
without falling back to a from-source build before relying on it. If it does fall back, that's a
signal to pin a Node version with prebuilt binary support rather than debug a native toolchain.

**Definition of done:** `pnpm build && pnpm typecheck` succeeds from a clean clone.

---

### M1 — `@git-for-ai/schemas`: the record types ✅ DONE (commit `35e9a98`)

Implement Zod schemas for `LedgerEntry` (+ its `ScopeItem` and `reasoning` sub-shapes),
`SessionRecord` (+ `spans`), `ChangeMapEntry`, and `RepoConfig` — field-for-field matching
[`DATA_MODEL.md`](./DATA_MODEL.md) §1–5. Export both the Zod schemas and their inferred
TypeScript types.

**Tests:** for each schema, one test parsing the exact worked example already given in
`DATA_MODEL.md`/`ARCHITECTURE.md` §6 (they should parse cleanly), and one test per required field
confirming a missing/malformed value is rejected. This package has no I/O, so tests are pure
unit tests — the fastest, least risky milestone, good as a first PR.

**Definition of done:** every example payload in `DATA_MODEL.md` parses; `schema` version-field
mismatches are rejected per the "reject unknown major version" rule in `DATA_MODEL.md`'s header.

---

### M2 — `@git-for-ai/core/git`: the git access layer ✅ DONE (commit `8bf04e4`)

Implement the `execa`-wrapped git access functions per `ARCHITECTURE.md` §4.1: `runGit(args)`,
`readHead()`, `readCommitMessage(sha)`, `catFile(blobSha)`, `listRefs(pattern)`,
`revParse(ref)`, `notesShow(ref, sha)`, `notesAppend(ref, sha, body)`, `notesMerge(...)`, plus the
plumbing primitives needed later for the change-map (`hashObject`, `mktree`, `commitTree`,
`updateRef`, `lsTree`).

**Tests:** integration tests against a *real* temporary git repo — a test helper that does
`fs.mkdtemp` + `git init` + a scripted sequence of commits — not mocked. This project's whole
premise is behavioral parity with real git, so the test suite should exercise real git from the
start rather than build confidence against a mock that could silently drift from real behavior.

**Definition of done:** every function in this module has at least one test against a real
temp-repo fixture; a shared `createFixtureRepo()` test helper exists for reuse by later milestones.

---

### M3 — `@git-for-ai/core/identity`: the resolver (the hard part) ✅ DONE (commit `8b27d08`)

Implement, in order:

1. `assignChangeId(newSha)` — the first-commit logic from `ARCHITECTURE.md` §7.2 (mint or adopt a
   trailer, upsert the change-map).
2. The change-map itself as a real git ref: a tree of shard files under `refs/git-for-ai/change-map`
   (`DATA_MODEL.md` sharding layout), written/read via M2's plumbing primitives.
3. `resolveChangeId(sha)` — the full resolution algorithm from `ARCHITECTURE.md` §7.3 (the
   flowchart), including the self-healing write-back on trailer-recovery.
4. `onPostRewrite(pairs)` — the amend/rebase/squash folding logic from §7.4, handling the
   many-old-SHAs-to-one-new-SHA case.

**Tests:** this is where the test suite earns its keep. Scenarios to script against real fixture
repos: plain commit → resolve; amend → resolve (change-id unchanged); interactive rebase with
squash → resolve (folding, `folded_into` set correctly); **cherry-pick into a second fixture repo
with no `post-rewrite` ever firing** → resolve (must self-heal via the trailer, per §7.5) — this
last one is the single most important test in the whole codebase, since it's the scenario the
architecture spec spent the most words on.

**Definition of done:** all four rewrite scenarios in `ARCHITECTURE.md` §7.4–7.5 have a passing
test against a real git fixture, including the cherry-pick lazy-healing path.

---

### M4 — `@git-for-ai/core/ledger`: intent read/write ✅ DONE (commit `73bda1f`)

Implement `appendLedgerEntry(changeId, entry)` and `readLedgerEntries(changeId)` /
`resolveEffectiveEntry(entries)` per `ARCHITECTURE.md` §6.1 and §12.2 — notes as an append-only
JSON array, never mutated in place; effective-entry resolution by newest `created_at` with the
documented tiebreak.

**Tests:** append two entries to the same change-id, confirm both persist and the effective one is
the newer; confirm the on-disk note body matches the exact envelope shape in `DATA_MODEL.md` §2.1.

**Definition of done:** `git notes show refs/notes/git-for-ai/intent <sha>` on a fixture repo, run
by hand, shows a human-readable JSON array matching the spec.

---

### M5 — `cli init` — first real end-to-end milestone ✅ DONE (commit `5ce284f`)

Wire `packages/cli/src/commands/init.ts`: install `commit-msg`/`post-commit`/`post-rewrite` git
hooks (respecting an existing `core.hooksPath`, appending rather than clobbering), write/merge
`.claude/settings.json` project hooks, configure (not enable-auto-follow) the three refspecs,
create `.git-for-ai/`, add it to `.git/info/exclude`, write an empty `config.toml` recording the
chosen embedder default. Sqlite-vec index initialization can be a stub (empty file, real schema
comes in M9) — `init` doesn't need embeddings to be useful yet.

**Tests:** run against a fixture repo, assert every file/hook/ref-config exists afterward; assert
running it twice is a no-op (idempotency, per `CLI_REFERENCE.md`).

**Manual test:** run it for real, in a scratch repo, and read the output against the exact console
transcript already specified in `CLI_REFERENCE.md`.

**Definition of done:** matches the `init` output and idempotency guarantee in `CLI_REFERENCE.md`
exactly.

---

### M6 — `cli log --intent` — validates M2–M4 together, no embeddings needed ✅ DONE (commit `5ce284f`)

Wire `commands/log.ts`: for each commit in range, resolve its change-id (M3), look up its ledger
entry (M4), print the annotated line format from `ARCHITECTURE.md` §9.1's example. Must degrade
gracefully to `[no intent: pre-git-for-ai]` for commits with no entry.

**Definition of done:** running this on the `git-for-ai` monorepo's own (once-it-exists) git history
produces sensible output, including the "no intent" case for pre-scaffolding commits.

---

### M7 — Session capture: closes the loop on the actual differentiator ✅ DONE (commit `8e25afb`) — self-captured its own implementation session, see HANDOFF.md

Implement `@git-for-ai/core/sessions` (redaction pass — start with the pattern list in
`ARCHITECTURE.md` §13: AWS keys, tokens, private key blocks, JWTs, connection strings, plus
configurable ignore-globs; fail-closed on error) and `commands/capture-session.ts` (the
`--event plan` / `--event maybe-commit` dispatch from §10.2, reading the Claude Code hook payload
from stdin, slicing the transcript JSONL, assembling OTel-GenAI-shaped spans, writing the
content-addressed session object under `refs/git-for-ai/sessions/*`, and enriching the M4 ledger
entry with `session_ref`).

**Tests:** unit tests for the redaction ruleset against known secret-shaped strings (must catch,
must not false-positive on normal code); a synthetic hook-payload fixture (a fake but
format-accurate JSONL transcript) run through the full capture path, asserting the resulting
session object and enriched ledger entry match `DATA_MODEL.md` shapes.

**Manual test (the real payoff moment):** wire the built CLI's `capture-session` into an actual
Claude Code session's `.claude/settings.json` hooks in a scratch repo, do a real piece of work
through Claude Code, make a commit, and confirm a session trace actually gets captured. This is the
first point where the system does the thing it was designed to do, end to end.

**Definition of done:** a real Claude Code session, committed through, produces a ledger entry with
a non-null `session_ref` pointing at a readable, redacted session object.

---

### M8 — `cli show <commit>` — debugging tool, exercises the full read path ✅ DONE (commit `b2c9038`)

Wire `commands/show.ts`: dump the ledger entry and (if present) the session record for a commit, in
both human-readable and `--json` form. Cheap to build (it's M3+M4+M7's read paths with formatting),
valuable because it's the fastest way to eyeball whether M7's captured data actually looks right
before building retrieval on top of it.

**Definition of done:** matches `CLI_REFERENCE.md`'s `show` spec.

---

### M9 — Embeddings: chunking, provider, vector store ✅ DONE (commit `6632bf8`) — node:sqlite + sqlite-vec, superseding the better-sqlite3 wording below

The other genuinely hard milestone. Three pieces in `@git-for-ai/core/embeddings`:

1. **Chunking** — `web-tree-sitter` (WASM, no native build step) parsing at function/class
   granularity per `ARCHITECTURE.md` §11.1. Start with grammars for TypeScript/JavaScript and
   Python only — covers this project's own source once it exists, and the most common case
   generally; add more languages later as needed, not preemptively.
2. **Embedder** — the `Embedder` interface from §11.3, with a `@xenova/transformers`-backed default
   implementation (in-process, downloads/caches a small open-weight code embedding model on first
   run — budget real time for this step; it's the one place "just works" needs verifying against
   an actual model download, not assumed) and a `fetch`-based Voyage AI implementation gated behind
   the explicit opt-in consent flag.
3. **VectorStore** — the interface from §11.4, with a `better-sqlite3` + `sqlite-vec` implementation
   (load the platform-appropriate prebuilt `sqlite-vec` extension via `db.loadExtension(...)`) plus
   an FTS5 mirror for hybrid retrieval.

**Tests:** chunker unit tests against small fixture source files (assert expected function/class
boundaries); embedder tests using a tiny fixed input set, asserting deterministic dimensionality and
that identical input produces identical output (cache-hit correctness); vector store tests for
insert/query round-trips using synthetic vectors (no need to invoke the real model for store-layer
tests).

**Definition of done:** given a small fixture repo with a handful of source files and one ledger
entry, `reindex` (M10) produces a queryable index; re-running it with no changes re-embeds nothing
(blob-hash cache hit).

---

### M10 — `cli reindex` ✅ DONE (commit `37f6315`) — dogfooded on this repo with the real model

Wire `commands/reindex.ts` over M9. Good first dogfood target: once `schemas`/`core` have real
source files, run `git for-ai reindex` on the `git-for-ai` repo itself.

**Definition of done:** matches `CLI_REFERENCE.md`'s `reindex` spec, including `--full` forcing a
complete re-embed.

---

### M11 — Query engine: retrieval + synthesis

Implement the hybrid (FTS5 + vector) retrieval step, then a synthesis step that turns retrieved
ledger entries/session summaries/code chunks into the prose answers shown in `ARCHITECTURE.md`
§9.1's `ask`/`blame --why` examples.

**Honest scope note on "offline by default" here:** retrieval (M9's index) is fully local and
requires no network call. *Synthesizing* a natural-language answer from the retrieved material is a
generation task, not a retrieval one — this plan's recommendation is to call the **Anthropic API**
(Claude) for that step specifically, the same way Claude Code itself works, rather than bundling a
second local generative model on top of the local embedding model. Concretely: if `ANTHROPIC_API_KEY`
is configured, `ask`/`blame --why` return a synthesized prose answer; if not, they fall back to
returning the raw ranked ledger entries/snippets unsynthesized (still genuinely useful, still fully
offline — just less polished). This keeps the "offline by default" promise honest for the
expensive-to-avoid part (embeddings) while being upfront that natural-language synthesis is an
API-dependent nice-to-have, not a local guarantee, unless a local LLM path is added later.

**Tests:** retrieval ranking tests against a small fixture index with known-relevant and
known-irrelevant content; synthesis step tests can mock the Anthropic client (this is the one
module where mocking the external dependency is appropriate, since the point being tested is prompt
construction and fallback behavior, not Claude's actual output quality).

**Definition of done:** given a fixture repo with 2–3 real ledger entries, a query targeting one of
them returns it as the top-ranked source, with or without an API key configured.

---

### M12 — `cli ask` and `cli blame --why`

Wire `commands/ask.ts` and `commands/blame.ts` over M11, matching the exact output format in
`ARCHITECTURE.md` §9.1 and `CLI_REFERENCE.md` (including the degraded "no captured intent" case,
and the "no API key, showing raw sources" case from M11).

**Definition of done:** the walkthrough in §1 of this document (steps 4–5) works on a real repo.

---

### M13 — `cli sync`

Wire `commands/sync.ts`: explicit `--push`/`--fetch` of the three refs (never automatic, per
`ARCHITECTURE.md` §12.1), configuring `notes.mergeStrategy=cat_sort_uniq` for the ledger ref.

**Open issue found during M4, resolve before implementing this milestone**: `cat_sort_uniq`
merges notes line-by-line, which is conflict-free for line-oriented content but the ledger note
body (per `DATA_MODEL.md` §2.1) is a single multi-line JSON envelope — a line-wise cat/sort/uniq
of two divergently-appended envelopes will not produce valid JSON. Before wiring `sync`, either
(a) design and implement a custom notes merge driver that parses both sides as `ledgerNoteSchema`,
unions their `entries` arrays, and re-serializes one valid envelope (probably the right answer,
and consistent with `ARCHITECTURE.md` §12.2's stated intent even though the literal
`cat_sort_uniq` mechanism doesn't achieve it), or (b) change the on-disk note format to be
genuinely line-oriented (e.g. one JSON object per line, JSONL-style, instead of one pretty-printed
envelope) so `cat_sort_uniq` works as originally assumed. Decide and document which before M13
starts.

**Tests:** push from one fixture repo to a scratch bare repo, fetch into a second clone, confirm
ledger/session/change-map data round-trips intact; simulate a concurrent-append conflict scenario
and confirm the `cat_sort_uniq` merge produces the union, not a conflict.

**Definition of done:** step 6 of §1's walkthrough works against a real scratch remote (a plain bare
repo is sufficient — this also doubles as the first real test of the `MONOREPO_PLAN.md` §5.1 claim
that no custom server software is needed for basic ref sync).

---

### M14 — `cli doctor`

Wire `commands/doctor.ts` last, since it audits everything built in M1–M13: hook installation,
`.claude/settings.json` wiring, refspec config, index schema/fingerprint health, embedding-provider
reachability, orphaned/trailer-recovered intent, skipped captures.

**Definition of done:** matches `CLI_REFERENCE.md`'s `doctor` spec; step 7 of §1's walkthrough
reports healthy on a repo that's been through M5–M13.

---

### Not in this plan's scope (later, v1.1+)

`reconcile`, `relink`, and `export --format agent-trace` (`commands/reconcile.ts`,
`relink.ts`, `export.ts` are scaffolded as placeholders already) follow the same build pattern as
above once M1–M14 are solid, but aren't needed for the v0.1 walkthrough in §1 and shouldn't block
it.

---

## 4. Testing strategy summary

- **Unit tests** (`vitest`) for anything with no I/O: schema validation, redaction pattern
  matching, resolution-algorithm pure logic, chunking.
- **Integration tests against real temporary git repos** — not mocked — for anything that touches
  git, per M2's `createFixtureRepo()` helper. This project's core premise is behavioral parity with
  real git; a test suite that mocks git away from itself would be testing the wrong thing.
- **One deliberately real, manual dogfood pass per milestone that touches Claude Code** (M7, and
  the full walkthrough in §1) — hook wiring is the one category of bug that's hard to catch with
  fixtures alone, since it depends on Claude Code's actual runtime behavior, not just file formats.

---

## 5. Risk register

| Risk | Where it bites | Mitigation |
|---|---|---|
| Identity resolver edge cases (cherry-pick, filter-repo, split) | M3 | Most words in `ARCHITECTURE.md` were spent here for a reason; test the cherry-pick scenario first, before anything else in M3. |
| `better-sqlite3` / `sqlite-vec` native/prebuilt binary friction, especially on Windows | M0, M9 | **Materialized during M0 on this machine**: Node 24.8.0 has no published `better-sqlite3` prebuilt binary yet, and the from-source fallback build failed (installed VS2022's ClangCL toolset component is missing). `better-sqlite3` and `@types/better-sqlite3` were removed from `packages/core/package.json` for now so M0–M8 aren't blocked. **Before starting M9**, resolve this — options, in order of preference: (1) use Node's built-in `node:sqlite` module (available since Node 22.5, no native compile at all — check whether it supports `loadExtension` for `sqlite-vec`, which determines whether this fully replaces `better-sqlite3` or not), (2) install the missing VS "C++ Clang Compiler for Windows" component and retry `better-sqlite3`, (3) pin Node to a version with a published prebuilt binary. Don't reintroduce `better-sqlite3` to `package.json` until one of these is confirmed working. |
| `@xenova/transformers` first-run model download size/latency | M9 | Budget real wall-clock time for this; don't assume "just works" without running it once for real. |
| Claude Code's session JSONL format drifting | M7 | Already designed for in `ARCHITECTURE.md` §10.2 (versioned adapter, fails soft) — implement the version-fingerprint check from day one in M7, not as an afterthought. |
| Synthesis step's dependency on an external API breaking the "offline" promise | M11 | Documented honestly above; retrieval-only fallback with no API key keeps the core promise intact. |

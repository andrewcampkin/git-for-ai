# ROADMAP.md — what comes after v1

Written 2026-07-19, the day the board cleared: the CLI is feature-complete against
[`CLI_REFERENCE.md`](./CLI_REFERENCE.md), the MCP server and review UI are shipped, and this
repo dogfoods everything. This document maps future work. How we got here lives in
[`history/`](./history/PROJECT_GENESIS.md) — and, more richly, in the repo's own ledger
(`git for-ai log --intent`, `git for-ai ask "..."`).

Items carry no dates. Order within each tier is rough priority. Decisions inherited from the
archived plans are marked ⭐ (owner-approved, don't re-litigate without cause).

## Tier 0 — indexing performance (flagged 2026-07-19: too slow for large repos as is)

Recorded at the owner's direction after repeated live failures: **reindex is too slow and
too fragile for anything beyond dogfooding.** Evidence from this repo (~1k chunks, a small
codebase): a full index takes tens of minutes of CPU inference; an incremental catch-up
(~500 chunks) died with a native onnxruntime out-of-memory ("bad allocation") and exited 0
silently (exit guard since added); the retry run burned 41 CPU-minutes producing zero
progress before being killed. A repo 10–100× larger is hours of compute and
worse odds. This tier gates use on large repos.

**Where the time actually goes — and the honest Rust assessment.** The owner asked whether
rewriting the CLI in Rust (the original design language) would help. Profiling says the
bottleneck is NOT JavaScript: >95% of reindex wall time is transformer inference inside
onnxruntime, which is already native C++ — transformers.js is a thin tensor-prep wrapper
around the same engine a Rust program would call (ort crate → same runtime, same model,
same latency). A Rust rewrite is weeks of work for single-digit-percent gains on the
JS-side orchestration (startup, chunking, git subprocess plumbing) and would NOT move
embedding throughput or fix the native OOM, which lives in ORT's allocator, not in Node.
**Recommendation: do not rewrite; attack the inference itself.** Revisit Rust only if
profiling ever shows JS-side dominance (chunking at huge scale is the one candidate).

What plausibly WOULD fix it, in leverage order:
1. **GPU execution provider — CHOSEN PATH (owner, 2026-07-19), in progress.** DirectML on
   the owner's RTX 3060 (12GB — the model needs <1GB): migrate to the maintained
   transformers.js successor for a modern onnxruntime with the DML execution provider,
   fp16 weights on GPU (int8 quantization doesn't accelerate; precision folds into the
   model fingerprint so vectors never mix), automatic CPU fallback, plus the watchdog /
   session-bounding hardening below. Everything stays on-device: no keys, no code leaving,
   the offline-by-default promise made fast instead of merely principled.
2. **Smaller/faster model** — the planned retrieval-quality eval (Tier 1) should compare
   the current 768-dim model against small fast ones (e.g. 384-dim) AND measure speed;
   if quality holds, 2–4× for free.
3. **Stability: bound ORT memory** — recreate the inference session every N batches
   and/or cap ORT arena/threads; the observed OOM after ~700 chunks suggests allocator
   growth across a long-lived session. Also add a per-batch watchdog to the reindex
   command itself (no progress in N minutes → fail loudly; never spin silently).
4. **Investigate over-invalidation** — the incremental run re-embedded ~494 chunks with
   only ~26 cache hits after ~8 commits; that reuse rate looks wrong (moved files keep
   their blobs and should hit). Measure invalidation per commit; if windows/nodePaths
   shift too easily, chunking stability is the fix and every future run gets cheaper.
5. **Cloud embedding — deferred.** Explored (Bedrock/Voyage mechanics,
   bring-your-own-cloud) and consciously put off: for local use the GPU path above makes
   it unnecessary.
6. **The shared-index server** (Tier 3) — for teams, embed once centrally; individual
   machines never pay the cost at all.

## Tier 1 — hardening and finish-work (before any new surface)

- **Publish the npm package**. Currently npm-linked only. GATE (owner, 2026-07-19): do
  nothing until a second machine or a first outside user exists — link is adequate for one
  dev box. Also owner-decided: **"git-for-ai" is the internal name only; the public
  name is TBD** and must be chosen before any public artifact (package, installer, app id).
  When triggered: version stamping (MCP server info reads the package version), workspace-
  dependency bundling, a clean-machine install smoke test, and the Node engines floor
  (`node:sqlite` requires ≥22.5; this repo runs 24).
- **Fix repo lint** — `pnpm lint` has NEVER worked (global ESLint 7 vs. flat config in
  `config/`, no eslint devDependency anywhere). Either wire ESLint 9 properly through turbo
  or delete the scripts; a permanently-red gate is worse than none.
- **Capture enrichment** (the one unfinished item from the executed plan): capture-session
  already parses test commands and outcomes in transcript spans — mine `reasoning.tested`
  (and plausibly `related`) into the auto-captured ledger entry instead of leaving those
  fields annotate-only.
- **Retrieval quality evaluation**: the offline embedder (jina-v2-code, quantized) was chosen
  for the offline-by-default promise, not measured quality. Build a small eval set of real
  questions against this repo's known-correct answers; compare quantized vs fp32 vs
  voyage-code-3. This decides whether the default stays honest or needs revisiting.
- **Read performance beyond `report` (2026-07-25).** `report` / `/api/overview` were fixed
  (123s → ~1.2s on this repo) by batching: `catFileBatch` + `readChangeMapSnapshot` /
  `readLedgerNotesForCommits` / `readSessionRecords`, all equivalence-tested. The same
  per-item pattern still exists elsewhere and should get the same treatment when it starts
  to hurt: `log --intent` and `doctor` resolve identity per commit, and enrichment /
  `findLaterTouches` remain O(all changes) per call. The measuring stick is now explicit
  (ARCHITECTURE §4.1): a read touching N commits should cost O(1) git processes.
- Small flagged debts: `inputType` knob on the embeddings factory (query path currently works
  around it); `reconcile --by-content` (patch-similarity re-link) still fails loudly as
  unimplemented; legacy-format ledger notes (doctor counts them) migrate only on next write —
  optionally add a `doctor --fix` mass-migrate for repos that want it done.

## Tier 2 — proving it beyond this repo

- **Dogfood on a real external project** (not git-for-ai itself). The testbed repo was
  synthetic; the tool's claims deserve a codebase that doesn't know about it. Expect this to
  surface capture-adapter and scale issues nothing else will.
- **PR integration, cheap version**: `git for-ai export --format pr-comment | gh pr comment`
  works today — document the recipe, then evaluate whether a GitHub Action that posts the
  effective entry on PR open is worth maintaining. (A full GitHub App is product-stage; not
  yet.)
- **Second capture adapter** (Aider or Cursor — whichever the owner actually encounters).
  The transcript-adapter interface was built for this; a second adapter validates it.

## Tier 3 — surfaces (inherited order ⭐: proven-need before build)

- **Desktop app — NOW ACTIVE (owner, 2026-07-19), promoted from this tier.** No longer a
  thin wrapper: the full plan, including the branch/merge groundwork it forced (the
  squash-merge fold gap found by testing) and the git-client elements it needs (branches,
  diffs, repo picker, action panel), lives in [`DESKTOP.md`](./DESKTOP.md). Progress:
  squash-merge fold (step 1), the Electron shell (step 4a), the read-only branch/diff API
  (step 2) and the branch + diff UI (step 3) are done; the token-gated actions panel
  (step 4b) and installers (step 5) remain.
- **Shared-index server** ⭐ — the ONLY server this project will ever need (ref sync is
  server-free; validated against real GitHub 2026-07-18). Job: run the embedding pipeline
  once for a team and expose `/ask`, `/blame` — Fastify + Postgres/pgvector (plays to the
  owner's DB strengths). Gate: a second machine or second person actually paying the
  redundant-embedding cost. Clients keep the local-index path; the server is an accelerator,
  never a source of truth.
- **Hosted service / website** ⭐ — explicitly product-stage: it is the review UI plus the
  shared-index server behind auth (org dashboards, review workflows). Only if this becomes a
  product. The website package slot stays empty until then.

## Tier 4 — the v2 ideas (from the original six; docs in `history/ideas/`)

- **Semantic drift detector** (idea 06) — flag when code has drifted from its recorded
  intent. Natural home: a `doctor` audit + the review UI's attention inbox ("this change's
  intent says X; the code no longer does X"). Needs the embeddings layer (have it) plus a
  diff-vs-intent comparison design. The strongest candidate for the next *novel* feature:
  it turns the ledger from memory into an active guarantee — "prove it's *still* true."
- **Intent knowledge graph** (idea 05) — cross-change navigation (this change supersedes /
  relates-to / was-constrained-by). Revisit once real usage shows which links matter;
  `reasoning.related` already accumulates the raw edges.

## Standing constraints (apply to everything above)

Git-native storage only; offline by default with consent-gated APIs; honest degradation
(never fabricate); a hook must never break a commit; reads never mint identity; the review
page serves humans, `--json`/MCP serve agents ⭐. Engineering practices for agents working
here: see [`../CLAUDE.md`](../CLAUDE.md).

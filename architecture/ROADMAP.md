# ROADMAP.md — what comes after v1

Written 2026-07-19, the day the board cleared: the CLI is feature-complete against
[`CLI_REFERENCE.md`](./CLI_REFERENCE.md), the MCP server and review UI are shipped, and this
repo dogfoods everything. This document maps future work. How we got here lives in
[`history/`](./history/PROJECT_GENESIS.md) — and, more richly, in the repo's own ledger
(`git for-ai log --intent`, `git for-ai ask "..."`).

Items carry no dates. Order within each tier is rough priority. Decisions inherited from the
archived plans are marked ⭐ (owner-approved, don't re-litigate without cause).

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
- Small flagged debts: `inputType` knob on the embeddings factory (query path currently works
  around it); enrichment/`findLaterTouches` are O(all changes) per call (fine solo, cache
  before teams); `reconcile --by-content` (patch-similarity re-link) still fails loudly as
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
  diffs, repo picker, action panel), lives in [`DESKTOP.md`](./DESKTOP.md).
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

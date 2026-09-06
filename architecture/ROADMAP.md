# ROADMAP.md — known gaps and planned work

What is not done, and what is next. Items carry no dates; order within each section is rough
priority. The standing constraints at the end apply to everything.

## Indexing on large repositories

A full reindex of this repository (~1.5k chunks) takes about 80 seconds on a Windows GPU
(DirectML, fp16) and tens of minutes on a CPU. A repository 10–100× larger would still run
into:

- **Model size.** The retrieval-quality evaluation below should compare the current 768-dim
  model against smaller, faster ones and measure speed as well as quality.
- **Runtime memory bounding.** The ONNX session is recreated every 512 chunks and a
  no-progress watchdog guards each batch; a per-run memory cap is not enforced.
- **Over-invalidation.** An incremental run after a handful of commits re-embedded far more
  chunks than had changed. Measure invalidation per commit; if windows or node paths shift
  too easily, chunking stability is the fix.
- **Cloud embedding** (Bedrock/Voyage mechanics, bring-your-own-cloud) is explored and
  deferred; the GPU path makes it unnecessary for local use.
- **A shared-index server** (below) would let a team embed once, centrally.

## `ask`

- A `search_repository` tool that re-enters retrieval from inside the loop (circular today).
- Fold scope paths into the indexed ledger text so filenames become keyword-searchable
  (needs a reindex to take effect).
- Answer verbosity on the default model; the system prompt already asks for concision.
- **Open question: should `ask` become a conversation?** Every `ask` is a one-shot. A thread
  (follow-up questions that keep previous turns; a thread in the review panel; a conversation
  the MCP tool can resume) is a smaller step now that synthesis is already a loop, but it
  needs answers first: where a thread lives (derived data belongs in `.git-for-ai/`, not a
  ref); whether an answer is ever an artifact (if so, "promote this answer to an annotation"
  is the honest bridge, not automatic capture); cost and staleness (each turn resends the
  thread, and cited sources age); and what a thread means on three surfaces with three
  lifetimes (CLI process, browser panel, MCP session).

## Capture

- **Sessions that end without a commit are not captured.** Capture fires on `ExitPlanMode`
  and on a Bash call that turns out to be a successful `git commit`; a session abandoned
  before a commit leaves no trace, no entry and no pointer, and its reasoning survives only in
  Claude Code's own transcript until that ages out. Whether an abandoned session is an
  artifact at all is undecided: it enlarges the privacy surface (abandoned sessions are the
  exploratory ones) and would need a session-end hook, unattached records and a new consent
  class. The workaround costs one sentence — ask the agent to write its state to a file
  before stopping — so "won't do" is a legitimate outcome.
- **Capture enrichment.** `capture-session` already parses test commands and outcomes in
  transcript spans; mine `reasoning.tested` (and plausibly `related`) into the auto-captured
  ledger entry instead of leaving those fields annotate-only.
- **A second capture adapter** (Aider or Cursor). The transcript-adapter interface was built
  for this; a second adapter validates it.

## Hardening

- **Publish the npm package.** The CLI is only linkable from a checkout. "git-for-ai" is a
  working name; a published package, installer or app id needs a name chosen with the Git
  trademark policy in mind. Then: version stamping (the MCP server info reads the package
  version), workspace-dependency bundling, a clean-machine install smoke test, and the Node
  engines floor (`node:sqlite` requires ≥ 22.5).
- **Lint.** `pnpm lint` does not run (no ESLint dependency is wired up). Either wire ESLint 9
  through turbo or delete the scripts.
- **Retrieval quality evaluation.** The offline embedder was chosen for the offline-by-default
  promise, not measured quality. Build a small eval set of real questions against this
  repository's known-correct answers; compare quantized vs fp16 vs voyage-code-3.
- **Read performance beyond `report`.** `report` and `/api/overview` batch their git calls;
  `log --intent` and `doctor` still resolve identity per commit, and enrichment /
  `findLaterTouches` remain O(all changes) per call. The measuring stick is explicit
  (ARCHITECTURE §4.1): a read touching N commits should cost O(1) git processes.
- **Change-map 3-way merge.** `sync` keeps the local change-map and exits 2 on divergence;
  the custom driver in ARCHITECTURE §12.2 is not implemented.
- Small debts: an `inputType` knob on the embeddings factory (the query path works around
  it); `reconcile --by-content` fails loudly as unimplemented; legacy-format ledger notes
  migrate only on their next write (a `doctor --fix` mass migration is an option).
- `doctor` counts every line of `capture.log` as a problem, although the log also records
  routine skips and successes; count only failures, or stop logging routine skips.

## Proving it beyond this repository

- **Use it on a real external project.** The tool's claims deserve a codebase that does not
  know about it; expect capture-adapter and scale issues nothing else surfaces.
- **PR integration.** `git for-ai export --format pr-comment | gh pr comment` works today;
  evaluate whether a GitHub Action that posts the effective entry on PR open is worth
  maintaining.

## Surfaces

- **Desktop packaging.** The Electron shell, branch and diff panes, action panel, annotate
  form and guided repair exist ([`DESKTOP.md`](./DESKTOP.md)). Installers are not built,
  and wait on the name.
- **Shared-index server.** The only server this project would need (ref sync is server-free
  through any git remote): run the embedding pipeline once for a team and expose `/ask` and
  `/blame`. Gate: a second machine or second person actually paying the redundant-embedding
  cost. Clients keep the local-index path; the server is an accelerator, never a source of
  truth.

## Larger ideas

- **Semantic drift detector.** Flag when code has drifted from its recorded intent, as a
  `doctor` audit and an attention-inbox item ("this change's intent says X; the code no
  longer does X"). Needs a diff-vs-intent comparison design on top of the existing embedding
  layer; a prompt for a human, never a CI gate.
- **Intent knowledge graph.** Cross-change navigation (supersedes / relates-to /
  was-constrained-by), derived from the ledger once it has months of real entries;
  `reasoning.related` already accumulates the raw edges.

## Standing constraints

Git-native storage only; offline by default with consent-gated APIs; honest degradation
(never fabricate); a hook must never break a commit; reads never mint identity; the review
page serves humans, `--json` and MCP serve agents. Engineering rules for anyone working here:
[`../CLAUDE.md`](../CLAUDE.md).

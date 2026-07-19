# DESKTOP.md — the desktop app: plan and branch/merge groundwork

Written 2026-07-19 at the owner's direction to explore the desktop app next. Two owner
inputs shape this document: (1) a *useful* desktop app must reproduce elements of a git
client, not just wrap the review page; (2) the branching/merging question that raises was
worth answering empirically before designing anything. Naming note: **"git-for-ai" is the
internal/working name only — it will not be the public product name.** Nothing in this doc
depends on the name; the eventual rename is a find/replace plus binary/package naming
decided at publish time (ROADMAP Tier 1 amended accordingly).

## 1. Does the intent layer survive branching and merging? (tested, not assumed)

Empirical results from a scratch repo driven through the real CLI + hooks, 2026-07-19:

**What works today, by design (everything is SHA-anchored, branches are irrelevant to it):**
- Commits on any branch get trailers + change-map entries; identities are branch-agnostic.
- A normal `git merge --no-ff` fires commit-msg/post-commit: the **merge commit gets its own
  change identity**, and every merged-in commit keeps its existing identity. Verified.
- Ledger notes and sessions attach to SHAs — unaffected by which branch a commit is on.
- Rebase-style squashing was always handled (post-rewrite fold, M3).

**Confirmed gaps (the desktop plan must respect these; fixes are scoped below):**
- **G1 — `git merge --squash` produces an *unlinked* squash commit.** No post-rewrite fires,
  so no fold happens: the squash commit mints a fresh change, and the source branch's
  changes remain separate entries whose head commits become **unreachable after the branch
  is deleted** — GC will eventually delete those commits, leaving change-map rows and notes
  pointing at missing objects. Verified end-to-end.
  *Fix (hook-time, clean): during a squash-merge commit, `.git/SQUASH_MSG` exists —
  `internal-hook post-commit` can detect it and fold the source changes into the squash
  commit's change exactly like the post-rewrite path (absorbed/folded_into, sessions
  preserved). Plus a `doctor` audit for change heads that are no longer reachable, with a
  suggested `relink` repair for history already affected.*
- **G2 — the semantic index is single-rev (HEAD of the checked-out branch).** Incremental
  reindex handles branch switches correctly (it diffs old base → new HEAD), but answers from
  `ask` reflect the indexed rev only. Fine solo; the desktop app must *display which rev the
  index reflects* and offer one-click reindex. True multi-rev indexing is explicitly v2.
- **G3 — change-map divergence across machines** still resolves as divergent-kept-local
  (no 3-way driver yet). Irrelevant on one machine; becomes real when the desktop app syncs
  two machines. Stays on the roadmap; the app must surface the divergent state honestly.
- **Design note discovered while testing:** `rev-list --all` includes our own metadata refs'
  internal commits (change-map/sessions ref history). Any "all branches" or graph view MUST
  exclude `refs/git-for-ai/*` and `refs/notes/*`.

**Conclusion: branching and normal merging need no design changes. G1 needs a hook fix
before the desktop app ships anything branch-related, because squash-merge is a common
button in the very git clients this app sits beside.**

## 2. What the app is (and is not)

A **repository intelligence app**: the place a human reviews, interrogates, and maintains
the intent layer across their repos — with enough git-client surface (branches, history,
diffs) that reviewing doesn't require a second tool alongside it.

**Not in v1**: staging, committing, branch creation, merge/rebase *operations*, push/pull of
code branches. Those exist in every git client and IDE the owner already has; reproducing
them buys nothing until the intelligence surfaces prove themselves daily-driver worthy.
(Revisit only if the app becomes the primary tool and the context-switch hurts — that's a
v2+ question the owner answers with usage.)

## 3. v1 feature set

Base layer: **everything the review UI already does** (ask hero with cited answers,
attention inbox, day-grouped timeline, change detail with evidence, session narratives) —
reused, not rebuilt.

New, in priority order:
1. **Repo picker** — a persistent multi-repo list (add by folder), per-repo landing on the
   overview. Uninitialized repos get an "opt in" screen wrapping `init` with the plain
   privacy explanation.
2. **Branch awareness** — sidebar of local branches (current highlighted): selecting one
   scopes the timeline/ask context line to that branch's history (`log --rev` exists;
   `/api/overview` grows a `rev` param). Merge commits render with a "merged N changes"
   affordance listing the absorbed/merged-in changes. Metadata refs filtered per §1.
3. **Diff viewer with intent beside it** — the explicitly-deferred review-UI item, now
   required: per-file unified/side-by-side diff for a commit (new `/api/diff/:sha`),
   rendered next to the change's summary/intent/evidence — the claim-next-to-evidence
   principle extended to the code itself. Syntax highlighting via a bundled highlighter
   (no external requests, as ever).
4. **Actions panel** — the maintenance verbs, GUI-shaped with the same guardrails as the
   CLI: sync (per-ref report, explicit confirm before push), reindex (with the batched
   progress the CLI already emits), doctor (rendered as the attention inbox's "run a
   checkup" source), annotate (a human-friendly form for the deliberate write path), and
   guided repair (relink/reconcile) launched from attention items.
5. **App shell niceties**: OS window/dock presence, per-repo recent list, keyboard
   navigation. Auto-update and installers via electron-builder (Windows first).

## 4. Technical shape

- **Electron wrapping the existing local server + SPA** — the shape the architecture always
  anticipated, made concrete: the main process (plain Node) starts the same server
  `git for-ai review` uses, bound to 127.0.0.1 on a random port, and the renderer loads it.
  One SPA codebase (`packages/review-ui`) serves both browser and desktop; desktop-only
  panes (branches, diff, actions) render when `/api/meta` advertises desktop capabilities.
- **The read-only rule stays, refined**: `git for-ai review` (browser mode) remains
  strictly GET/read-only. The desktop-launched server enables a small set of POST action
  endpoints (`/api/actions/sync|reindex|annotate|relink|reconcile|init`) — each wrapping
  the identical pure `run*` function its CLI command uses, each requiring a per-launch
  token the main process injects (so nothing else on localhost can drive writes).
  REVIEW_UI.md §2 gets amended when this lands, not silently violated.
- **Multi-repo**: server instances per open repo (they're cheap), managed by main.
- `packages/desktop` finally becomes real: main-process code + electron-builder config
  only; it depends on `cli` (server) and `review-ui` (assets), never duplicates logic.

## 5. Build order (each step lands + verifies before the next)

1. **G1 fix**: squash-merge fold in `internal-hook` + doctor's unreachable-heads audit.
   (Core/CLI, no UI; unblocks honest branch UX.)
2. **API groundwork** in the CLI server: `rev` param on overview, `/api/branches`,
   `/api/diff/:sha`, capability flags in `/api/meta`. All still read-only; browser mode
   benefits too.
3. **Review-UI additions**: branch sidebar + diff pane (usable in the browser immediately —
   value ships before Electron exists).
4. **Electron shell**: `packages/desktop` main process, window management, repo picker,
   token-gated action endpoints + actions panel.
5. **Packaging**: electron-builder, Windows installer, then the owner uses it in anger.

## 6. Open questions for the owner (not blockers for steps 1–3)

1. How far should "git client" eventually go — is commit/stage-from-the-app a v2 ambition
   or permanently out?
2. Single window with a repo switcher, or window-per-repo?
3. Product naming — wants deciding before any public artifact (installer name, app id),
   though internals can rename late.

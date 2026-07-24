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
- **G1 — `git merge --squash` produces an *unlinked* squash commit.** ✅ **FIXED
  2026-07-19** (same day, before any desktop code). Two-phase hook fix, because SQUASH_MSG
  exists at commit-msg time but is gone by post-commit (both verified): commit-msg detects
  SQUASH_MSG, injects the *surviving* change's id (oldest squashed commit's change) as the
  trailer, and writes a pending-fold file; post-commit consumes it (stale-guarded by
  trailer match) and folds the other squashed changes via the ordinary §7.4 machinery.
  Verified live: squash + branch delete now yields one continued change with the rest
  absorbed, and `doctor` reports no anomalies. `doctor`'s identity audit also gained the
  unreachable-heads check (flags pre-fix history with a `relink` remediation). See
  internal-hook.ts judgment call #4.
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

**Order amended 2026-07-19 at the owner's explicit direction: the Electron shell shipped
first** (step 4's shell half), so the app exists now; steps 2–3 landed next (2026-07-25),
inside it. What remains: step 4's **token-gated action endpoints + actions panel**, then
step 5 packaging.

1. **G1 fix**: squash-merge fold in `internal-hook` + doctor's unreachable-heads audit.
   (Core/CLI, no UI; unblocks honest branch UX.) ✅ DONE 2026-07-19.
2. **API groundwork** in the CLI server: `rev` param on overview, `/api/branches`,
   `/api/diff/:sha`, capability flags in `/api/meta`. All still read-only; browser mode
   benefits too. ✅ **DONE 2026-07-25.** All four landed, plus `git for-ai report --rev`
   (the same walk, exposed on the CLI where it was equally missing). The two new endpoints
   are backed by `packages/cli/src/commands/reviewGit.ts` — plain git reads, no identity
   minting, so the byte-identical-refs guarantee still holds across the whole surface (the
   review test now sweeps the new endpoints too). Judgment calls recorded in that file's
   header: metadata refs are excluded *structurally* (`refs/heads/` only, not filtered
   after the fact); a merge commit's diff is shown against its first parent WITH an explicit
   warning rather than rendering empty; truncation clips bodies but never the +/- counts;
   an unresolvable `?rev=` is a 400, never a silently empty timeline. REVIEW_UI.md §3 was
   amended, as §4 of this document requires.
3. **Review-UI additions**: branch sidebar + diff pane (usable in the browser immediately —
   value ships before Electron exists). ✅ **DONE 2026-07-25.**
   - **Deviation, recorded not silent**: the branch selector ships as a **chip row** under
     the masthead, not a sidebar. This page is one narrow reading column and most repos
     have a handful of branches; a permanent sidebar would spend the page's scarcest
     resource on a control used once a session. Its contract (a rev in, a rev out) is
     sidebar-ready if the desktop window later grows a multi-pane layout.
   - Branch scope lives in the URL (`#/?rev=<branch>`), so a branch view is reloadable and
     the shell can restore it.
   - G2 is surfaced, not hidden: selecting a branch prints that `ask` still answers from
     the revision the index was built at.
   - The diff pane renders under the change's intent on the change route (files foldable,
     big commits start folded, binary/rename/truncation labeled). **Syntax highlighting is
     deferred** — the one part of §3's item 3 not built; add/delete coloring in mono is
     legible and no bundled highlighter earns its weight yet.
   - Both panes are gated on `/api/meta`'s capability flags, never on host sniffing.
4. **Electron shell**: `packages/desktop` main process, window management, repo picker,
   token-gated action endpoints + actions panel.
   ✅ **Shell half DONE 2026-07-19** (pulled ahead of steps 2–3): `packages/desktop` is a
   real workspace package — Electron main process wrapping `startReviewServer` (the exact
   server `git for-ai review` uses, unchanged), repo picker with recents + native folder
   dialog, uninitialized-repo opt-in screen wired to the pure `runInit`, remembered
   bounds/last-repo, single-instance lock, graceful in-process server shutdown, locked-down
   renderer (contextIsolation on, sandbox on, no preload surface for the SPA). Single
   window v1 — §6 Q2 (window-per-repo) still awaits the owner. The shell now starts its
   server with `mode: "desktop"`, which only changes the capability flags `/api/meta`
   advertises. Token-gated action endpoints + the actions panel remain **OPEN — this is
   the next piece of work**; step 2's API groundwork they depended on is now done.
5. **Packaging**: electron-builder, Windows installer, then the owner uses it in anger.
   (Config checked in at `packages/desktop/electron-builder.yml` with placeholder appId;
   no installer built yet.)

## 6. Open questions for the owner (not blockers for steps 1–3)

1. How far should "git client" eventually go — is commit/stage-from-the-app a v2 ambition
   or permanently out?
2. Single window with a repo switcher, or window-per-repo?
3. Product naming — wants deciding before any public artifact (installer name, app id),
   though internals can rename late.

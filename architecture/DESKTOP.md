# DESKTOP.md — the desktop app

A *useful* desktop app must reproduce elements of a git client, not just wrap the review
page, and that raises the question of how the intent layer behaves across branches and
merges. §1 answers it from tested behavior; the rest describes the app.

## 1. How the intent layer behaves across branching and merging (tested)

**By design (everything is SHA-anchored; branches are irrelevant to it):**
- Commits on any branch get trailers + change-map entries; identities are branch-agnostic.
- A normal `git merge --no-ff` fires commit-msg/post-commit: the **merge commit gets its own
  change identity**, and every merged-in commit keeps its existing identity.
- Ledger notes and sessions attach to SHAs — unaffected by which branch a commit is on.
- Rebase-style squashing is handled by the post-rewrite fold (ARCHITECTURE §7.4).

**Cases the app must respect:**
- **G1 — `git merge --squash`.** No post-rewrite fires, so the squash commit would mint an
  unlinked change. The hooks handle it in two phases, because `SQUASH_MSG` exists at
  commit-msg time but is gone by post-commit: commit-msg detects `SQUASH_MSG`, injects the
  *surviving* change's id (the oldest squashed commit's change) as the trailer, and writes a
  pending-fold file; post-commit consumes it (stale-guarded by trailer match) and folds the
  other squashed changes through the ordinary §7.4 machinery. `doctor`'s identity audit
  includes an unreachable-heads check with a `relink` remediation for history from before
  this handling. See internal-hook.ts judgment call #4.
- **G2 — the semantic index is single-rev** (HEAD of the checked-out branch when `reindex`
  last ran). Incremental reindex handles branch switches correctly (it diffs old base → new
  HEAD), but answers from `ask` reflect the indexed rev only. The app displays which rev the
  index reflects and offers one-click reindex.
- **G3 — change-map divergence across machines** resolves as divergent-kept-local (no
  3-way driver). The app surfaces the divergent state honestly rather than hiding it.
- **Metadata refs are never branches.** `rev-list --all` includes the tool's own refs'
  internal commits (change-map/sessions ref history). Every branch or graph view reads
  `refs/heads/` only.

## 2. What the app is (and is not)

A **repository intelligence app**: the place a human reviews, interrogates, and maintains
the intent layer across their repos — with enough git-client surface (branches, history,
diffs) that reviewing does not require a second tool alongside it.

**Not included**: staging, committing, branch creation, merge/rebase *operations*, push/pull
of code branches. Those exist in every git client and IDE.

## 3. Feature set

Base layer: **everything the review UI does** (ask panel with cited answers, attention
inbox, day-grouped timeline, change detail with evidence and diff, session narratives) —
reused, not rebuilt.

On top of it:
1. **Repo picker** — a persistent multi-repo list (add by folder), per-repo landing on the
   overview. Uninitialized repos get an "opt in" screen wrapping `init` with the plain
   privacy explanation.
2. **Branch awareness** — a chip row under the masthead of local branches (current
   highlighted): selecting one scopes the timeline to that branch's history (`?rev=` on
   `/api/overview`, mirrored in the URL so a branch view is reloadable). G2 is surfaced:
   selecting a branch states that `ask` still answers from the revision the index was built
   at. Metadata refs are excluded per §1.
3. **Diff viewer with intent beside it** — per-file diff for a commit (`/api/diff/:sha`),
   rendered next to the change's summary/intent/evidence: the claim-next-to-evidence
   principle extended to the code itself. No syntax highlighting; add/delete coloring in
   mono, with binary/rename/truncation labeled.
4. **Actions panel and guided repair** — the maintenance verbs, GUI-shaped with the same
   guardrails as the CLI: fetch/send (per-ref report, explicit confirm before push), update
   search (reindex, with the batched progress the CLI emits), and a checkup (`doctor`)
   offered from the attention inbox, where a finding that has a mechanical repair
   (`relink`/`reconcile`) carries the offer and shows the exact command before it runs. The
   annotate form lives on the change route, where the gap is visible.
5. **App shell** — remembered window bounds and last repo, per-repo recent list, standard
   menu, single-instance lock, graceful in-process server shutdown.

## 4. Technical shape

- **Electron wrapping the existing local server + SPA.** The main process (plain Node)
  starts the same server `git for-ai review` uses (`startReviewServer`), bound to 127.0.0.1
  on a random port, and the renderer loads it. One SPA codebase (`packages/review-ui`)
  serves both browser and desktop; desktop-only panes render when `/api/meta` advertises
  the capabilities (`mode: "desktop"`, `actions`).
- **The read-only rule stays, refined.** `git for-ai review` (browser mode) remains strictly
  GET/read-only. The desktop-launched server enables `POST /api/actions/<verb>` for doctor,
  reindex, sync, annotate, relink and reconcile — each a thin argument translation over the
  identical pure `run*` function its CLI command uses, so the GUI cannot drift from the CLI.
  The guards, all tested (`reviewActions.test.ts`):
  - the endpoints do not exist without a launch token (browser mode answers 404; every
    other non-GET is 405);
  - a fresh random token per server launch, generated by the Electron main process and
    handed to its own renderer in the URL *fragment* (never sent to a server, wiped from the
    address bar on read); no endpoint serves it, since `/api/meta` is readable by anything
    on localhost;
  - constant-time comparison, required in a header; a cross-origin `Origin` is refused;
  - one job at a time (409 otherwise): two reindexes would fight over the index and RAM;
  - jobs, not blocking requests: every action returns a job id immediately and streams
    progress lines;
  - pushing needs explicit confirmation in the body, in the same terms the CLI prompt uses.
- **One window, one server.** Switching repos re-points the window and restarts the server.
- `packages/desktop` is main-process code + electron-builder config only; it depends on
  `cli` (server) and `review-ui` (assets) and never duplicates logic. Security posture:
  `contextIsolation` on, `nodeIntegration` off, sandbox on; the served SPA gets no preload
  surface; only the local `file://` picker page sees the `pickFolder`/`openRepo`/`init`
  bridge.

## 5. Layers, in the order they build on each other

1. **Squash-merge fold** in `internal-hook` + doctor's unreachable-heads audit (§1 G1).
   Core/CLI, no UI.
2. **Read-only API groundwork** in the CLI server: `rev` on `/api/overview`,
   `/api/branches`, `/api/diff/:sha`, capability flags in `/api/meta`, plus
   `git for-ai report --rev`. Backed by `packages/cli/src/commands/reviewGit.ts` — plain git
   reads, no identity minting, so the byte-identical-refs guarantee holds across the whole
   surface. Judgment calls in that file's header: metadata refs are excluded structurally
   (`refs/heads/` only); a merge commit's diff is shown against its first parent WITH an
   explicit warning rather than rendering empty; truncation clips bodies but never the +/-
   counts; an unresolvable `?rev=` is a 400, never a silently empty timeline. Browser mode
   benefits too.
3. **Review-UI additions**: branch chip row + diff pane, usable in the browser.
4. **Electron shell** (4a): `packages/desktop` main process, window management, repo picker,
   opt-in screen. **Action endpoints, panel, annotate form and guided repair** (4b): the
   token-gated write path described in §4, the maintenance panel (checkup moved to the
   attention inbox; the panel keeps update-search and fetch/send), the annotate form on the
   change route, and repair offers driven by doctor's structured `repairs`. `relink` asks
   for the commit; only `reconcile` (no arguments) is a single button; after a repair the
   checkup re-runs so the fresh finding list is the evidence.
5. **Packaging**: electron-builder config is checked in (`electron-builder.yml`) with a
   placeholder appId; no installer is built.

## 6. Open questions

1. How far "git client" should eventually go — whether commit/stage-from-the-app is ever
   in scope.
2. Single window with a repo switcher, or window-per-repo.
3. The public name: the installer name and app id bake it in, so packaging waits on it.

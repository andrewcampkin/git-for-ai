# REVIEW_UI.md — `git for-ai review`: the local review web app

The agent-activity review surface. It is served by the CLI, reads through `core`
in-process, and serves one reader: the human reviewing what agents did to their repository.
Agents use the CLI's `--json` output and the MCP tools instead.

## 1. Shape

- **Package `packages/review-ui`** — Vite + React SPA, TypeScript. It builds to static
  assets; it contains NO node/git logic and never imports `core` (it talks only to the JSON
  API below). `packages/desktop` wraps this same build in Electron.
- **CLI command `git for-ai review [--port <n>] [--no-open]`** in `packages/cli` — starts a
  local HTTP server (Node's built-in `node:http`; no server framework) that serves the built
  SPA assets plus a JSON API, then opens the browser.

## 2. Server rules (privacy is the product here)

- **Localhost only.** Bind **127.0.0.1**, never 0.0.0.0. Random free port by default;
  `--port` to pin.
- **Read-only.** Every endpoint is a GET; the server never writes to the repo, and all git
  reads follow the non-minting pattern (log.ts/show.ts) — viewing the UI must leave every
  ref byte-identical (asserted in tests with `git for-each-ref`). The one narrow exception:
  a server launched WITH an action token — only the desktop shell does this — also serves
  `POST /api/actions/<verb>`. `git for-ai review` passes no token, so in browser mode those
  routes do not exist (404); every other non-GET is 405 in both modes. The token is minted
  per launch, delivered to the desktop's own renderer out of band, never served by any
  endpoint, and required in a header. Each action wraps the identical pure `run*` function
  its CLI command uses ([`DESKTOP.md`](./DESKTOP.md) §4).
- **Self-contained.** The SPA makes zero external requests (no CDNs, fonts, telemetry),
  enforced by a test over the built `index.html`.
- **No auth.** Localhost-only, single user.

## 3. JSON API

Thin wrappers over already-tested command logic — the API returns the structured results
those modules produce; no new data assembly in the server:

| Endpoint | Backed by | Returns |
|---|---|---|
| `GET /api/overview?since&until&n&rev` | `runReport`'s `ReportData` | header stats + timeline + per-change details |
| `GET /api/change/:target` | `runShow`'s `ShowData` | one change: identity, full ledger (incl. superseded), session info |
| `GET /api/session/:ref` | show's session read | full span list for the trace viewer |
| `GET /api/meta` | git + config reads | repo name/root, HEAD, capture on/off, index state, `capabilities` (`mode`, `branches`, `diff`, `actions`) |
| `GET /api/branches` | `listBranches` (plain git) | local branches (`refs/heads/` only), current one marked, upstream ahead/behind |
| `GET /api/diff/:sha?context` | `readCommitDiff` (plain git) | one commit's per-file diff: hunks, line numbers, rename/binary/truncation labels |
| `GET /api/ask?q=` | `askQuestion` + the CLI's toolbox | cited answer or ranked sources; `synthesis.consulted` lists the repository reads made |
| `POST /api/actions/<verb>` | the CLI's pure `run*` functions | desktop only (token-gated): doctor, reindex, sync, annotate, relink, reconcile as jobs |

Types for these live in the CLI package next to their commands and are imported as
**types-only** by `review-ui` (erased at build; preserves the no-core-imports rule).

`?rev=` scopes the timeline to a branch but NOT `/api/ask`, whose answers reflect the
revision the index was built at ([`DESKTOP.md`](./DESKTOP.md) §1 G2); the page says so where
a branch is selected. `/api/branches` reads `refs/heads/` exclusively, so the tool's own
metadata refs cannot appear in a branch list. `capabilities` lets one SPA build serve both
the browser and the desktop by asking the server what it offers rather than sniffing the
client.

`/api/ask`'s synthesis may read the repository for itself ([`ASK_TOOLS.md`](./ASK_TOOLS.md)).
It stays a read-only GET — every tool wraps a command this server already serves on a
non-minting read path — and the panel renders what was consulted as one muted line (*"Also
checked: the changes in ce23522"*) in the reader's words. A read that failed says so.

## 4. Functional scope

1. **Timeline** — the `ReportData` timeline, filterable client-side by author kind
   (agent/human/mixed/no-intent), model, and date, grouped by day; each row: sha, when,
   summary (honest degradation labels preserved), author badge, provenance pill when
   noteworthy, conf/risk/undo flags.
2. **Change detail** — route per change: summary as the title, an evidence block (tested +
   session trace link), then intent, constraints, rejected (option + why), scope file list,
   superseded entries (collapsed, labeled). The commit's diff renders beneath the intent,
   gated on `/api/meta`'s `diff` capability: files foldable, big commits start folded,
   binary/rename/truncation labeled, no syntax highlighting. Where the window may write
   (desktop), the change route also carries the annotate form: it opens seeded from the
   current entry, states that saving *adds* a corrected version while the current one stays
   readable, has no author fields (a form submission is recorded as a human's), and refuses
   a half-record with a sentence naming the fix (rules in `lib/annotate.ts`, unit-tested).
3. **Session trace viewer** — spans as a readable narrative list (tool, one-line rendering of
   the key attribute — command/file — timestamp), collapsible raw attributes per span.
4. **Attention inbox** — computed from data already available: changes with
   `origin: inferred`/`orphan-recovery`, no-intent commits, unreadable-note warnings,
   low-confidence (< 0.5) entries, grouped by why they need a person and severity-ordered.
   Where the window may write, the inbox also offers a checkup (`doctor`), lists what it
   found in plain language, and offers the repair for findings that have one — showing the
   exact command before it runs. The offer is driven by the structured `repairs` doctor
   publishes on each check, never by parsing its prose; arguments doctor cannot know (which
   commit is right) are asked for, never guessed; after a repair the checkup re-runs.
5. **Ask panel** — at the top of the page: suggestion chips, citation-linked answers, sources
   folded when prose exists and open when they ARE the answer, honest no-key and
   index-not-ready states.

Visual language: same information design as `report` (it is that page made live); dark/light
via `prefers-color-scheme`. Internals (change-ids, change-map origin/revisions, provenance
enum, full SHAs) live behind closed "Record details" folds.

**Voice.** On-screen text is product language only: plain empty states ("No reasoning
recorded"), plain notices ("Merge commit — showing what it brought in"). It never contains
storage vocabulary (ledger, change-map, spans, "captured intent"), design rationale ("never
inferred or fabricated"), deployment detail (that a read-only local server serves the page),
or what other audiences use instead (`--json`, MCP). Honesty about missing data is
non-negotiable; the explanation of why belongs here and in code comments, not on screen.

**Bounded by default.** `/api/overview` walks the most recent 300 commits unless `?n=` says
otherwise — a page must open promptly on a repo with 50,000 commits. `git for-ai report`,
which is generating a document rather than painting a screen, defaults to all of history.

## 5. Build/packaging

`review-ui` builds via turbo like every package; its `dist/` is resolved by the CLI at
runtime through the workspace dependency (`require.resolve` of the package's exported
manifest). A missing build produces an actionable error ("run pnpm build"), never a blank
page. Tests: server endpoints against real fixture repos over a listening `node:http`
server; UI logic (filtering, labels, annotate rules, citations) as pure-function vitest
tests; the no-external-requests assertion on the built `index.html`.

## 6. Out of scope

Syntax highlighting in the diff pane, any network exposure, live file watching (manual
refresh), and multi-repo switching in the browser (the desktop shell has it).

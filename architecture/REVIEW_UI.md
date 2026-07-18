# REVIEW_UI.md — `git for-ai review`: the local review web app

Spec for the agent-activity review surface approved in
[`PLAN_2026-07-18.md`](./PLAN_2026-07-18.md) §2.2. This is the buildable definition the plan
deliberately deferred. It inherits everything the plan already fixed: review-SPA-before-
Electron, served by the CLI, reading through `core` in-process, and the four functions in
priority order (timeline, change detail, session trace viewer, attention queue) plus a
post-M12 ask panel.

## 1. Shape

- **New package `packages/review-ui`** — Vite + React SPA, TypeScript. It builds to static
  assets; it contains NO node/git logic and never imports `core` (it talks only to the JSON
  API below). This is the UI package MONOREPO_PLAN §3/§6 anticipated the desktop app and
  website would share: `desktop/` later wraps this same build in Electron.
- **New CLI command `git for-ai review [--port <n>] [--no-open]`** in `packages/cli` — starts
  a local HTTP server (Node's built-in `node:http`; no new server framework in the CLI) that
  serves the built SPA assets plus a read-only JSON API, then opens the browser. Fastify
  stays reserved for the future *team* server package; a localhost single-user viewer does
  not justify the dependency.

## 2. Server rules (privacy is the product here)

1. Bind **127.0.0.1 only**, never 0.0.0.0. Random free port by default; `--port` to pin.
2. **Read-only**: every endpoint is a GET; the server never writes to the repo, and all git
   reads follow the established non-minting pattern (log.ts/show.ts) — viewing the UI must
   leave every ref byte-identical (same guarantee `report` proved).
3. **Fully self-contained**: the SPA makes zero external requests (no CDNs, fonts, telemetry);
   enforced the same way report.test.ts asserts no external `src`/`href`.
4. No auth (localhost-only, single user). The future hosted version adds auth *around* this
   same SPA — per PLAN §2.4, the online service is this surface behind auth, not a rewrite.

## 3. JSON API (v1)

Thin wrappers over ALREADY-TESTED command logic — the API returns the structured results
those modules produce today; no new data assembly in the server:

| Endpoint | Backed by | Returns |
|---|---|---|
| `GET /api/overview?since&until&n` | `runReport`'s `ReportData` | header stats + timeline + per-change details |
| `GET /api/change/:target` | `runShow`'s `ShowData` | one change: identity, full ledger (incl. superseded), session info |
| `GET /api/session/:ref` | show's session read | full span list for the trace viewer |
| `GET /api/meta` | git + config reads | repo name/root, HEAD, capture on/off, index state |

Types for these live in the CLI package next to their commands and are imported as
**types-only** by `review-ui` (erased at build; preserves the no-core-imports rule).

## 4. v1 functional scope (maps to PLAN §2.2's priority order)

1. **Timeline** — the `ReportData` timeline, filterable client-side by author kind
   (agent/human/mixed/no-intent), model, and date; each row: sha, when, summary (honest
   degradation labels preserved), author badge, provenance pill, conf/risk/undo flags.
2. **Change detail** — route per change: intent, constraints, rejected (option+why), tested
   evidence, scope file list, superseded entries (collapsed, labeled), session summary line.
   v1 renders the change's *scope + reasoning*; commit diff rendering is explicitly v2 (a
   diff viewer is real surface area; ship the review of *recorded intent* first).
3. **Session trace viewer** — spans as a readable narrative list (tool, one-line rendering of
   the key attribute — command/file — timestamp), collapsible raw attributes per span.
4. **Attention queue** — v1 minimal, computed from data already available: changes with
   `origin: inferred`/`orphan-recovery`, no-intent commits, unreadable-note warnings,
   low-confidence (< 0.5) entries. Grows real `doctor` integration when M14 lands.
5. **Ask panel** — visibly present but disabled with an honest "arrives with M12" note.

Visual language: same information design as `report` (it is that page made live); dark/light
via `prefers-color-scheme`.

## 5. Build/packaging

`review-ui` builds via turbo like every package; its `dist/` is resolved by the CLI at
runtime through the workspace dependency (`require.resolve` of the package's exported
manifest). A missing build produces an actionable error ("run pnpm build"), never a blank
page. Tests: server endpoints against real fixture repos (supertest-style over node:http, or
plain fetch against a listening server); UI logic (filtering, degradation rendering) via
vitest component tests; the no-external-requests assertion on the built index.html.

## 6. Explicitly out of scope for v1

Diff rendering, annotate-from-UI (write path stays CLI/MCP for now), multi-repo switching,
any network exposure, Electron packaging (later, wrapping this unchanged), live file
watching (manual refresh is fine for v1).

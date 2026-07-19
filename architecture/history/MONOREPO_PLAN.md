# git-for-ai — Monorepo & Product Surfaces Plan

Companion to [`ARCHITECTURE.md`](../ARCHITECTURE.md), which specifies the core engine (identity
model, ledger, session capture, embeddings, sync). This document answers a different question:
**what packages does this repo need so a CLI, a desktop app, a hosting/server component, and
(eventually) a website can all be built from the same codebase without duplicating logic** — and
in what order to actually build them.

Nothing in this document should be read as "build all four now." The build order is explicit in
§4, and it's CLI-first, full stop.

---

## 1. Stack recap and why

**TypeScript, Node.js, everywhere** — CLI, desktop, server, and the future website all share one
language. This was an explicit decision (superseding the original Rust-based draft of
`ARCHITECTURE.md` — see its revision note) made because:

- The project owner has no Rust experience, but does have 15 years of current, deep .NET/SQL
  Server/Postgres expertise plus React and Node/jQuery-era background.
- Between the two realistic candidates given that background (.NET vs. TypeScript/Node), TS/Node
  wins for *this specific shape of project* — one person building four cooperating surfaces —
  because it means one language, one package manager, one test runner, and direct code sharing
  between the CLI/server engine and the desktop/website UI (React), rather than a C# backend plus
  a separate JS/React frontend stack to keep in sync.
- It also happens to match the ecosystem most AI coding-agent tooling is already built in (Claude
  Code hooks are shell/JSON-configured and easy to call into from Node; MCP servers are commonly
  TypeScript), which lowers integration friction for the parts of this system that talk to Claude
  Code specifically.
- The trade-off being accepted: this is *not* the strongest fit for the owner's single deepest
  skill (.NET). That's a conscious call favoring "one language across every surface" over
  "strongest language for the hardest single package." If the server component ever needs to be a
  separately-owned, heavier piece of infrastructure, revisiting C#/ASP.NET Core for *just the
  server* remains a reasonable future option (TS clients can talk to any HTTP API regardless of
  what language implements it) — but that's a bridge to cross later, not a decision to make now.

---

## 2. The four surfaces

| Surface | What it is | Status |
|---|---|---|
| **CLI** | `git-for-ai` — the engine from `ARCHITECTURE.md`, exposed as a git subcommand. | **Build first.** Everything else wraps or depends on this working. |
| **Desktop app** | Electron + React shell around the same engine — for people who want `blame --why` and `ask` as a GUI, not a terminal command. | Build *after* the CLI is proven end-to-end on a real repo. Not now. |
| **Server (hosting)** | Self-hostable component, "like hosting a git server" — but see §5, its real job turns out to be narrower and more specific than that framing suggests. | Plan the shape now (this doc); build once multi-machine/multi-user sync or shared indexing is actually needed, not before. |
| **Website** | Future public-facing site, if this becomes an open-source project or product. | **Not built at all right now.** Package slot reserved, nothing else. |

---

## 3. Monorepo layout

**Tooling: [pnpm](https://pnpm.io/) workspaces + [Turborepo](https://turbo.build/repo).** pnpm for
fast, disk-efficient, strict dependency installs (no phantom cross-package imports); Turborepo for
build/test caching and task orchestration once there are several packages with shared build steps.
Both are widely used, well-documented, and low-ceremony for a solo maintainer — no need for
something heavier (Nx) at this scale.

```
git-for-ai/
├── packages/
│   ├── schemas/         # Zod schemas + inferred TS types: LedgerEntry, SessionRecord,
│   │                    # ChangeMapEntry, RepoConfig — the DATA_MODEL.md definitions as code.
│   │                    # Every other package depends on this one; it depends on nothing internal.
│   │
│   ├── core/            # The engine. Git access (execa-wrapped), the identity resolver (§7 of
│   │                    # ARCHITECTURE.md), ledger read/write, session capture + redaction,
│   │                    # the embedding pipeline, the VectorStore interface + sqlite-vec impl.
│   │                    # No CLI parsing, no UI, no HTTP. Depends on: schemas.
│   │
│   ├── cli/             # Thin Commander.js CLI. Parses flags, calls into core, formats output
│   │                    # (including --json). This is the `git-for-ai` npm package.
│   │                    # Depends on: core, schemas.
│   │
│   ├── server/           # (Later.) Fastify API. Two jobs, kept architecturally separate even
│   │                    # though they ship together initially — see §5. Depends on: core, schemas.
│   │
│   ├── desktop/         # (Later.) Electron main process + React renderer. Calls core directly
│   │                    # in-process (Electron's main process is just Node) rather than through
│   │                    # a local HTTP server — no reason to add a network hop on one machine.
│   │                    # Depends on: core, schemas, and shares UI components with website/.
│   │
│   └── website/         # (Not built. Empty placeholder + a one-line README saying so.)
│
├── config/              # Shared tsconfig.base.json, eslint config, prettier config.
├── pnpm-workspace.yaml
├── turbo.json
└── package.json          # root: workspace scripts (build, test, lint) via turbo
```

### 3.1 Why `schemas` is its own package

`DATA_MODEL.md` already defines exact JSON shapes for the ledger entry, session record, and
change-map entry. Implementing those as [Zod](https://zod.dev/) schemas gives runtime validation
*and* inferred TypeScript types from a single source, and putting them in their own package (rather
than inside `core`) means `cli`, `server`, and `desktop` can all import the same types without
depending on `core`'s git/embedding logic — important once `server` and `desktop` exist, since
neither needs to pull in, say, the embedding pipeline just to know what a `LedgerEntry` looks like.

### 3.2 Why `core` never imports a CLI or UI framework

Everything interactive-shell-specific (Commander, `chalk`, prompts) lives in `cli`; everything
Electron/React-specific lives in `desktop`. `core` exposes plain async functions and classes
(`resolveChangeId(sha)`, `writeLedgerEntry(...)`, `query(question)`) that any of `cli`/`server`/
`desktop` can call. This is the one architectural rule most worth protecting as the repo grows —
it's what makes "build the desktop app later" actually mean *wrap*, not *reimplement*.

---

## 4. Build order

1. **`schemas`** — write the Zod schemas from `DATA_MODEL.md`. Small, mechanical, foundational.
2. **`core`** — the hard part: git access wrapper, identity resolver (§7), ledger/session
   read-write, redaction, embedding pipeline, sqlite-vec store. This is where nearly all the
   engineering risk in `ARCHITECTURE.md` actually lives.
3. **`cli`** — thin. Once `core` works, this is mostly flag-parsing and output formatting per
   `CLI_REFERENCE.md`. Build this before anything below — a working CLI is the proof that `core`
   is right, and it's the only surface actually needed to validate the whole idea personally.
4. **`server`** — only once there's an actual reason (a second machine, a second person, or wanting
   the shared-indexing benefit described in §5). Do not build this speculatively.
5. **`desktop`** — only once the CLI has been used enough in anger to know what a GUI should
   actually surface. Wrapping a CLI that doesn't do the right thing yet just means rebuilding the
   GUI later.
6. **`website`** — not now. Revisit only if this becomes a real open-source project or product.

---

## 5. The server: what "hosting this like a git server" actually means

This is worth working through carefully, because the intuitive framing ("host it like a git
server") undersells what's actually needed and oversells what actually needs building.

### 5.1 The part that's *not* special: ref sync

The ledger, session traces, and change-map are all stored as ordinary git refs and notes
(`ARCHITECTURE.md` §8). Nothing about syncing them requires bespoke server software — they're just
refs. Most existing git hosts (GitHub, GitLab, and self-hosted options like Gitea/Forgejo) accept
pushes of arbitrary custom refspecs from a client even though they won't render them in a UI.
Concretely: **`git for-ai sync --push` may already work against a repo's existing GitHub/GitLab
remote today, with zero custom server software**, since it's just `git push origin
refs/notes/git-for-ai/intent:refs/notes/git-for-ai/intent` (and the two other refs) under the hood.

> **VALIDATED 2026-07-18.** Pushed `main` + all three ref namespaces to this repo's real GitHub
> remote; GitHub accepted them, and a fresh clone + one fetch reconstructed the full intent layer
> (`git for-ai show` / `log --intent` worked immediately, zero server-side support). The
> conclusion below is now fact, not hypothesis: **the ref-relay tier is eliminated from the
> server package's scope.** The "hosting" story for sync is documentation only. §5.3's tier 1 is
> retained below solely as a record of what was considered and why it is not being built.

This should be validated early and cheaply — literally push a test note to a scratch GitHub repo
and confirm it round-trips — before assuming a dedicated server is needed at all for basic
multi-machine sync. If it works (likely), the "hosting" component's minimum viable version is
*documentation*, not code: "point `git for-ai sync` at any git remote you already have."

### 5.2 The part that *is* special: shared indexing and query

Here's the insight from the "nothing inherent in git needing a server, but I suspect that won't
hold for our idea" observation, worked through: git's distributed model works because git objects
are small and cheap to recompute locally (that's the whole point of content-addressing). **Our
vector index is neither** — per `ARCHITECTURE.md` §8.2 and §11, it's explicitly local, derived, and
deliberately *not* synced, because it's an expensive-to-compute artifact (an embedding pass over
code + ledger + sessions), not a small content-addressed object.

For a solo user this is fine: one machine, one local index, rebuilt incrementally. For a *team*,
it's genuinely wasteful — every member independently re-running the same embedding pipeline over
the same shared history, each paying the compute (or API) cost separately, each with a
slightly-different-by-timing view of "current." This is the one place where git's own
"no server needed" property doesn't carry over, because the extra thing we're storing (an
embedding index) doesn't have git's cheap-to-recompute-anywhere property.

**So the server's actual differentiated job is: run the embedding pipeline once, centrally, and
expose a query API** (`POST /ask`, `POST /blame`) that a CLI can call instead of maintaining its own
local index. The ledger/session/change-map data underneath stays git-native and still syncs via
plain refs (§5.1) whether or not anyone uses the server's query API — the server is an optional
*accelerator and deduplicator* for the expensive derived layer, not a new source of truth for the
data that's already source-of-truth in git.

### 5.3 What this means for the `server` package's design

Two logically separate responsibilities, worth keeping architecturally distinct even if they ship
in one deployable for simplicity at first:

1. **Ref relay** (~~optional, thin~~ **NOT BEING BUILT** — eliminated by the §5.1 validation,
   2026-07-18): accept/serve pushes and fetches of the three `git-for-ai` refs,
   for teams who'd rather not rely on an existing host allowing custom refspecs, or who want one
   place that's explicitly "the git-for-ai server" rather than overloading an existing git remote.
   Likely implementable by literally running a bare git repo behind git's own smart-HTTP protocol
   (`git-http-backend`-equivalent) rather than inventing a sync protocol — reuse git's transport,
   don't reinvent it, same philosophy as the rest of this project.

2. **Shared index service** (the actual value-add): a Fastify API that owns the embedding pipeline
   server-side and exposes `/ask`, `/blame`, `/reindex` endpoints. This is where a **Postgres +
   [`pgvector`](https://github.com/pgvector/pgvector)** backend makes more sense than sqlite-vec —
   pgvector is mature, handles concurrent multi-user reads/writes properly (sqlite-vec's
   single-writer-ish SQLite model is fine solo, not ideal for a shared service), and — notably —
   plays directly to the owner's strongest, most current database expertise (Postgres), even
   though the *application* code around it is TypeScript. This is a deliberately good fit: the one
   piece of this system that most benefits from a "real database" is also the one piece where the
   owner's Postgres background is most directly useful.

CLI/desktop clients would then have a `core` config option: query the local sqlite-vec index
(default, offline, solo), or point `ask`/`blame` at a configured server URL instead (opt-in, faster
to get organization-wide "current" answers, requires trusting the server with query text). Both
paths produce the same shape of answer, since both sit behind the same query-engine interface in
`core`.

### 5.4 What NOT to build in the server for now

- No user accounts/auth system, no multi-tenant anything — that's product-stage work, not relevant
  until there's a second real user.
- No custom sync protocol — reuse git's transport for ref relay if that piece is even built at all
  (§5.1 says it might not need to be).
- No website/dashboard on top of the server — that's the `website` package's future job, not this
  one's, and `website` isn't being built either.

---

## 6. Per-package tech choices

| Package | Key libraries | Notes |
|---|---|---|
| `schemas` | `zod` | Single source of truth for every record shape; `DATA_MODEL.md` is the spec, this is its code form. |
| `core` | `execa` (shell out to git), `better-sqlite3` + `sqlite-vec` extension, `@xenova/transformers` (local embeddings), plain `fetch` for the Voyage AI opt-in path, `web-tree-sitter` (WASM tree-sitter grammars, no native build step) for chunking | See `ARCHITECTURE.md` §4.1 and §11.3 for the reasoning behind the git and embedding choices specifically. |
| `cli` | `commander`, `chalk` (or `picocolors`), `ora` (spinners for reindex/embedding progress) | Kept deliberately thin — see §3.2. |
| `server` | `fastify`, `pg` + `pgvector` (shared index tier), plain HTTP or `git-http-backend`-equivalent (ref-relay tier) | Two responsibilities per §5.3, one deployable for now. |
| `desktop` | `electron`, `react`, shares a `ui` sub-package of components with `website` once that exists | Calls `core` in-process — no local server needed for a single-machine desktop app. |
| `website` | *(not built)* — would be Next.js/React if/when it happens | Placeholder only. |

**Testing**: [`vitest`](https://vitest.dev/) across every package — fast, native TypeScript
support, one test runner for the whole monorepo.

---

## 7. Distribution (later, not now)

- **CLI**: npm package, `npm install -g git-for-ai`, assumes Node.js is present. A dependency-free
  build via Node's [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
  feature is a plausible v1.1 step for distributing to machines without Node — noted, not needed
  for personal use.
- **Server**: a Docker image (Node app + connects to a Postgres instance, or bundles one via
  `docker-compose` for a single-command self-host), the same shape as self-hosting Gitea/Forgejo.
- **Desktop**: Electron's standard packaged installers (`electron-builder`), once it exists.

---

## 8. What this document is explicitly not saying

- It is **not** saying "start scaffolding these packages today." It's the plan for *when* building
  starts, per the earlier instruction not to write code yet. Scaffolding (`pnpm init`, the
  workspace config, the `schemas` package) is a reasonable literal next step whenever building
  begins, and is small enough to do in one sitting once given the go-ahead.
- It is **not** committing to the server or desktop packages having a fixed feature set — §5 and
  §6 describe direction and technology, not a full spec at `ARCHITECTURE.md`'s level of detail.
  Neither has earned that level of detail yet, per the build-order principle in §4: don't design
  deeply against imagined usage before the CLI has real usage to learn from.

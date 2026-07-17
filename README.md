# git-for-ai

> **Resuming a session?** Read [`HANDOFF.md`](HANDOFF.md) first — it has current status,
> known issues, and next steps, more current than the rest of this README.

An exploration of AI-augmented source control: a system that holds the *intent* behind a change —
especially an AI coding agent's reasoning — alongside the diff-based commits Git already produces.

This repo started as **design-only** and now has a scaffolded monorepo folder structure — real
package manifests and placeholder files for `schemas`/`core`/`cli`, README-only placeholders for
`server`/`desktop`/`website` — but no actual implementation logic yet. Everything here was produced
across two sessions (research + design, then a stack pivot + scaffolding); decisions were made
without stopping to ask where reasonable, per instruction, and are flagged where they're worth a
second look.

## Repository layout

```
git-for-ai/
├── research/        prior-art research (read first)
├── ideas/            six scoped idea docs, MVP vs. roadmap
├── architecture/     the full spec + monorepo/CLI build plans
└── packages/
    ├── schemas/      Zod schemas — scaffolded
    ├── core/         the engine — scaffolded
    ├── cli/          the CLI — scaffolded, build starts here
    ├── server/       placeholder only (no package.json yet)
    ├── desktop/      placeholder only (no package.json yet)
    └── website/      placeholder only (no package.json yet)
```

`schemas`, `core`, and `cli` have real `package.json`s, `tsconfig.json`s, and placeholder source
files (each with a comment pointing at the relevant architecture section) — but declared
dependencies haven't been installed (no `pnpm install` has been run) and no actual logic has been
written. See [`architecture/CLI_PLAN.md`](architecture/CLI_PLAN.md) for the milestone-by-milestone
plan to actually build them.

## Start here

1. **[research/landscape.md](research/landscape.md)** — prior art. Read this first. It names
   direct competitors already working on close-to-this-exact idea (an active multi-vendor RFC
   called **Agent Trace**, plus `git-ai`, `sem`, `drift`, an academic "Lore" paper, and others) —
   this project is not being built in a vacuum, and the architecture spec positions against these
   explicitly rather than ignoring them.
2. **[ideas/00-overview.md](ideas/00-overview.md)** — six standalone idea docs (`ideas/01`–`06`),
   each scoping one facet of the problem, with an explicit MVP-vs-roadmap cut and the reasoning
   behind it.
3. **[architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md)** — the full spec for the
   MVP direction (a synthesis of ideas 01–04). Companion files:
   [DATA_MODEL.md](architecture/DATA_MODEL.md) (exhaustive schemas),
   [CLI_REFERENCE.md](architecture/CLI_REFERENCE.md) (every command), and
   [MONOREPO_PLAN.md](architecture/MONOREPO_PLAN.md) (how the CLI, a future desktop app, a
   hosting/server component, and a future website all fit in one repo).
4. **[architecture/CLI_PLAN.md](architecture/CLI_PLAN.md)** — the detailed, milestone-by-milestone
   plan for actually building `schemas` + `core` + `cli`, the three packages that make up the
   working CLI (everything else in `packages/` is a placeholder for now).

## The one-sentence pitch

Layer a stable-identity change ledger, full AI-agent session capture, and a local semantic/vector
index on top of Git — all as ordinary git notes/refs/objects, nothing forked, fully offline by
default — so you can ask `git for-ai blame --why <file>:<line>` and get an actual answer instead of
a commit SHA and a name.

## Stack: TypeScript / Node.js (revised)

The architecture was originally drafted with Rust. After a design review, the owner flagged having
no Rust experience against deep, current .NET/SQL Server/Postgres expertise plus a React/Node
background — so the implementation language was changed to **TypeScript/Node.js throughout**: CLI,
future desktop app (Electron + React), and future hosting/server component (Fastify, with
Postgres+pgvector for the one piece — a shared team query index — that genuinely benefits from a
real database). The core design (data model, git-native storage, the identity/rewrite-survival
algorithm) didn't change; only the two implementation-specific sections of `ARCHITECTURE.md` did
(git access strategy, embedding provider), and `MONOREPO_PLAN.md` now covers how the CLI sits
alongside the other three surfaces in one repo, in what order to build them (CLI first, always),
and a specific design nuance worth reading: the hosting component's real job turns out to be
narrower than "a git server" — see `MONOREPO_PLAN.md` §5.

## How this session's decisions were made

You answered three questions before stepping away, which fixed the shape of everything else:

- **Goal**: personal tool first, clean enough to open-source later.
- **Architecture**: layer on top of Git, not a clean-slate VCS.
- **Intent source**: primarily AI agent sessions (Claude Code), plus general commit intent, plus
  encoding code as vectors for semantic search.

Everything downstream — storage engine, identity model, embedding provider, privacy defaults — was
decided autonomously to keep the session moving, and is logged explicitly:

- Idea-level trade-offs and why 01–04 were chosen as MVP over 05/06: [ideas/00-overview.md](ideas/00-overview.md).
- Every architecture-level technical decision, with rationale: [architecture/ARCHITECTURE.md §16 "Assumptions and judgment calls"](architecture/ARCHITECTURE.md#16-assumptions-and-judgment-calls)
  (item 15 is the language pivot itself).
- Decisions worth a personal sanity-check when you have time:
  - **Offline-first embeddings by default** (self-hosted, in-process via transformers.js, Voyage AI
    as opt-in) — genuinely lower retrieval quality than an API model, chosen to preserve the "works
    fully offline" goal rather than for being strictly better. Worth revisiting if query quality
    disappoints in practice.
  - **Always shelling out to the real `git` binary** for every git operation, reads included, rather
    than using an in-process library ([architecture §4.1](architecture/ARCHITECTURE.md#41-git-access-strategy-always-shell-out-never-reimplement)) —
    simpler to reason about and guarantees behavioral parity with your actual git, at the cost of
    subprocess overhead on read-heavy commands. Should be fine for an interactive CLI; revisit only
    if a specific command is ever noticeably slow.
  - **The hosting/server component's real job is narrower than "a git server"** — see
    [MONOREPO_PLAN.md §5](architecture/MONOREPO_PLAN.md#5-the-server-what-hosting-this-like-a-git-server-actually-means)
    for the reasoning: plain ref sync may need no custom server at all, and the part that *does*
    need one is a shared team query index (proposed: Postgres + pgvector). Worth confirming this
    framing matches what you had in mind before any server code gets written.

## Process notes

Research was fanned out across four parallel background agents (prior art, code embeddings, AI
agent intent-capture conventions, and git plumbing for sidecar metadata); the architecture spec
was then drafted by a separate Opus-level agent briefed with all eight fixed technical decisions
plus the research and idea docs, so the hardest reasoning (the identity/rewrite-survival algorithm
in particular) got the most capable model. Nothing was built or edited outside this directory.

# Project genesis — how this started (archived from the original README)

Preserved 2026-07-19 when the README was rewritten as a human-focused project page. This is
the origin story and early-decision record, kept verbatim in substance.

## The founding shape (decided before any code)

The project owner answered three questions that fixed everything downstream:

- **Goal**: personal tool first, clean enough to open-source later.
- **Architecture**: layer on top of Git, not a clean-slate VCS.
- **Intent source**: primarily AI agent sessions (Claude Code), plus general commit intent,
  plus encoding code as vectors for semantic search.

Everything else — storage engine, identity model, embedding provider, privacy defaults — was
decided autonomously to keep sessions moving, and logged explicitly:

- Idea-level trade-offs and why ideas 01–04 became the MVP over 05/06: `ideas/00-overview.md`.
- Every architecture-level decision with rationale: `ARCHITECTURE.md` §16 "Assumptions and
  judgment calls" (item 15 is the language pivot).

## The stack pivot (Rust → TypeScript/Node)

The architecture was originally drafted with Rust. After a design review, the owner flagged
having no Rust experience against deep, current .NET/SQL Server/Postgres expertise plus a
React/Node background — so the implementation language changed to **TypeScript/Node.js
throughout**: CLI, future desktop app (Electron + React), and future server (Fastify, with
Postgres+pgvector for the shared team query index). The core design (data model, git-native
storage, identity/rewrite-survival algorithm) didn't change; only the git-access and
embedding-provider sections of `ARCHITECTURE.md` did.

## Decisions flagged for a later sanity-check

- **Offline-first embeddings by default** (in-process transformers.js; Voyage AI opt-in) —
  lower retrieval quality than an API model, chosen to preserve "works fully offline".
  Revisit if query quality disappoints.
- **Always shell out to the real `git` binary**, reads included (`ARCHITECTURE.md` §4.1) —
  behavioral parity over subprocess overhead. Revisit only if a command is noticeably slow.
- **The server's job is narrower than "a git server"** (`MONOREPO_PLAN.md` §5) — validated
  2026-07-18: plain ref sync needs no server at all; only a shared team query index ever will.

## Process notes (research/design phase)

Research fanned out across four parallel background agents (prior art, code embeddings, AI
agent intent-capture conventions, git plumbing for sidecar metadata); the architecture spec
was drafted by a separate Opus-level agent briefed with all fixed decisions plus the research
and idea docs, so the hardest reasoning (the identity/rewrite-survival algorithm) got the most
capable model.

Implementation (from 2026-07-17) continued the pattern: one Fable 5 background agent per
milestone, independently re-verified and committed by an orchestrating session. See
`HANDOFF_2026-07-17.md` and `RESUME_2026-07-18_EOD.md` in this directory for the
session-by-session record — and, fittingly, `git for-ai log --intent` on this repo, which
captured most of it as it happened.

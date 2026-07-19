# git-for-ai

**Source control that remembers *why*.** git-for-ai layers an intent ledger, AI-agent session
capture, and a local semantic index on top of the Git you already use — so six months from now,
you (or your AI agent) can ask *why* a line of code is the way it is and get the actual
reasoning back, not just a commit SHA and a name.

Everything is stored as ordinary git notes, refs, and objects: nothing forked, no sidecar
database of record, no server required. Any git host (GitHub included — validated) stores and
syncs it. Delete the tool and your repo is still a perfectly normal git repo.

## Why

AI coding agents now write a large share of many codebases, and they work *fast* — plans,
rejected alternatives, constraints discovered, tests run — then all of that context evaporates
the moment the session ends, leaving behind a one-line commit message. git-for-ai is built on
two convictions:

1. **Agents should record more than a diff.** The reasoning is cheap to capture at the moment
   it exists and impossible to reconstruct later.
2. **A human must be able to review what their agents did.** Claims belong next to evidence:
   what was the intent, what was rejected and why, what was actually tested, and the captured
   session to back it up.

## What works today

| Command | What it does |
|---|---|
| `git for-ai init` | Opt a repo in: installs git + Claude Code hooks, refs, local config |
| `git for-ai log --intent` | History annotated with each change's intent, author (agent/human), confidence |
| `git for-ai show <sha\|c/id>` | Everything about one change: identity, ledger, reasoning, captured session (`--session`, `--history`) |
| `git for-ai annotate` | Deliberately record intent — the agent write path (JSON stdin) with rejected-alternatives, constraints, tested evidence |
| `git for-ai report` | Self-contained HTML/Markdown digest of agent activity — the human review surface |
| `git for-ai reindex` | Build the local semantic index (tree-sitter chunking + local embeddings; incremental, cached) |
| `git for-ai ask "<question>"` | Semantic Q&A over code + intent + sessions; cited AI-synthesized answers (offline ranked-sources mode without a key) |
| `git for-ai blame --why <file>:<line>` | The founding question: the recorded reasoning behind a line, not just a SHA and a name |
| `git for-ai review` | Local web app (127.0.0.1, read-only): ask box, agent-activity timeline, attention inbox, session traces |
| `git for-ai sync [--push\|--fetch]` | Explicit ref sync through any ordinary git remote — no server needed (validated on GitHub) |
| `git for-ai doctor` | 11 read-only health audits with remediation steps |
| `git for-ai config` / `export` | Config with consent gating; Agent Trace + PR-comment export |
| `git for-ai relink` / `reconcile` | Identity repair tools (misattribution, lost change-map recovery) |
| `git for-ai capture-session` | Hook-invoked: captures agent sessions at commit time (redacted, content-addressed) |
| `git for-ai mcp` | Stdio MCP server: `ask`, `blame_why`, `show`, `log_intent`, `annotate`, `doctor` as native tools for MCP-capable agents |

Under the hood: stable change identity that survives amend/rebase/squash (change-map ref +
Gerrit-style trailer fallback with lazy healing), append-only intent ledger in git notes, and
session traces in a content-addressed ref. This repo dogfoods all of it — run the commands
here and you'll see its own real history, including the sessions that built each feature.

There is also a desktop app: `packages/desktop` wraps the same local review server + SPA in
an Electron shell with a repo picker and one-click init
(`pnpm --filter @git-for-ai/desktop start` — see [`architecture/DESKTOP.md`](architecture/DESKTOP.md)).

**The CLI is feature-complete against its reference.** What comes next — hardening, external
dogfooding, the rest of the desktop app, the shared-index server, and the v2 ideas (semantic
drift detection, intent knowledge graph) — is mapped in
[`architecture/ROADMAP.md`](architecture/ROADMAP.md).

### MCP

Agents shouldn't have to shell out and parse console output — `git for-ai mcp` serves the
intent layer over stdio as native MCP tools (reads plus the schema-validated `annotate` write).
Register it in Claude Code from your repo:

```sh
claude mcp add git-for-ai -- git-for-ai mcp
```

## Quick start

```sh
# from packages/cli, once: npm link   (published package comes later)
cd your-repo
git for-ai init                 # opt in — nothing is captured anywhere else, ever
# ...work normally (Claude Code sessions get captured at commit time)...
git for-ai log --intent         # see history with the "why" attached
git for-ai report               # browsable HTML digest of what your agents did
```

Privacy defaults: everything stays local until you explicitly push the refs; session capture
is per-repo opt-in with built-in redaction; the API-based embedder is disabled without an
explicit consent flag.

## Documentation map

- [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) — the full spec (identity
  model §7 is the heart of it), with [`DATA_MODEL.md`](architecture/DATA_MODEL.md) (every
  record shape) and [`CLI_REFERENCE.md`](architecture/CLI_REFERENCE.md) (every command).
- [`architecture/ROADMAP.md`](architecture/ROADMAP.md) — future features, tiered.
- [`architecture/REVIEW_UI.md`](architecture/REVIEW_UI.md) — the review web app's spec.
- [`CLAUDE.md`](CLAUDE.md) — working context and hard rules for AI agents developing this repo.
- [`architecture/history/`](architecture/history/PROJECT_GENESIS.md) — how this project came to
  be: the original six idea docs, prior-art research, all executed build plans, and session
  handoffs. Useful for archaeology; not needed for new work. The richer version is live in the
  repo itself: `git for-ai log --intent` and `git for-ai ask "..."`.

## Status

Personal tool under active development, built AI-first (nearly every commit here is
agent-authored and self-captured — inspect that claim with `git for-ai show <any sha>`).
Clean enough to open-source when it's ready. TypeScript/Node, Windows-first dev environment,
tested against real git repos only — no mocks of git anywhere.

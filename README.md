# git-for-ai

**Source control that remembers *why*.** git-for-ai layers an intent ledger, AI-agent session
capture, and a local semantic index on top of the Git you already use, so six months from now
you (or your AI agent) can ask *why* a line of code is the way it is and get the actual
reasoning back, not just a commit SHA and a name.

Everything is stored as ordinary git notes, refs, and objects: nothing forked, no sidecar
database of record, no server. Any git host stores and syncs it. Uninstall the tool and your
repo is still a perfectly normal git repo.

## Why

AI coding agents write a large share of many codebases, and they work fast: plans, rejected
alternatives, constraints discovered, tests run. All of that context evaporates the moment the
session ends, leaving behind a one-line commit message. git-for-ai is built on two convictions:

1. **Agents should record more than a diff.** The reasoning is cheap to capture at the moment
   it exists and impossible to reconstruct later.
2. **A human must be able to review what their agents did.** Claims belong next to evidence:
   what was the intent, what was rejected and why, what was actually tested, and the captured
   session to back it up.

## Project status

This project was built privately, almost entirely by AI coding agents directed by one person,
and is published as-is under the MIT licence by [Hurricane Gaming](https://andrewcampkin.github.io/hurricane-gaming/),
alongside the author's other open-source apps. **It is not accepting contributions**: pull
requests and feature requests will be closed. If you want to change something, fork it and
point your own AI agent (Claude Code or whatever you use) at the fork. The repository carries
what an agent needs to work on it in [`CLAUDE.md`](CLAUDE.md), and its own history is captured
with git-for-ai, so `git for-ai ask "..."` on a clone can explain why things are the way they
are.

## What it does

| Command | What it does |
|---|---|
| `git for-ai init` | Opt a repo in: installs git hooks and Claude Code hooks, configures refs and local config |
| `git for-ai log --intent` | History annotated with each change's intent, author (agent/human), and confidence |
| `git for-ai show <sha\|c/id>` | Everything about one change: identity, ledger, reasoning, captured session (`--session`, `--history`) |
| `git for-ai annotate` | Deliberately record intent: rejected alternatives, constraints, tested evidence (flags or JSON stdin) |
| `git for-ai report` | Self-contained HTML or Markdown digest of agent activity |
| `git for-ai review` | Local web app (127.0.0.1, read-only): ask box, agent-activity timeline, attention inbox, session traces, branch scoping, and each commit's diff beside its recorded intent |
| `git for-ai reindex` | Build the local semantic index (tree-sitter chunking, local embeddings; incremental, cached, GPU on Windows) |
| `git for-ai ask "<question>"` | Q&A over code, intent and sessions; cited answers that can read the repository for themselves (ranked sources only, without an API key) |
| `git for-ai blame --why <file>:<line>` | The recorded reasoning behind a line, not just a SHA and a name |
| `git for-ai sync [--push\|--fetch]` | Explicit ref sync through any ordinary git remote, never automatic |
| `git for-ai doctor` | Read-only health audit with remediation steps |
| `git for-ai config` / `export` | Config with consent gating; Agent Trace and PR-comment export |
| `git for-ai relink` / `reconcile` | Identity repair (misattribution, lost change-map recovery) |
| `git for-ai mcp` | Stdio MCP server: `ask`, `blame_why`, `show`, `log_intent`, `annotate`, `doctor` as native tools for MCP-capable agents |

Under the hood: a stable change identity that survives amend, rebase and squash (a change-map
ref with a Gerrit-style trailer fallback and lazy healing), an append-only intent ledger in git
notes, and session traces in a content-addressed ref.

There is also a desktop app: `packages/desktop` wraps the same local review server and SPA in
an Electron shell with a repo picker, one-click init, and a maintenance panel. See
[`packages/desktop/README.md`](packages/desktop/README.md).

## Install

There is no published package yet; install from source.

Install globally, once per machine:

- **git**
- **Node.js 22.5 or later** (`node:sqlite` is used). Any installer or nvm.
- **pnpm 9**, from Node's own corepack: `corepack enable`

Then build the checkout and link the CLI onto your `PATH`:

```sh
git clone https://github.com/andrewcampkin/git-for-ai.git
cd git-for-ai
pnpm install
pnpm build
cd packages/cli && npm link      # writes git-for-ai shims into npm's global bin dir
git for-ai --version             # git finds git-for-ai on PATH and runs it as a subcommand
```

The global bin dir belongs to the active Node version, so after switching Node versions
with nvm run `corepack enable` and `npm link` again; until you do, `git for-ai doctor`
reports the executable as missing and the hooks silently do nothing. Once `git-for-ai` is
on `PATH`, the hooks in every repository you have run `init` in start working, including
Claude Code session capture, so link it when you are ready to capture.

The first `reindex` downloads the embedding model (about 160 MB) into a per-user cache
(`%LOCALAPPDATA%\git-for-ai\models` on Windows; `GIT_FOR_AI_MODEL_CACHE` overrides).

## Quick start

```sh
cd your-repo
git for-ai init                 # opt in; nothing is captured anywhere else, ever
# ...work normally; Claude Code sessions are captured at commit time...
git for-ai log --intent         # history with the "why" attached
git for-ai report               # browsable digest of what your agents did
git for-ai review               # the same, live, in your browser
git for-ai reindex              # build the local index, then:
git for-ai ask "why is X done this way?"
```

Synthesised answers need an Anthropic API key in `GIT_FOR_AI_ANTHROPIC_KEY` (preferred over
`ANTHROPIC_API_KEY`, which Claude Code itself would also pick up). Without a key, `ask` still
returns ranked sources and everything else works offline.

To give an MCP-capable agent the same tools natively, register the server from your repo:

```sh
claude mcp add git-for-ai -- git-for-ai mcp
```

## Privacy defaults

Everything stays local until you explicitly run `git for-ai sync --push`. Session capture is
per-repo opt-in and passes through a fail-closed redaction pass (secret patterns, ignore
globs, size caps) before anything is written. The index never leaves the machine. The
API-based embedder is off unless you explicitly consent.

## Documentation

- **Using git-for-ai in your repo:** [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md), then
  [`architecture/CLI_REFERENCE.md`](architecture/CLI_REFERENCE.md) for every flag and exit code.
- **Rolling it out to a team:** [`docs/TEAM_ADOPTION.md`](docs/TEAM_ADOPTION.md).
- **Working on git-for-ai in your fork:** [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) and
  [`CLAUDE.md`](CLAUDE.md) (the working context for AI agents), with the design in
  [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md),
  [`DATA_MODEL.md`](architecture/DATA_MODEL.md), [`REVIEW_UI.md`](architecture/REVIEW_UI.md),
  [`DESKTOP.md`](architecture/DESKTOP.md), [`ASK_TOOLS.md`](architecture/ASK_TOOLS.md) and
  known gaps in [`ROADMAP.md`](architecture/ROADMAP.md).

## License

[MIT](LICENSE).

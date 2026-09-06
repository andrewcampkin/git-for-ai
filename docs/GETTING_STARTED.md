# Getting started

This guide is for a developer who wants git-for-ai on their own repositories. For every flag
and exit code, see [`../architecture/CLI_REFERENCE.md`](../architecture/CLI_REFERENCE.md).

## What you need

- Node.js 22.5 or later, git, and pnpm 9 (`corepack enable` gives you pnpm from Node).
- Claude Code, if you want agent sessions captured. Everything else works without it.
- Optionally an Anthropic API key for synthesised answers from `ask` and `blame --why`.

## Install from source

```sh
git clone https://github.com/andrewcampkin/git-for-ai.git
cd git-for-ai
corepack enable
pnpm install
pnpm build
cd packages/cli && pnpm link --global
git for-ai --version
```

`pnpm link --global` puts a `git-for-ai` executable on `PATH`; git then runs it as the
subcommand `git for-ai`. The git hooks call the same executable, so if it ever drops off
`PATH` (for example after switching Node versions with nvm) the hooks silently do nothing
and `git for-ai doctor` tells you so.

## Opt a repository in

```sh
cd your-repo
git for-ai init
```

`init` is per repository and idempotent. It:

- installs `commit-msg`, `post-commit` and `post-rewrite` git hooks (appended to any hooks you
  already have, inside marked blocks);
- writes two `PostToolUse` hooks into `.claude/settings.json` so Claude Code reports plans and
  commits to git-for-ai (skip with `--no-claude-hooks`);
- records fetch/push refspecs for the intent refs under the `git-for-ai.refspec` config key,
  without enabling automatic sync;
- creates `.git-for-ai/` (config, index, embedding cache) and excludes it via
  `.git/info/exclude`.

Nothing is captured for any repository you have not run `init` in.

## What happens on each commit

- The `commit-msg` hook injects a `Change-Id: I<32 hex>` trailer. That id is the stable
  identity of the change and survives amend, rebase and squash.
- The `post-commit` hook records the commit under its change id in the change-map ref.
- When the commit was made by a Claude Code session, the Claude Code hook captures the
  session slice since the previous commit (plan, tool calls, model turns), runs it through
  the redaction pass, stores it under `refs/git-for-ai/sessions`, and writes a ledger entry
  in git notes that links to it.
- A hook never fails a commit. Problems are logged to `.git-for-ai/hooks.log` and
  `.git-for-ai/capture.log` and surfaced by `doctor`.

Sessions that end without a commit are not captured.

## Reading the record

```sh
git for-ai log --intent                # one line per commit: change id, summary, author kind
git for-ai show HEAD                   # the effective ledger entry for a commit
git for-ai show HEAD --session         # plus the captured session trace
git for-ai show c/<change-id> --history  # including superseded entries
git for-ai report                      # .git-for-ai/report.html, a self-contained digest
git for-ai review                      # the same in a local web app on 127.0.0.1
```

Missing data is labelled, never invented: a commit made before `init`, or outside an agent
session, shows `no captured intent` or `No reasoning recorded`.

## Recording intent yourself

Capture fills in what a session did. `annotate` is how you or an agent record the reasoning
deliberately, with the vocabulary the ledger understands:

```sh
git for-ai annotate HEAD \
  --summary "Switch session store to signed-cookie tokens" \
  --intent "Run more than one API replica without sticky sessions" \
  --rejected "Redis session store::adds an infra dependency we want to avoid" \
  --tested "pnpm vitest run auth" \
  --confidence 0.8 --scope-risk medium --reversibility easy
```

Agents can pass the same fields as JSON on stdin with `--stdin`. Every annotate appends a
new entry; the previous one stays readable under `--history`.

## Asking questions

```sh
git for-ai reindex                       # build or update the local index
git for-ai ask "why do we shell out to git instead of using a library?"
git for-ai blame --why src/auth/session.ts:73
```

`reindex` chunks code with tree-sitter, embeds it with a local model, and indexes ledger
entries and session summaries into the same space. It is incremental and caches embeddings
by blob hash. On Windows it uses the GPU through DirectML; elsewhere it runs on the CPU
(`GIT_FOR_AI_DEVICE=cpu` forces that anywhere).

With `GIT_FOR_AI_ANTHROPIC_KEY` set, `ask` synthesises an answer with numbered citations and
may read the repository for itself (a commit's diff, a change's record, recent history, a
line's blame); everything it consulted is listed under the answer. Without a key it prints
the ranked sources. `blame --why` needs no index at all.

## Sharing the record

```sh
git for-ai sync --push        # asks for confirmation first
git for-ai sync --fetch
```

`sync` moves exactly three refs (intent notes, sessions, change-map) through an ordinary git
remote. It is never run automatically and never piggybacks on `git push`. Before pushing it
reminds you that session traces may contain code and context from your work; review one with
`git for-ai show <sha> --session` first if you are unsure.

## Configuration

`.git-for-ai/config.toml` is local to the clone and read with `git for-ai config get <key>`
and written with `config set`. The settings you are most likely to touch:

| Key | Default | Meaning |
|---|---|---|
| `capture.enabled` | `true` | Per-repo capture switch |
| `capture.never_capture` | `.env*`, `*.pem`, `*secrets*`, `id_rsa*`, `*.key` | Files whose contents are never recorded, only the fact they were touched |
| `capture.max_span_bytes` | `16384` | Size cap per captured span |
| `redaction.extra_patterns` | `[]` | Extra regexes to redact |
| `embedder.provider` | `jina-v2-code` | Local model. Setting an API provider triggers a consent prompt |

Environment variables: `GIT_FOR_AI_ANTHROPIC_KEY` (synthesis), `GIT_FOR_AI_SYNTHESIS_MODEL`,
`GIT_FOR_AI_DEVICE` and `GIT_FOR_AI_DTYPE` (embedder device and precision),
`GIT_FOR_AI_MODEL_CACHE` (where model weights live), `GIT_FOR_AI_REINDEX_WATCHDOG_MS`.

## Health

```sh
git for-ai doctor
```

Checks hooks, the executable on `PATH`, Claude Code hook wiring, refspecs, config, index
state and fingerprint, identity anomalies, ledger format, session refs and skipped captures.
Every problem comes with the command that fixes it. Exit code 3 means something needs
attention.

## Uninstall

Remove the marked blocks from `.git/hooks/{commit-msg,post-commit,post-rewrite}`, the two
hooks from `.claude/settings.json`, and delete `.git-for-ai/`. The refs stay in the repo as
inert data; delete them with `git update-ref -d` if you want them gone. Commits keep their
`Change-Id` trailers, which are harmless.

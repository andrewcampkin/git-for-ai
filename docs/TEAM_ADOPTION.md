# Using git-for-ai with a team

This guide is for the person who wants their team's agent-written changes to carry their
reasoning, and wants that to happen without asking every teammate to become a tooling
enthusiast. It assumes you have read [`GETTING_STARTED.md`](GETTING_STARTED.md).

## What a team gets

- Every agent-made commit carries its intent, the alternatives it rejected, what it tested,
  and the captured session, all reviewable in `git for-ai review` or a `report` digest.
- Reviewers see the diff beside the recorded reasoning instead of reconstructing it.
- Anyone, including an agent, can ask the repository why something is the way it is and get
  a cited answer.
- The record survives rebases, squashes and amends, because it is keyed to a change id rather
  than a commit SHA.

## What distributes on its own and what does not

`git for-ai init` writes two things into the repository that travel with `git pull`:

- `.claude/settings.json`, which is a tracked file. Once one person commits it, every
  teammate's Claude Code runs the capture hooks in that repository.
- `Change-Id` trailers on commits, which any clone can read.

Three things do not distribute by themselves and need a step per machine:

- **The executable.** Capture happens on the committing machine, so each developer needs
  `git-for-ai` on `PATH` (see the install steps in `GETTING_STARTED.md`).
- **The git hooks and local config.** Each clone needs `git for-ai init` once. It is safe to
  run on a repository that already has the tracked Claude Code hooks.
- **The intent refs.** Notes, sessions and the change-map only move with `git for-ai sync`.

A workable rollout is one person who cares doing the first three steps below, and a team that
does step four when they clone.

1. Run `git for-ai init` in the repository and commit `.claude/settings.json`.
2. Push the intent refs once with `git for-ai sync --push` so the remote has the namespace.
3. Tell the team the two per-machine steps: install the CLI, run `git for-ai init`.
4. Each developer runs `git for-ai sync` when they want to share or see others' reasoning.

## Sync through the remote you already have

The intent data lives in three refs: `refs/notes/git-for-ai/intent`,
`refs/git-for-ai/sessions` and `refs/git-for-ai/change-map`. Any git host stores them.
`sync --fetch` integrates the remote's data into the local refs and `sync --push` sends
local data up. Merging is designed to be conflict-free:

- Ledger notes are append-only JSON lines, merged with git's own `cat_sort_uniq` strategy.
- Session records are content-addressed, so two clones storing the same session store the
  same object and different sessions never collide.
- The change-map fast-forwards when one side is ahead. When two machines have both rewritten
  the same change and diverged, `sync` keeps the local version, says so, and exits with code
  2, leaving a person to resolve it with `relink` or `reconcile`.

Nothing is pushed automatically. `sync --push` asks for confirmation on a terminal and
requires `--yes` in a script.

## What leaves a developer's machine

Be explicit with the team about this before the first push, because session traces are the
sensitive class of data, not code: the code was already on the remote, the transcript was not.

| Data | Where it goes | Contents |
|---|---|---|
| Ledger entries | `refs/notes/git-for-ai/intent` | Summary, reasoning fields, scope (paths and blob ids), author kind, model name, the committer's git email |
| Session traces | `refs/git-for-ai/sessions` | Plan text, tool calls (file paths, shell commands), the model's turns, redacted |
| Change-map | `refs/git-for-ai/change-map` | Change id to commit SHA mappings |
| Index and embeddings | `.git-for-ai/` | Never synced; rebuilt locally with `reindex` |

Before any session trace is written, it passes through a redaction pass: built-in secret
patterns (cloud keys, GitHub and GitLab tokens, private key blocks, JWTs, connection strings,
high-entropy assignments), the `capture.never_capture` globs (contents of matching files are
never recorded, only that they were touched), and a per-span size cap. Redaction is
fail-closed: if it errors, the trace is dropped and the ledger entry says so. Pattern matching
is best effort, so treat the pre-push prompt as a real question and spot-check traces with
`git for-ai show <sha> --session`.

Teams can add their own patterns in `.git-for-ai/config.toml` under `redaction.extra_patterns`
and widen `capture.never_capture`. That file is local to each clone, so put the agreed values
in your onboarding notes.

## Review workflow

- `git for-ai review` opens a read-only local page: an attention inbox of changes that need a
  person (no reasoning recorded, low confidence, inferred identity), a timeline grouped by
  day, and per-change pages with the diff beside the intent, the tests claimed, and the
  session trace.
- `git for-ai report` writes the same information as a self-contained HTML file you can
  attach to a review or a release.
- `git for-ai export --format pr-comment <sha> | gh pr comment <n> --body-file -` puts a
  change's recorded reasoning on a pull request.
- `git for-ai export --format agent-trace` emits the Agent Trace record shape for other tools.

## What the records do not do

The records aggregate by change, repository and time. There is no per-developer dashboard,
and the review page does not rank people. The person whose work is captured is the person you
are asking to install the tool.

## Limitations to set expectations on

- Only Claude Code sessions are captured. Commits from other agents or from humans get a
  change id and can be annotated, but have no session trace.
- A session that ends without a commit is not captured.
- The index reflects one revision (the checked-out branch when `reindex` last ran); the review
  page says so when a different branch is selected.
- Change-map divergence between machines is reported, not auto-merged.
- History rewritten by `cherry-pick`, `filter-branch` or `filter-repo` is recovered from the
  `Change-Id` trailer on the next read. If a rewrite strips commit messages, that identity is
  gone, and `doctor` reports the orphaned entries.

## Health across the team

`git for-ai doctor` on any clone reports whether hooks, the executable, refs and index are in
order, and whether any capture was skipped. Its exit code is 3 when something needs attention,
so it can gate a setup script.

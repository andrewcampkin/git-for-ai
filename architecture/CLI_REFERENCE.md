# git-for-ai — CLI Reference

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md). Exhaustive command reference: every command,
its flags, exit codes, and representative output (including degraded cases). The binary is installed
as `git-for-ai` on `PATH` and invoked as a git subcommand: `git for-ai <command>`.

## Conventions

- **Change/commit refs:** commands accept a commit SHA (short or full), a `c/<change-id>`, a branch,
  or `HEAD`-relative refs, resolved via the change-id resolver (ARCHITECTURE §7.3).
- **Exit codes:** `0` success; `1` user/usage error; `2` degraded-but-answered (e.g. answered from
  commit message because no intent existed); `3` environment problem (`doctor`-detectable);
  `4` capture skipped (internal, hook context). A hook-invoked command **always** exits `0` to the
  agent so it can never block a commit (failures are logged, surfaced later by `doctor`).
- **Offline:** every command works offline except `sync`, and `ask`/`blame` only reach the network
  if the user opted into an API embedding provider.
- **Global flags:** `--json` (machine-readable output on any command), `--repo <path>`, `--quiet`,
  `--no-color`.

---

## `git for-ai init`

Opt-in setup for a repository. Idempotent — safe to re-run.

**Does:** installs git hooks (`post-commit`, `post-rewrite`, `commit-msg`) into the repo's hooks
path (respecting an existing `core.hooksPath`, appending rather than clobbering); writes/merges
`.claude/settings.json` PostToolUse hooks; configures fetch/push refspecs for the three intent refs
(without enabling auto-follow); creates `.git-for-ai/` and adds it to `.git/info/exclude`;
initializes an empty sqlite-vec index; records the chosen embedder.

**Flags:** `--embedder <id>` (default `jina-v2-code`), `--hooks-path <dir>`, `--no-claude-hooks`
(git-side only), `--force` (overwrite existing managed hook blocks).

```console
$ git for-ai init
✓ git hooks installed (post-commit, post-rewrite, commit-msg)
✓ Claude Code hooks written to .claude/settings.json
✓ refspecs configured for refs/notes/git-for-ai/*, refs/git-for-ai/*  (manual sync only)
✓ .git-for-ai/ created and excluded; sqlite-vec index initialized (empty)
  Embedder: jina-embeddings-v2-code (self-hosted, offline).
  Capture is ON for this repo. Data stays local until `git for-ai sync --push`.
```

---

## `git for-ai capture-session` (internal, hook-invoked)

Not for direct human use. Invoked by the Claude Code PostToolUse hooks with the hook payload on
stdin. Reads `session_id` + `transcript_path`, extracts the relevant slice, runs the redaction pass,
writes the session trace and enriches/creates the ledger entry.

**Flags:** `--event <plan|maybe-commit>`. `plan` buffers the plan span; `maybe-commit` self-filters
to successful `git commit` invocations and does the full capture. Always exits `0`.

```console
# (invoked by hook; representative log line)
[git-for-ai] captured session b1e2c3d4 -> commit b7c3e2a1 (change 9f2c1a7b), 4 spans, 3 redactions
```

---

## `git for-ai log --intent [<path>]`

`git log` annotated with the effective one-line intent summary per commit.

**Flags:** `--intent` (the annotation; implied by this subcommand), `-n <N>`, `--since/--until`,
`--change` (show change-id instead of SHA), `<path>` to scope to a file/dir.

```console
$ git for-ai log --intent src/auth/
b7c3e2a  9f2c1a7b  Switch session store to signed-cookie tokens        [agent, conf 0.82]
3d1f0a2  3d1f0a2b  Add rate limiting to /login                         [agent, conf 0.74]
a0f1c2d  —         Initial auth scaffolding                            [no intent: pre-git-for-ai]
```

---

## `git for-ai blame --why <file>:<line>`

Resolve a line to its owning change(s) and synthesize a why-answer from the ledger + linked session
+ related-change chain.

**Flags:** `--depth <N>` (how far back the related-change chain follows), `--session` (include the
session trace excerpt), `--json`.

```console
$ git for-ai blame --why src/auth/session.rs:73
src/auth/session.rs:73  change 9f2c1a7b  (agent-captured, confidence 0.82)
WHY: Session state moved from an in-process map to signed-cookie tokens so the API can run more
     than one replica without sticky sessions.
CONSIDERED & REJECTED: a Redis session store — rejected to avoid a new infra dependency.
SESSION: claude-code, 2026-07-17  (git for-ai show 9f2c1a7b --session)
LATER TOUCHED BY: c/7a2b (2026-07-19, "add token rotation").
```

Degraded case (no captured intent):

```console
$ git for-ai blame --why src/legacy/parser.c:210
src/legacy/parser.c:210  commit a0f1c2d  (no captured intent — pre-git-for-ai history)
No ledger entry or session exists for this line. Here is what git knows:
  commit a0f1c2d  "Initial parser import"  by jsmith  2024-02-11
Answer confidence: none — this is git metadata only, not synthesized intent.   [exit 2]
```

---

## `git for-ai ask "<question>"`

RAG query over the vector index for questions not anchored to a line. Hybrid keyword + vector
retrieval; every answer lists its sources and a confidence. The most recent changes' effective
ledger entries always ride along as additional sources (the *recency floor*, read from git
directly — immune to index staleness), so temporal questions ("what changed recently and why?")
are answerable even though embedding similarity has no concept of time.

**Flags:** `--k <N>` (retrieval breadth), `--sources-only` (skip synthesis, just show hits),
`--since/--until`, `--json`.

```console
$ git for-ai ask "why don't we use redis for sessions"
Answer (from 1 ledger entry, 1 session summary):
  Redis was explicitly rejected in change 9f2c1a7b (2026-07-17) to avoid a new infrastructure
  dependency; stateless signed-cookie tokens were chosen to allow multi-replica deploys.
Sources:
  [1] ledger 9f2c1a7b  src/auth/session.rs:40-118  (agent-captured)
  [2] session sha256:1f4e9c  claude-code 2026-07-17
Confidence: high (direct match on an explicit rejected-alternative).
```

---

## `git for-ai sync [--push | --fetch] [<remote>]`

Explicit, manual push/fetch of the three intent refs. Never automatic, never piggybacked on
`git push`. The vector index is never synced.

**Flags:** `--push`, `--fetch` (default: both, fetch then push), `<remote>` (default `origin`),
`--dry-run`. Before a push, prints a reminder that session data is about to leave the machine and
points at `git for-ai show --session` to review.

```console
$ git for-ai sync --push origin
About to push session data to origin. Session traces may contain code/context from your work.
  refs/notes/git-for-ai/intent      (12 entries)
  refs/git-for-ai/sessions/*        (5 traces, redacted)
  refs/git-for-ai/change-map        (12 changes)
Continue? [y/N] y
✓ pushed 3 refs to origin
```

---

## `git for-ai reindex [--full]`

Rebuild the local vector cache from git-native source of truth (notes/sessions/refs + working-tree
code). Used after index corruption, an embedder change, or a fresh clone.

**Flags:** `--full` (drop and re-embed everything; required after a `model_fingerprint` change),
`--since <commit>` (partial), `--verify` (check index against `state.json` without rebuilding).

**Device/precision (GPU):** the local embedder resolves a device and weight precision before
loading anything — DirectML + fp16 on Windows, CPU + int8 elsewhere. `GIT_FOR_AI_DEVICE=dml|cpu|auto`
and `GIT_FOR_AI_DTYPE=fp16|fp32|q8` override. The effective precision is part of the fingerprint
(`jina-v2-code/768/fp16`; the bare `jina-v2-code/768` form means legacy int8), so switching device
class requires `reindex --full` — the CLI tells you when it does. The resolved device and the
reason are printed on stderr at the start of every run; a GPU load failure is a hard error naming
`GIT_FOR_AI_DEVICE=cpu`, never a silent CPU fallback. `GIT_FOR_AI_REINDEX_WATCHDOG_MS` tunes the
no-progress watchdog (default 15 min per embedding batch; 0 disables).

```console
$ git for-ai reindex --full
Embedder jina-v2-code/768/fp16. Re-embedding from scratch.
  code chunks:      1284  (312 reused from embcache, 972 embedded)
  ledger entries:     12
  session summaries:   5
✓ index rebuilt at .git-for-ai/index.db  (last_indexed_commit b7c3e2a1)
```

---

## `git for-ai doctor`

Single pane of glass for health. Checks hook installation, `.claude/settings.json` wiring, refspec
config, index schema/fingerprint, embedder reachability, orphaned/trailer-recovered intent, and
skipped captures. Prints concrete remediation. Exit `0` healthy, `3` if problems found.

```console
$ git for-ai doctor
git-for-ai doctor
  hooks .......... ✓ post-commit, post-rewrite, commit-msg installed
  claude hooks ... ✓ ExitPlanMode + Bash/git-commit wired
  refspecs ....... ✓ configured (manual sync)
  index .......... ✓ schema 1, fingerprint jina-v2-code/768, 1284 chunks, current
  embedder ....... ✓ jina-v2-code reachable (local)
  identity ....... ⚠ 2 commits recovered via trailer (cherry-pick suspected)
                     run `git for-ai reconcile` to heal the change-map eagerly
  orphaned ....... ✓ none
  captures ....... ⚠ 1 session skipped (redaction fail-closed) on commit 4c5d6e7
                     run `git for-ai show 4c5d6e7 --session` — none was stored
Overall: 2 warnings, 0 errors.   [exit 3]
```

---

## Supporting commands

### `git for-ai show <commit|c/change-id> [--session] [--history]`

Dump the effective ledger entry for a change; `--session` includes the linked session trace;
`--history` shows superseded (appended-over) entries.

### `git for-ai reconcile [--rebuild-map] [--by-content]`

Eagerly heal the change-map after operations the hooks didn't observe. Default walks recent history
and adopts trailer-recovered SHAs into the map. `--rebuild-map` reconstructs the entire map from
`Change-Id` trailers (recovery path if the ref was lost — rich predecessor history is not
recoverable this way). `--by-content` attempts best-effort re-link of orphaned intent to commits via
tree/patch similarity (the filter-repo-stripped-message case, ARCHITECTURE §7.5).

```console
$ git for-ai reconcile
Scanning last 200 commits for trailer-recovered identity...
  healed 2 commits into change-map (cherry-picked from feature/tokens)
✓ change-map converged.
```

### `git for-ai relink <change-id> <commit>`

Manually re-point a change-id to a different commit — the escape hatch for the split (1→N) case
where the semantically-primary piece landed in a later commit than the default inheritance chose
(ARCHITECTURE §7.4).

### `git for-ai export --format agent-trace [--out <path>]`

Emit ledger entries in Agent Trace's wire format for interop with external Agent-Trace-aware tooling
(ARCHITECTURE §3.1). Lossy in one direction (our session_ref/change-map richness has no Agent Trace
equivalent) but a faithful export of the file/line-range/revision→reasoning core.

### `git for-ai config <get|set> <key> [value]`

Read/write `.git-for-ai/config.toml`. Setting `embedder.provider` to an API provider (e.g.
`voyage-code-3`) triggers the one-time consent prompt and records `voyage_consent = true`.

```console
$ git for-ai config set embedder.provider voyage-code-3
voyage-code-3 is an API provider: enabling it sends code to Voyage AI for embedding.
This turns off offline-by-default for indexing. Type 'i accept' to continue: i accept
✓ embedder set to voyage-code-3 (dim 1024). Run `git for-ai reindex --full` to re-embed.
```

---

## Command-to-idea map

| Command | Primary idea served |
|---|---|
| `init`, `doctor`, `config` | Cross-cutting (all) |
| `capture-session` | 02 (Agent Session Ledger) |
| `blame --why`, `ask`, `log --intent`, `show` | 04 (Conversational Blame / Repo Q&A) |
| `reindex` | 03 (Vector-Indexed Repository Brain) |
| `sync` | 01+02 (git-native sync of ledger/sessions/map) |
| `reconcile`, `relink` | 01 (identity / rewrite survival) |
| `export` | 01 (Agent Trace interop) |
| `check-drift` *(v2)* | 06 (roadmap) |

---

*End of CLI_REFERENCE.md. Back to [`ARCHITECTURE.md`](./ARCHITECTURE.md).*

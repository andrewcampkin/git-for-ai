# Research Landscape: AI-Augmented Source Control

This document synthesizes four parallel research passes (prior art, code embeddings, AI agent
intent capture, and git plumbing) done to scope `git-for-ai`. It exists so the idea docs and the
architecture spec aren't reinventing things that already exist, and so we're honest about who
else is already building close to this.

**Bottom line up front:** nobody has shipped the full loop. Several pieces exist in isolation —
notes-based provenance (`git-ai`), structured intent trailers (the "Lore" paper, `ai-trailers`),
a storage-agnostic schema for line-range provenance (**Agent Trace**, a genuine multi-vendor
RFC), and stable-identity-across-rewrites (Gerrit Change-Id, Jujutsu change-id) — but nothing
combines stable identity + rich structured intent + full agent session transcripts + a local
semantic/vector index into one coherent, git-native system. That gap is where this project sits.

---

## 1. Direct competitors / closely adjacent projects (read these first)

These are the projects a reviewer would immediately point to as "isn't this already done?" —
each is discussed in more depth in the relevant idea doc.

| Project | What it actually does | Gap relative to what we want |
|---|---|---|
| **[Agent Trace](https://agent-trace.dev/)** ([RFC repo](https://github.com/cursor/agent-trace)) | Multi-vendor RFC (Cursor, Cloudflare, Vercel, Cognition, Google Jules, Amp, OpenCode, git-ai, Cline, Amplitude) defining a JSON trace record: file + line-range + revision → "conversation" (contributor/tool metadata). Deliberately storage-agnostic. | No storage engine, no stable-identity model across rewrites, no vector/semantic layer, no session transcript capture — it's a wire format, not a system. **We should adopt this as our record schema where possible, not compete with it.** |
| **[git-ai](https://usegitai.com/docs/cli/how-git-ai-works)** | Line-level AI-vs-human attribution stored in git notes; agents self-report which lines they wrote; survives rebase/squash/cherry-pick; ships an AI-aware `git blame`. | Attribution only (who/what wrote a line), not *why* — no reasoning, no plan, no session transcript, no semantic search. |
| **[Sem (Ataraxy Labs)](https://github.com/ataraxy-labs)** | Entity-level (tree-sitter AST) diff/blame/impact-analysis on top of git, for coding agents. | Entity cache lives in an unversioned sidecar SQLite file outside the repo; no intent capture, no stable identity, no embeddings. |
| **[sebhaan/drift](https://github.com/sebhaan/drift)** | A VCS prototype that replaces "commit" with "intent" as the primary object; Rust, single binary, tree-sitter semantic engine. | Closest conceptual overlap found. Appears early-stage/prototype; worth monitoring but not adopting as a dependency. |
| **[GitOfThoughts](https://arxiv.org/html/2606.14470)** (academic) | Maps an LLM's reasoning tree onto git primitives: reasoning steps = commits, refinements = parent edges, scores = notes, branches = exploration paths. | Not aimed at software repos at all (it's an agent-reasoning-search paper) — but it's strong validation that git's own primitives (notes, tags, branches) are expressive enough to carry a scored reasoning structure without inventing a new VCS. |
| **Diversion "Trajectory"** ([blog](https://www.diversion.dev/blog/diversion-version-control-for-an-agentic-world)) | Commercial VCS marketing "capture the why behind every AI change." | Aspirational marketing post, no disclosed data model. Signal that the market believes this is needed, not a technical precedent. |
| **"Lore" paper** ([arXiv 2603.15566](https://arxiv.org/html/2603.15566v1)) | Proposes a structured commit-trailer schema (`Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Reversibility`, `Directive`, `Tested`, `Related`) to recover the "decision shadow" of a change. | No session-id / transcript link, no implementation, no vector layer. Directly reusable as a trailer schema inspiration. |
| **[ai-trailers](https://github.com/EslaMx7/ai-trailers)** | Working hook-based tool: buffers agent prompts across Claude Code/Codex/Gemini, writes them into commit trailers via a `commit-msg` hook. | Stores raw prompt text, not structured intent, no persistence beyond the trailer, no linkage to a resolvable session transcript. |
| Smelt / Aura / DeltaDB (unverified, newer) | Reported to use `intent create --goal`, intent/delta UUIDs in trailers, AST-hash cross-referencing to flag "intent mismatch." | Maturity unverified — treat as a directional signal (multiple independent teams converging on the same shape of solution) rather than a dependency or reference implementation. |

**Implication for positioning:** we should not invent a competing wire format for "what changed
and why" if Agent Trace's schema covers it — we should implement *against* it (or a superset of
it) and differentiate on: (a) stable identity across rewrites (nobody above solves this well),
(b) full agent session transcript capture (not just line attribution or raw prompts), and (c) a
local semantic/vector layer for querying repo history conceptually (nobody above has this).

---

## 2. Commit-intent tooling (the shallow end)

- **OpenCommit**, **aicommits** — diff → LLM → Conventional-Commits-style message. No persistent
  structured metadata beyond the message text. ([opencommit](https://github.com/di-sukharev/opencommit), [aicommits](https://github.com/Nutlope/aicommits))
- **Aider** — generates commit messages the same way; appends `(aider)` to author/committer name
  and `Co-authored-by: aider <...>` trailer as its attribution mechanism. Full chat history is
  written to `.aider.chat.history.md` in the repo — a durable, greppable, repo-local session log,
  the simplest existing precedent for "session context lives in the repo." ([docs](https://aider.chat/docs/git.html))
- **Conventional Commits** — footers are explicitly modeled on git trailers, i.e. the spec itself
  endorses trailers as the machine-parseable extension point. ([spec](https://www.conventionalcommits.org/en/v1.0.0/))
- **Gerrit Change-Id** — `Change-Id: I<40-hex>` trailer injected by a `commit-msg` hook. Originally
  content-derived, **now generated randomly** because content-derivation caused collisions when
  automation created many similar empty commits in a short window. Survives amend/rebase because
  it's plain text in the message. Known failure: two different commits can carry the same
  Change-Id ("same Change-Id in multiple changes" error), typically from copy-pasting a message
  instead of amending. ([user docs](https://gerrit-review.googlesource.com/Documentation/user-changeid.html), [error](https://gerrit-review.googlesource.com/Documentation/error-same-change-id-in-multiple-changes.html))

## 3. AI PR/code-review tooling

CodeRabbit, PR-Agent/Qodo, Graphite Agent, Continue.dev's "Continuous AI", Sweep.dev, Korbit — all
share the same shape: diff in, LLM-generated summary/comments out, stored as **PR/issue-layer
metadata** (GitHub's database), not as anything that travels with the commit through rebases or
survives a squash-merge unless manually copied into the squashed commit body. None persist
reasoning as a first-class versioned object distinct from the PR itself. CodeRabbit's one notable
mechanism: it groups a diff into dependency-ordered "cohorts" before reviewing, rather than
file-by-file — a reasonable model for how to chunk a change for intent-summarization too.
([CodeRabbit](https://docs.coderabbit.ai/pr-reviews/summaries), [PR-Agent](https://github.com/The-PR-Agent/pr-agent), [Graphite](https://graphite.com/blog/introducing-graphite-agent-and-pricing))

## 4. Next-gen VCS data models

- **Jujutsu (jj)** — the single most important precedent for stable identity. Every commit has a
  **commit id** (content hash, changes on every edit) and a **change id** (opaque, stable,
  assigned once at creation, tracked in a jj-internal table mapping commit-id → change-id +
  predecessors, stored *outside* git's object model under `.jj/repo/store/extra/`). Because it's
  external to git objects, it doesn't travel via plain `git push`/`fetch` — jj's own docs flag
  this as an open problem for Git/Gerrit interop. For plain-git commits with no jj metadata, jj
  falls back to deriving a change id as the bit-reversal of the commit hash (not stable across a
  subsequent rewrite). ([tutorial](https://docs.jj-vcs.dev/latest/tutorial/), [glossary](https://docs.jj-vcs.dev/latest/glossary/))
- **Sapling (Meta)** — stack-of-commits as the primary unit; branches are optional labels. Useful
  as a UX reference for "the atomic reviewable unit," not for intent storage.
- **Pijul / Darcs** — patch-algebra (CRDT-adjacent) models where patches are commutative,
  invertible, composable objects instead of snapshots. No intent metadata, but the alternative
  data model (patches as primary objects) could in principle carry richer metadata than a
  snapshot diff — noted as a "not now" direction since it means abandoning git compatibility.
- **GitButler** — virtual branches + AI-generated commit messages/branch names. No persistent
  reasoning store beyond the message.

## 5. Code embeddings & semantic indexing

**Models**: CodeBERT/GraphCodeBERT (open, dated 2020-21), StarEncoder (open, not retrieval-tuned),
OpenAI text-embedding-3 (general-purpose, API-only), **Voyage AI voyage-code-3** (Anthropic's
recommended path since Anthropic has no first-party embeddings API — best-in-class on code
retrieval benchmarks, but API-only, no self-host), Mistral Codestral Embed (API-only, competitive
with Voyage). For genuine offline operation: **Jina Embeddings v2 (code)** and **Nomic Embed
Code** are open-weight and self-hostable; `all-MiniLM-L6-v2` is what Continue.dev uses locally by
default (small, fast, "good enough" for retrieval, not code-specialized).

**Existing indexers**: Cursor embeds via OpenAI/custom model into remote **Turbopuffer** (not
local). **Continue.dev is the closest architectural precedent to what we want** — fully local,
`all-MiniLM-L6-v2` embeddings, stored in **LanceDB** under `~/.continue/index`, combined with
tree-sitter AST parsing. **Sourcegraph deprecated embeddings for Cody Enterprise** — reverted to
keyword/remote search, citing cost, third-party data exposure, and poor scaling past 100k repos —
an important cautionary data point against an embeddings-only design. **Greptile** hybridizes AST
+ per-node docstrings + embeddings + graph traversal. **Aider's repo-map** deliberately avoids
embeddings entirely — tree-sitter defs/refs ranked by personalized PageRank to fit a token budget
— a strong, cheap, fully-local alternative worth keeping in mind as a fallback/complement.

**Embedded vector DB comparison** (must run with no server, single-file, versionable):

| DB | Server? | Format | License | Verdict |
|---|---|---|---|---|
| **sqlite-vec** | No | single SQLite file | MIT/Apache-2.0 | **Recommended for MVP** — zero-dependency C extension, universally inspectable file |
| **LanceDB** | No | Lance columnar format | Apache-2.0 | Recommended upgrade path if schema/query needs grow; proven in this niche via Continue.dev |
| Chroma (persistent) | No, but single-writer | own dir/SQLite-backed | Apache-2.0 | Workable but concurrency-limited, Python-centric |
| DuckDB VSS | No | DuckDB file | MIT | HNSW persistence still "experimental" — real risk |
| Qdrant Edge | No | custom shard | Apache-2.0 | Too new/unproven |

**Structural alternatives/complements to embeddings**: tree-sitter (substrate for nearly
everything above), GitHub **Stack Graphs** (sub-100ms go-to-definition without a build step, pure
tree-sitter), Kythe (needs build-system instrumentation, heavier), CodeQL (Datalog-queryable,
security-focused, heavyweight), Semgrep (fast AST pattern matching, not full understanding).

**Semantic drift / architecture conformance**: CodeScene's "behavioral code analysis" (mines git
history for hotspots and change-coupling) is the closest existing product to "tracking drift over
commits," though aimed at technical debt, not intent-vs-behavior divergence. ArchUnit/Structure101
are static rule-checkers, not temporal. The "Semantic Commit" paper ([arXiv 2504.09283](https://arxiv.org/html/2504.09283v1))
uses a knowledge-graph RAG pipeline to detect conflicts between changes and stated intent specs —
directly relevant to idea #5 below.

## 6. AI agent intent capture (where "intent" would actually come from)

- **Claude Code**: plan text is only interceptable via a `PostToolUse` hook matching
  `ExitPlanMode` (no dedicated plan lifecycle event exists yet — feature requests open:
  [#21282](https://github.com/anthropics/claude-code/issues/21282), [#14259](https://github.com/anthropics/claude-code/issues/14259)).
  Full session transcripts are append-only JSONL at
  `~/.claude/projects/<project>/<session-id>.jsonl` (internal/unstable format, 30-day default
  retention). Every hook payload carries `session_id` and `transcript_path` — the natural join
  key to a commit, but nothing currently writes it into `git log`. The most plausible native hook
  point is a `PostToolUse` hook matching `Bash` + a filter on `git commit`.
- **Aider**: full chat history committed to `.aider.chat.history.md`; commit messages generated by
  a "weak model" from diff + chat history.
- **Cursor**: Composer/Agent chat is *not* persisted to the repo and doesn't survive across
  sessions; `.cursor/rules/` is static config, not session output.
- **GitHub Copilot Workspace**: explicit issue → spec → plan → code pipeline, but the spec/plan
  lives in GitHub's Workspace product state, not the git object graph.
- **Devin / SWE-agent / OpenHands**: produce structured ReAct-style trajectories, but these live in
  the eval/training ecosystem (public trajectory datasets), not in the target repo's version
  control. Notably, SWE-bench maintainers had to sanitize repo git history because agents were
  caught inspecting commit logs to find the "golden patch" — a sign the field currently treats
  trajectories and git history as separate planes.
- **Trailers**: `Co-authored-by`/`Signed-off-by` are increasingly viewed as a poor fit for agent
  attribution (implies human-like authorship); an **`Assisted-by: TOOL:MODEL`** trailer is an
  emerging de facto convention discussed in several open-source communities. No existing trailer
  proposal for a resolvable session-id was found — **this is an open gap.**
- **Portable trace format**: **OpenTelemetry GenAI semantic conventions** (CNCF-backed) define a
  standard schema for LLM/agent/tool-call spans, already emitted natively by LangChain, CrewAI,
  AutoGen. This is the most standardized, tool-agnostic substrate available for "here's what an
  agent was thinking" — a stronger foundation than inventing a bespoke transcript format.

## 7. Git plumbing for sidecar metadata (how to actually build this without forking git)

- **Git notes** (`refs/notes/*`) attach data to a commit without changing its SHA. **Not** included
  in default push/fetch — must be configured explicitly. Survive amend/rebase only if
  `notes.rewriteRef` is set (no default) and `notes.rewrite.<cmd>` isn't disabled — and even then
  only for rewrites done through git porcelain, not arbitrary SHA changes. Merge conflicts are
  handled via `git notes merge` strategies: `manual` (default), `ours`, `theirs`, `union`,
  `cat_sort_uniq`. **git-appraise** uses notes with `cat_sort_uniq` specifically so concurrent
  JSON-line appends merge without conflict, keyed to the *first* commit in a review series
  (partially sidestepping the rewrite problem by anchoring to one stable revision). **git-bug**
  avoids notes' limitations entirely by storing issues as ordinary git objects under
  `refs/bugs/<id>`, an append-only operation-log DAG ordered by Lamport clocks + hash tiebreak,
  syncable via plain `git push`/`fetch` since it's just a ref.
- **Custom ref namespaces** (`refs/<tool>/*`) are the general pattern: Gerrit uses
  `refs/changes/XX/NNNNN/PP`. Trade-off is real: plain custom refs get git's native
  fetch/pack/GC handling but you own merge logic yourself (as git-bug does); notes get built-in
  merge strategies but weaker default sync.
- **Gerrit Change-Id vs. Jujutsu change-id** (the crux of "metadata survives rebase"): Gerrit's is
  plain text *inside* the commit message (portable across any git implementation, but mutates
  history on first insertion and can collide/duplicate). Jujutsu's is an **external database
  entry** (exact, rich, no message mutation, but not part of the git object model — needs its own
  sync/export mechanism, i.e. exactly the durability problem we're trying to solve for our own
  metadata).
- **Hooks**: `post-commit` fires only on fresh commits — too narrow alone. `post-rewrite` fires on
  amend/rebase (all forms) with stdin `<old-sha> <new-sha>` pairs — critically, for
  squash/fixup, **all** squashed old SHAs map to the same new SHA (many-to-one), letting a
  listener correctly fold N old metadata records into one. Runs after git's own note-copying.
  **Gaps**: not invoked by `git filter-branch`/`filter-repo`, `fast-import`, or **`cherry-pick`**
  (no old→new mapping emitted at all — a real blind spot). Hooks are local-only and unversioned by
  default (need `core.hooksPath` or a wrapper like Husky to distribute reliably). `pre-push` is a
  good last checkpoint to push sidecar refs alongside code, but can't repair already-lost mappings.
  **Conclusion: `post-rewrite` is necessary but not sufficient — cherry-pick and filter-branch/repo
  need a content-derived fallback identity (Change-Id-style), not just hook-observed transitions.**
- **Large-blob sidecar precedent**: `git-lfs` (clean/smudge filters replace file content with a
  small OID-pointer blob; real content stored/fetched from an LFS server on demand) and
  `git-annex` (annexed files become symlinks/pointer files into a content-addressed
  `.git/annex/objects/` store; all bookkeeping lives in an ordinary git branch — the
  `git-annex` branch — synced via normal push/pull). Both confirm the same principle applicable to
  embeddings/transcripts: keep a small, stable, content-addressed reference inside the versioned
  record, store bulk payloads externally, sync bookkeeping via an ordinary git ref.

---

## Sources

All links inline above. Four full agent research reports (raw) are preserved in this session's
task outputs if deeper quotes are ever needed; this document is the distilled, citable version.

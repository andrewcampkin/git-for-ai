# ASK_TOOLS.md — `ask` should use the tool's own features

Written 2026-07-25 after a live failure. Spec first, per CLAUDE.md.

> **Status: SHIPPED 2026-07-25.** Built in the build order below. The acceptance test (§8.4)
> passes live against this repository: `git for-ai ask "tell me what changed in the last
> commit"` now calls `commit_diff`, reads the real patch, and names
> `architecture/ASK_TOOLS.md` and `architecture/ROADMAP.md` with their line counts.
>
> Two decisions the implementing session took to the owner rather than assuming:
>
> - **The default model is now `claude-sonnet-5`** (owner, 2026-07-25), replacing
>   `claude-haiku-4-5`. §5.4 said to measure before changing; the owner changed it up front,
>   and the reasoning holds independently: the task is no longer summarize-retrieved-text but
>   decide-which-read-answers-this, and a wrong tool choice costs a round trip *and* the
>   answer. Consequence handled in code: that model runs adaptive thinking when `thinking` is
>   omitted, and `max_tokens` covers thinking plus response text — so the per-request cap rose
>   from 1024 to 4096, and the request body deliberately carries no `thinking`/`output_config`
>   field (either would 400 on some models and break the `GIT_FOR_AI_SYNTHESIS_MODEL` escape
>   hatch). Thinking blocks are echoed back verbatim inside the loop, as that model requires.
> - **The iteration cap is visible to the user, but as an outcome — never as a number.** Hitting
>   it renders "the answer was still reading the repository when it hit the read limit" plus the
>   ranked sources and the reads it did manage; the cap value itself is machine-facing
>   (`--json` / MCP carry `skippedReason: "tool-iteration-cap"` and full `toolCalls`). Rule 10:
>   the count is our plumbing, the incomplete answer is the user's problem.
>
> Also shipped alongside: §6's `scope` rendering, and (not in the spec) a `Consulted:` block in
> the CLI, a `consulted` array on `/api/ask`, and an "Also checked: …" line in the review panel.

## 1. The failure

The owner asked the tool, through the review UI's ask panel:

> tell me what changed in the last commit

and got:

> I cannot answer this question from the provided sources. The sources contain code
> snippets, architectural ideas, and ledger entries describing various features and
> changes, but they do not specify what changed in the last commit. […] To answer your
> question, I would need access to the actual git diff or commit details.

The model was not being unhelpful. It was given eleven words and refused honestly.

## 2. Root cause (investigated, with evidence)

Reproduced once with `git for-ai ask "…" --json`, key configured, synthesis ran
(`synthesized: true`, `claude-haiku-4-5`). What came back:

- **Retrieval worked.** Rank 9 was the ledger entry for HEAD itself, `matchedBy:
  ["recency"]` — the recency floor (commit `df0a9e6`,
  `packages/core/src/query/engine.ts`) put the right source in front of the model.
- **`scope` never reaches the model.** `LedgerEntry.scope` is a per-file
  `{path, range?, blob}` array — literally "what changed" — and it was populated with 31
  real files on that source. But `renderSource()`
  (`packages/core/src/query/synthesis.ts`) builds each prompt source from a header line
  plus `chunk.text`, and `ledgerText()` (`packages/cli/src/commands/reindex.ts`) builds
  the indexed text from `summary` + `reasoning.*`. Neither reads `scope`. The only place
  it is used at all is the human-readable unsynthesized fallback in `ask.ts`.
- So `sources[8].chunk.text`, the literal string the model received for HEAD, was:
  `"The page opens in under a second, and stops talking about itself"`. The system prompt
  says "Answer from the sources ONLY … If the sources do not answer the question, say so
  plainly." It did exactly that.
- **Nothing in the index is keyed by commit.** Code chunks key on
  `blob_sha:node_path`, ledger chunks on `change_id`. No chunk anywhere carries "commit X
  touched files A, B, C" — so no amount of retrieval tuning fixes this class of question.
- Secondary and *not* the cause: the index was 3 commits stale. The recency floor covered
  it. Worth fixing as hygiene, not as this bug.

The same root cause affects all three surfaces — `ask`, `/api/ask`, and the MCP `ask`
tool all route through `askQuestion` in `core/src/query/engine.ts`.

## 3. The rejected fix, and why

The obvious patch is: detect commit-shaped questions ("last commit", "what changed in
<sha>"), and pre-fetch a diff into the prompt. Also: render `scope` into `renderSource`.

**Owner's direction, 2026-07-25 — rejected as the primary design:**

> "the ask functionality should be able to use the git for-ai features itself, that is
> partly the point. i dont think we should be preemptively guessing what the ask needs to
> shove it into context right?"

That is the correct call. A classifier is us guessing what the model will need, ahead of
time, with a keyword list we would then maintain forever — and it only ever covers the
question shapes we thought of. It also sits oddly beside what this project already is:
`git for-ai mcp` exposes `ask`, `blame_why`, `show`, `log_intent`, `annotate` and
`doctor` as tools *for other agents*. The tool's own answering path should be a client of
the same toolbox.

## 4. The design: `ask` gets tools

Synthesis becomes an agentic loop. Retrieval still runs first and still supplies numbered,
citable sources — that part works and is what makes answers verifiable. On top of it, the
model may call back into the repository for what it decides it needs.

**Tool set (v1)** — each one wraps the *identical* pure function its CLI command uses, the
same discipline the desktop action endpoints follow:

| Tool | Wraps | Answers |
|---|---|---|
| `show_change(target)` | `runShow` | "what is change X / commit Y" |
| `commit_diff(sha, context?)` | `readCommitDiff` (`reviewGit.ts`) | **the failing question** — exact, always fresh |
| `log_intent(rev?, n?)` | `runLog` | "what happened recently on this branch" |
| `blame_why(file, line)` | `runBlame` | "why is this line like this" |

Deliberately **not** in v1: a `search_repository` tool re-entering `askQuestion` (circular
— revisit once the loop is proven), and `annotate` or any other write (`ask` is a read).

**Where the code lives.** `core` cannot import the CLI (hard rule 6), and these
implementations live in the CLI. So core defines the interface and owns the loop; the CLI
injects the implementations:

```ts
// core/src/query/synthesis.ts
export interface SynthesisTool {
  name: string;
  description: string;          // prescriptive: say WHEN to call it, not just what it does
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
}
// SynthesisOptions gains: tools?: SynthesisTool[]; maxToolIterations?: number
```

The CLI builds the toolbox once (new module, `cli/src/commands/askTools.ts`) and passes it
through `SynthesisOptions` at all three call sites: `ask.ts`, `review.ts`'s `/api/ask`,
and `mcp.ts`.

**Loop shape** (Messages API, raw `fetch` — see constraint 1 below):

1. POST with `tools` declared.
2. `stop_reason: "tool_use"` → append the assistant message with its **full** `content`,
   run every requested tool (in parallel), append **one** user message containing **all**
   `tool_result` blocks. A failed tool returns `is_error: true` with the message, never a
   dropped result.
3. Repeat until `stop_reason: "end_turn"`, or the iteration cap.
4. Any other stop reason (`refusal`, …) degrades exactly as today.

## 5. Constraints this must not break

1. **Raw `fetch`, not the SDK.** `synthesis.ts` already calls the API through an injectable
   `fetchImpl` — the one sanctioned mock seam (hard rule 1), and a deliberate no-SDK
   decision (ARCHITECTURE §11.3, judgment call #1 in the file). Extend it; do not
   introduce `@anthropic-ai/sdk`.
2. **Honest degradation is unchanged.** No key → ranked sources, exactly as now. A tool
   that throws is reported, not hidden. The loop hitting its cap is a labeled outcome, not
   a silent truncation — it needs a new `SynthesisSkipReason`.
3. **`ask` is a read.** No tool may write; the non-minting guarantee still holds
   (`show`/`log`/`diff` are all read paths already).
4. **Cost and latency are now multi-call.** Every tool round trip is another API request.
   Cap iterations (start at 6) and say so in the result. The default model
   (`claude-haiku-4-5`) may need revisiting once the loop exists — measure before changing.
5. **Provenance stays visible.** The result should record which tools were called with what
   arguments, so the UI can show "consulted `git show d487e6a`" beside the answer. An
   answer grounded in a tool call is *more* verifiable than one grounded in an embedding
   hit — surface that rather than hiding it.
6. **Tests use the `fetchImpl` seam**: a fake that returns a `tool_use` response first and
   a text response second proves the loop feeds results back correctly; plus cap
   behavior, tool-error handling, and the unchanged no-key path. Never load the real
   embedder (hard rule 7).

## 6. Also worth doing, cheaply, alongside

Render `scope` into `renderSource()` (and consider folding scope paths into `ledgerText()`
so filenames become keyword-searchable — that half needs a reindex to take effect). This is
not the guessing the owner rejected: it is rendering *the record we already retrieved*
completely, instead of truncating it to its summary line. It lifts every ledger-sourced
answer, not just commit-shaped ones, and it works on a stale index.

## 6.1 Open question, recorded 2026-07-25: does `ask` become a conversation?

The owner raised this while the loop was being built: should `ask` turn into a
semi-persistent question-and-answer feature rather than a one-shot? Nothing is decided and
nothing here assumes it. Noted so the option is not lost, with the design questions it
raises — thread storage (derived, so `.git-for-ai/`, not a ref), whether an answer is ever
worth promoting into an annotation, staleness of cited sources across a long thread, and
what a thread means on three surfaces with three lifetimes (CLI process, browser panel, MCP
session). Full framing: ROADMAP.md Tier 1.

## 7. Hygiene, tracked separately

The index is 3 commits stale and `ask` warns about it correctly. Auto-reindexing inside
`ask` would load the embedding model mid-question (RAM rule 7) — so the fix is prompting,
not automation. The desktop app's "Update search" button (DESKTOP.md §5 step 4b) is
already the human-scale answer.

## 8. Build order

1. Core: `SynthesisTool`, the loop, the new skip reason, tool-call provenance in
   `SynthesisResult`. Tests through `fetchImpl`.
2. `renderSource` gains `scope` (§6).
3. CLI: `askTools.ts` with the four tools; wire into `ask.ts`, `review.ts`, `mcp.ts`.
4. Verify live against this repo: "tell me what changed in the last commit" must name real
   files. That question is the acceptance test.
5. Docs: ARCHITECTURE query section, CLI_REFERENCE if flags change, this file's status.

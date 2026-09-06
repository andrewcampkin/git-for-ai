# ASK_TOOLS.md — `ask` uses the tool's own features

How `ask` (and `/api/ask`, and the MCP `ask` tool — all route through `askQuestion` in
`core/src/query/engine.ts`) answers questions that retrieval alone cannot.

## 1. The class of question retrieval cannot answer

Ask *"tell me what changed in the last commit"* of a synthesis step that sees only retrieved
text, and the honest answer is a refusal: the sources contain code snippets and ledger
summaries, but nothing that says what a given commit touched. The model is not being
unhelpful; it is being given eleven words about that commit and told to answer from the
sources only.

## 2. Why: nothing in the index is keyed by commit

- Code chunks key on `blob_sha:node_path`; ledger chunks key on `change_id`. No chunk anywhere
  carries "commit X touched files A, B, C", so no amount of retrieval tuning reaches this
  question shape.
- A ledger entry's `scope` — the per-file `{path, range?, blob}` list, literally "what
  changed" — is retrieved but was not rendered into the prompt (`renderSource()` built each
  source from a header line plus `chunk.text`). §6 fixes that half.
- The recency floor (the newest changes' ledger entries always ride along as sources) puts
  the right entry in front of the model; it is the *content* of that entry that is thin.

## 3. Why not a question classifier

The obvious patch is to detect commit-shaped questions ("last commit", "what changed in
<sha>") and pre-fetch a diff into the prompt. That is the tool guessing what the model will
need, ahead of time, with a keyword list to maintain forever, covering only the question
shapes anyone thought of. It also sits oddly beside what this project already is:
`git for-ai mcp` exposes `ask`, `blame_why`, `show`, `log_intent`, `annotate` and `doctor`
as tools *for other agents*. The tool's own answering path is a client of the same toolbox.

## 4. The design: `ask` has tools

Synthesis is an agentic loop. Retrieval still runs first and still supplies numbered,
citable sources — that is what makes answers verifiable. On top of it, the model may call
back into the repository for what it decides it needs.

**Tool set** — each one wraps the *identical* pure function its CLI command uses, the same
discipline the desktop action endpoints follow:

| Tool | Wraps | Answers |
|---|---|---|
| `show_change(target)` | `runShow` | "what is change X / commit Y" |
| `commit_diff(sha, context?)` | `readCommitDiff` (`reviewGit.ts`) | "what changed in commit X" — exact, always fresh |
| `log_intent(rev?, n?)` | `runLog` | "what happened recently on this branch" |
| `blame_why(file, line)` | `runBlame` | "why is this line like this" |

Deliberately **not** in the set: a `search_repository` tool re-entering `askQuestion`
(circular), and `annotate` or any other write (`ask` is a read).

**Where the code lives.** `core` cannot import the CLI (the package-boundary rule), and
these implementations live in the CLI. So core defines the interface and owns the loop; the
CLI injects the implementations:

```ts
// core/src/query/synthesis.ts
export interface SynthesisTool {
  name: string;
  description: string;          // prescriptive: say WHEN to call it, not just what it does
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
}
// SynthesisOptions: tools?: SynthesisTool[]; maxToolIterations?: number
```

The CLI builds the toolbox once (`cli/src/commands/askTools.ts`) and passes it through
`SynthesisOptions` at all three call sites: `ask.ts`, `review.ts`'s `/api/ask`, and `mcp.ts`.

**Loop shape** (Messages API, raw `fetch` — see constraint 1 below):

1. POST with `tools` declared.
2. `stop_reason: "tool_use"` → append the assistant message with its **full** `content`,
   run every requested tool (in parallel), append **one** user message containing **all**
   `tool_result` blocks. A failed tool returns `is_error: true` with the message, never a
   dropped result.
3. Repeat until `stop_reason: "end_turn"`, or the iteration cap.
4. Any other stop reason (`refusal`, …) degrades exactly as the no-tools path does.

The default model is `claude-sonnet-5` (`GIT_FOR_AI_SYNTHESIS_MODEL` overrides): the task is
deciding which repository read answers the question, and a wrong tool choice costs a round
trip *and* the answer. That model runs adaptive thinking when `thinking` is omitted and
`max_tokens` covers thinking plus response text, so the per-request cap is 4096, the request
body deliberately carries no `thinking`/`output_config` field (either would 400 on some
models and break the model override), and thinking blocks are echoed back verbatim inside
the loop, as that model requires.

## 5. Constraints

1. **Raw `fetch`, not the SDK.** `synthesis.ts` calls the API through an injectable
   `fetchImpl` — the one sanctioned mock seam, and a deliberate no-SDK decision
   (ARCHITECTURE §11.3). There is no `@anthropic-ai/sdk` dependency.
2. **Honest degradation is unchanged.** No key → ranked sources. A tool that throws is
   reported, not hidden. The loop hitting its cap is a labeled outcome, not a silent
   truncation: `skippedReason: "tool-iteration-cap"`, rendered to a person as "still reading
   the repository when it hit the read limit" plus the ranked sources and the reads it did
   manage. The cap value itself (6) is machine-facing (`--json` / MCP), never on screen.
3. **`ask` is a read.** No tool writes; the non-minting guarantee still holds
   (`show`/`log`/`diff`/`blame` are all read paths).
4. **Cost and latency are multi-call.** Every tool round trip is another API request; the
   iteration cap bounds it and the result says when it was hit.
5. **Provenance stays visible.** The result records which tools were called with what
   arguments (`toolCalls`, `consulted`), so the CLI prints a `Consulted:` block, `/api/ask`
   returns `synthesis.consulted`, and the review panel shows "Also checked: …". An answer
   grounded in a tool call is *more* verifiable than one grounded in an embedding hit, and
   the confidence line says so — still derived from retrieval signals, never model-claimed.
6. **Tests use the `fetchImpl` seam**: a fake that returns a `tool_use` response first and
   a text response second proves the loop feeds results back correctly; plus cap behavior,
   tool-error handling, and the unchanged no-key path. The real embedder is never loaded.

## 6. `scope` is rendered

`renderSource()` renders a ledger entry's `scope` (the per-file list of what a change
touched). This is not guessing: it renders *the record already retrieved* completely
instead of truncating it to its summary line. It lifts every ledger-sourced answer, not just
commit-shaped ones, and works on a stale index.

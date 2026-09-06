// Answer synthesis over retrieved sources, via the Anthropic API
// (retrieval is fully local; turning sources into
// prose is a generation task, done with Claude — the same way Claude Code itself works
// — ONLY when ANTHROPIC_API_KEY is configured. No key → clean ranked-raw-sources
// fallback; this module NEVER throws for missing keys or API failures).
//
// ── Judgment calls ──
// 1. Plain `fetch`, no SDK: @anthropic-ai/sdk is not a dependency of core, and the repo
//    already establishes the thin-fetch idiom for exactly this situation
//    (embeddings/voyageEmbedder.ts — "deliberately no SDK dependency"; ARCHITECTURE.md
//    §11.3). fetchImpl is injectable, which is also the sanctioned test seam
//    ("synthesis step tests can mock the Anthropic client").
// 2. Default model: `claude-sonnet-5`. The task changed under the model: synthesis is
//    no longer a one-shot summarize-with-citations over pre-retrieved text, it is an
//    agentic loop that must DECIDE which repository read answers the question and then
//    reason over a raw diff. Tool selection is the part a fast/cheap tier gets wrong, and
//    getting it wrong costs a wasted round trip plus a bad answer. Overridable per call
//    and via GIT_FOR_AI_SYNTHESIS_MODEL.
// 5. No `thinking` / `output_config` in the request body. Sonnet 5 runs adaptive thinking
//    when `thinking` is omitted, which is what we want here (tool choice is exactly the
//    decision thinking helps with) — and every alternative is a portability trap: an
//    explicit `thinking` or `effort` field is rejected by some models, which would turn
//    the GIT_FOR_AI_SYNTHESIS_MODEL escape hatch into a 400. So the request body stays
//    model-agnostic and we simply budget for thinking: max_tokens caps thinking AND
//    response text together, so the default rose from 1024 to 4096. Thinking blocks come
//    back with empty text (`display` defaults to "omitted") and MUST be echoed back
//    unchanged inside the tool loop — which the loop does, appending assistant content
//    verbatim.
// 3. Citations: the model is instructed to cite sources inline as [n]; citedSources is
//    parsed back out of the answer text (markers stay in the prose so the CLI can render
//    them next to its numbered source list, exactly like §9.1's example).
// 4. Every failure mode degrades to `synthesized: false` + skippedReason — a query
//    command must keep working offline and keep working when the API hiccups. That now
//    includes the tool loop hitting its iteration cap: a labeled outcome
//    ("tool-iteration-cap"), never a silently truncated answer.

import type { EnrichedSource, SynthesisResult, SynthesisToolCall } from "./types.js";

/** Default synthesis model — see judgment call #2. */
export const DEFAULT_SYNTHESIS_MODEL = "claude-sonnet-5";

/** Environment variable overriding the default model (per-call option wins over both). */
export const SYNTHESIS_MODEL_ENV = "GIT_FOR_AI_SYNTHESIS_MODEL";

/** Treat empty-string env values as unset. */
function orUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Output cap. Covers thinking AND response text on thinking-capable models (call #5). */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * How many tool-use rounds one answer may take before we stop and say so. Six is enough
 * for "look at the last commit, then read why one of its files changed" with room to
 * spare; past that the model is looping, and every round is another billed request.
 */
export const DEFAULT_MAX_TOOL_ITERATIONS = 6;

/**
 * A repository read the answering model may perform for itself (ASK_TOOLS.md §4). Core
 * defines the shape and owns the loop; the CLI injects implementations, because the
 * commands these wrap live there and `core` never imports the CLI (the package-boundary rule).
 */
export interface SynthesisTool {
  /** Tool name as declared to the API (snake_case, stable — it appears in provenance). */
  name: string;
  /**
   * What it does AND when to call it. Be prescriptive: the description is the only thing
   * steering the model toward a repository read instead of an honest "I can't tell".
   */
  description: string;
  /** JSON Schema for the tool's arguments (`input_schema` on the wire). */
  inputSchema: Record<string, unknown>;
  /** Run it. Throwing is fine — the error is reported to the model, never swallowed. */
  run(input: Record<string, unknown>): Promise<string>;
}

/**
 * The PREFERRED key env var, checked before ANTHROPIC_API_KEY. Deliberately a name no
 * other tool reads: a globally-exported ANTHROPIC_API_KEY is detected by Claude Code
 * itself (which may then bill API instead of the user's subscription) and by any other
 * Anthropic tooling. Setting GIT_FOR_AI_ANTHROPIC_KEY scopes the key to this tool only.
 */
export const SYNTHESIS_KEY_ENV = "GIT_FOR_AI_ANTHROPIC_KEY";

export interface SynthesisOptions {
  /** Anthropic API key. Default: $GIT_FOR_AI_ANTHROPIC_KEY, else $ANTHROPIC_API_KEY. Absent → fallback result. */
  apiKey?: string;
  /** Model id. Default: $GIT_FOR_AI_SYNTHESIS_MODEL, else {@link DEFAULT_SYNTHESIS_MODEL}. */
  model?: string;
  /** Output token cap per request. Default 4096 (thinking shares this budget — call #5). */
  maxTokens?: number;
  /** Injectable fetch (tests — the one sanctioned mock seam). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint override (tests / proxies). */
  endpoint?: string;
  /**
   * Repository reads the model may perform for itself. Absent/empty = the original
   * one-shot behavior, unchanged. The CLI builds this set (`askTools.ts`).
   */
  tools?: SynthesisTool[];
  /** Tool-use rounds allowed. Default {@link DEFAULT_MAX_TOOL_ITERATIONS}. */
  maxToolIterations?: number;
}

/** The exact prompt strings sent to the API — exported so tests assert construction. */
export interface SynthesisPrompt {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  "You answer questions about a git repository's history and the recorded intent behind its changes.",
  "You are given numbered sources: ledger entries (recorded intent/reasoning for a change),",
  "session summaries (what an AI agent did), and code chunks.",
  "Answer from the sources ONLY — never from general knowledge. Cite every claim with the",
  "source number in square brackets, e.g. [1] or [2]. If the sources do not answer the",
  "question, say so plainly. Be concise: a few sentences, no preamble, no headings.",
].join(" ");

/**
 * Appended when tools are available. The first paragraph is the whole point of
 * ASK_TOOLS.md: the retrieved sources are a starting point, not the boundary of what is
 * knowable — refusing while a one-call answer sits in the repository is the failure this
 * replaces (§1). It is deliberately prescriptive about WHEN to call, not just what
 * exists: an under-triggered tool reproduces the original bug exactly.
 */
const TOOLS_SYSTEM_PROMPT = [
  "You also have tools that read this repository directly. The numbered sources are a",
  "starting point, not the limit of what you can know: whenever the question is about a",
  "specific commit, change, file or line — or the sources are too thin to answer — call a",
  "tool and read the real thing before answering. Never say you lack the information",
  "without first checking whether a tool would provide it. Call tools in parallel when you",
  "need several reads. Claims taken from the numbered sources keep their [n] markers;",
  "claims taken from a tool result need no marker — name what you looked at instead",
  "(e.g. \"the last commit touched …\").",
].join(" ");

/** Render one source as the model sees it: a metadata header line + the indexed text. */
function renderSource(source: EnrichedSource, number: number): string {
  const chunk = source.chunk;
  const header: string[] = [`[${number}]`, chunk.kind];
  if (chunk.kind === "ledger" && chunk.changeId !== null) {
    header.push(`change c/${chunk.changeId.slice(0, 8)}`);
    if (source.ledgerEntry !== null) {
      header.push(`(${source.ledgerEntry.provenance}, ${source.ledgerEntry.created_at})`);
    }
  } else if (chunk.kind === "session" && chunk.sessionRef !== null) {
    header.push(chunk.sessionRef.slice(0, 13));
    if (source.sessionRecord !== null) {
      header.push(`(${source.sessionRecord.agent.tool}, ${source.sessionRecord.captured_at})`);
    }
  } else if (chunk.kind === "code" && chunk.path !== null) {
    const lines =
      chunk.startLine !== null && chunk.endLine !== null
        ? `:${chunk.startLine}-${chunk.endLine}`
        : "";
    header.push(`${chunk.path}${lines}`);
  }
  if (source.matchedBy.includes("recency")) {
    // Tells the model this source is here as chronology, not similarity — with the
    // created_at already in the ledger header, temporal questions become answerable.
    header.push("[recent change]");
  }

  const body: string[] = [chunk.text];
  // ASK_TOOLS.md §6: a ledger entry's `scope` IS "what changed" — a per-file list that
  // was populated and retrieved and then dropped on the floor, because the indexed text
  // is built from summary + reasoning only. Rendering it is not guessing what the model
  // needs; it is showing the record we already fetched instead of its first line.
  const scope = source.ledgerEntry?.scope ?? [];
  if (scope.length > 0) {
    const shown = scope
      .slice(0, MAX_RENDERED_SCOPE_PATHS)
      .map((file) => `  ${file.path}${file.range ? `:${file.range[0]}-${file.range[1]}` : ""}`);
    if (scope.length > MAX_RENDERED_SCOPE_PATHS) {
      shown.push(`  … and ${scope.length - MAX_RENDERED_SCOPE_PATHS} more files`);
    }
    body.push(`Files changed (${scope.length}):\n${shown.join("\n")}`);
  }
  return `${header.join(" ")}\n${body.join("\n")}`;
}

/** Scope lists are per-file and a wide commit can carry hundreds — cap, and say so. */
const MAX_RENDERED_SCOPE_PATHS = 40;

/** Build the exact prompt for a question over sources (exported for tests). */
export function buildSynthesisPrompt(
  question: string,
  sources: EnrichedSource[],
  tools: SynthesisTool[] = [],
): SynthesisPrompt {
  const rendered = sources.map((source, i) => renderSource(source, i + 1)).join("\n\n");
  return {
    system: tools.length > 0 ? `${SYSTEM_PROMPT}\n\n${TOOLS_SYSTEM_PROMPT}` : SYSTEM_PROMPT,
    user: `Question: ${question}\n\nSources:\n\n${rendered}`,
  };
}

/** Extract `[n]` citation markers (1..sources count), deduped, in first-appearance order. */
export function extractCitations(answer: string, sourceCount: number): number[] {
  const cited: number[] = [];
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= sourceCount && !cited.includes(n)) {
      cited.push(n);
    }
  }
  return cited;
}

/** One block of an API response's `content` (text, thinking, or tool_use). */
interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** A turn in the tool loop. `content` is opaque on purpose — assistant turns are echoed back verbatim. */
interface ConversationMessage {
  role: "user" | "assistant";
  content: unknown;
}

const fallback = (
  skippedReason: NonNullable<SynthesisResult["skippedReason"]>,
  error?: string,
  toolCalls: SynthesisToolCall[] = [],
): SynthesisResult => ({
  synthesized: false,
  answer: null,
  citedSources: [],
  skippedReason,
  ...(error !== undefined ? { error } : {}),
  // Reads that happened before the failure are still facts worth surfacing.
  ...(toolCalls.length > 0 ? { toolCalls } : {}),
});

/** Run one tool, turning any throw into a reported error — never a crashed answer. */
async function runOneTool(
  tool: SynthesisTool | undefined,
  block: AnthropicContentBlock,
): Promise<{ record: SynthesisToolCall; result: Record<string, unknown> }> {
  const name = block.name ?? "(unnamed)";
  const input =
    typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>)
      : {};

  let text: string;
  let error: string | undefined;
  if (tool === undefined) {
    error = `unknown tool '${name}'`;
    text = error;
  } else {
    try {
      text = await tool.run(input);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      text = `Tool '${name}' failed: ${error}`;
    }
  }
  const body = text.length > 0 ? text : "(the tool returned no output)";
  return {
    record: {
      name,
      input,
      ok: error === undefined,
      ...(error !== undefined ? { error } : {}),
      chars: body.length,
    },
    result: {
      type: "tool_result",
      tool_use_id: block.id,
      content: body,
      ...(error !== undefined ? { is_error: true } : {}),
    },
  };
}

/**
 * Synthesize a prose answer with citations from enriched sources, letting the model call
 * back into the repository for what it decides it needs (ASK_TOOLS.md §4). Returns the
 * ranked-raw-sources fallback (`synthesized: false`) when no API key is configured, when
 * there are no sources, when the API call fails, or when the tool loop hits its cap —
 * never throws.
 */
export async function synthesizeAnswer(
  question: string,
  sources: EnrichedSource[],
  options: SynthesisOptions = {},
): Promise<SynthesisResult> {
  // Prefer the tool-scoped var (see SYNTHESIS_KEY_ENV) so users never need a global
  // ANTHROPIC_API_KEY that other tools (Claude Code included) would also pick up.
  const apiKey =
    options.apiKey ??
    orUndefined(process.env[SYNTHESIS_KEY_ENV]) ??
    process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    return fallback("no-api-key");
  }
  if (sources.length === 0) {
    return fallback("no-sources");
  }

  const model =
    options.model ?? process.env[SYNTHESIS_MODEL_ENV] ?? DEFAULT_SYNTHESIS_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  // A zero cap means "no tool loop" — declaring tools we would refuse to run would only
  // buy a guaranteed dead end on the first round trip.
  const tools = maxIterations > 0 ? (options.tools ?? []) : [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const prompt = buildSynthesisPrompt(question, sources, tools);

  const messages: ConversationMessage[] = [{ role: "user", content: prompt.user }];
  const toolCalls: SynthesisToolCall[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let answeringModel = model;

  for (let iteration = 0; ; iteration += 1) {
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint ?? ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: prompt.system,
          messages,
          ...(tools.length > 0
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
              }
            : {}),
        }),
      });
    } catch (error) {
      return fallback(
        "api-error",
        `Anthropic API request failed: ${error instanceof Error ? error.message : String(error)}`,
        toolCalls,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return fallback(
        "api-error",
        `Anthropic API returned ${response.status}: ${text.slice(0, 500) || "(no body)"}`,
        toolCalls,
      );
    }

    let body: AnthropicResponseBody;
    try {
      body = (await response.json()) as AnthropicResponseBody;
    } catch {
      return fallback("api-error", "Anthropic API returned a non-JSON body", toolCalls);
    }

    if (body.usage !== undefined) {
      // One answer can now cost several round trips — report what it actually cost.
      usage.inputTokens += body.usage.input_tokens ?? 0;
      usage.outputTokens += body.usage.output_tokens ?? 0;
      sawUsage = true;
    }
    if (body.model !== undefined) {
      answeringModel = body.model;
    }
    if (body.stop_reason === "refusal") {
      return fallback("refusal", undefined, toolCalls);
    }

    const content = body.content ?? [];
    const toolUses = content.filter(
      (block) => block.type === "tool_use" && typeof block.id === "string",
    );

    if (toolUses.length > 0) {
      if (iteration >= maxIterations) {
        // Labeled outcome, not a silent truncation (ASK_TOOLS.md §5.2): the last
        // assistant turn ends mid-tool-call, so there is no answer to salvage — but the
        // reads that DID happen are carried out with the fallback.
        return fallback(
          "tool-iteration-cap",
          `the answer was still reading the repository after ${maxIterations} rounds`,
          toolCalls,
        );
      }
      // The FULL content goes back, thinking blocks included — a thinking-capable model
      // rejects a turn whose blocks were filtered or reordered (judgment call #5).
      messages.push({ role: "assistant", content });
      const ran = await Promise.all(
        toolUses.map((block) => runOneTool(toolsByName.get(block.name ?? ""), block)),
      );
      for (const { record } of ran) {
        toolCalls.push(record);
      }
      // All results in ONE user message: splitting them teaches the model to stop
      // requesting parallel calls.
      messages.push({ role: "user", content: ran.map(({ result }) => result) });
      continue;
    }

    const answer = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();
    if (answer.length === 0) {
      return fallback("empty-response", undefined, toolCalls);
    }

    return {
      synthesized: true,
      answer,
      citedSources: extractCitations(answer, sources.length),
      model: answeringModel,
      ...(sawUsage ? { usage } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

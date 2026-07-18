// Milestone 11 — answer synthesis over retrieved sources, via the Anthropic API
// (CLI_PLAN.md M11 honest-scope note: retrieval is fully local; turning sources into
// prose is a generation task, done with Claude — the same way Claude Code itself works
// — ONLY when ANTHROPIC_API_KEY is configured. No key → clean ranked-raw-sources
// fallback; this module NEVER throws for missing keys or API failures).
//
// ── Judgment calls ──
// 1. Plain `fetch`, no SDK: @anthropic-ai/sdk is not a dependency of core, and the repo
//    already establishes the thin-fetch idiom for exactly this situation
//    (embeddings/voyageEmbedder.ts — "deliberately no SDK dependency"; ARCHITECTURE.md
//    §11.3). fetchImpl is injectable, which is also the sanctioned M11 test seam
//    ("synthesis step tests can mock the Anthropic client").
// 2. Default model: `claude-haiku-4-5` — the current cost-effective tier (per the
//    claude-api reference, cached 2026-06). Synthesis here is a grounded
//    summarize-with-citations task over pre-retrieved sources, squarely in the
//    fast/cheap tier's competence; a repo-history question should not cost Opus-tier
//    tokens per invocation. Overridable per call and via GIT_FOR_AI_SYNTHESIS_MODEL.
// 3. Citations: the model is instructed to cite sources inline as [n]; citedSources is
//    parsed back out of the answer text (markers stay in the prose so M12 can render
//    them next to its numbered source list, exactly like §9.1's example).
// 4. Every failure mode degrades to `synthesized: false` + skippedReason — a query
//    command must keep working offline and keep working when the API hiccups.

import type { EnrichedSource, SynthesisResult } from "./types.js";

/** Default synthesis model — cost-effective current tier; see judgment call #2. */
export const DEFAULT_SYNTHESIS_MODEL = "claude-haiku-4-5";

/** Environment variable overriding the default model (per-call option wins over both). */
export const SYNTHESIS_MODEL_ENV = "GIT_FOR_AI_SYNTHESIS_MODEL";

/** Treat empty-string env values as unset. */
function orUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

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
  /** Output token cap. Default 1024 (a sourced answer is a paragraph, not an essay). */
  maxTokens?: number;
  /** Injectable fetch (tests — the one sanctioned mock seam). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint override (tests / proxies). */
  endpoint?: string;
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
  return `${header.join(" ")}\n${chunk.text}`;
}

/** Build the exact prompt for a question over sources (exported for tests). */
export function buildSynthesisPrompt(
  question: string,
  sources: EnrichedSource[],
): SynthesisPrompt {
  const rendered = sources.map((source, i) => renderSource(source, i + 1)).join("\n\n");
  return {
    system: SYSTEM_PROMPT,
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

interface AnthropicResponseBody {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const fallback = (
  skippedReason: NonNullable<SynthesisResult["skippedReason"]>,
  error?: string,
): SynthesisResult => ({
  synthesized: false,
  answer: null,
  citedSources: [],
  skippedReason,
  ...(error !== undefined ? { error } : {}),
});

/**
 * Synthesize a prose answer with citations from enriched sources. Returns the
 * ranked-raw-sources fallback (`synthesized: false`) when no API key is configured,
 * when there are no sources, or when the API call fails — never throws.
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
  const prompt = buildSynthesisPrompt(question, sources);

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
        messages: [{ role: "user", content: prompt.user }],
      }),
    });
  } catch (error) {
    return fallback(
      "api-error",
      `Anthropic API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return fallback(
      "api-error",
      `Anthropic API returned ${response.status}: ${body.slice(0, 500) || "(no body)"}`,
    );
  }

  let body: AnthropicResponseBody;
  try {
    body = (await response.json()) as AnthropicResponseBody;
  } catch {
    return fallback("api-error", "Anthropic API returned a non-JSON body");
  }

  if (body.stop_reason === "refusal") {
    return fallback("refusal");
  }

  const answer = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  if (answer.length === 0) {
    return fallback("empty-response");
  }

  return {
    synthesized: true,
    answer,
    citedSources: extractCitations(answer, sources.length),
    model: body.model ?? model,
    ...(body.usage !== undefined
      ? {
          usage: {
            inputTokens: body.usage.input_tokens ?? 0,
            outputTokens: body.usage.output_tokens ?? 0,
          },
        }
      : {}),
  };
}

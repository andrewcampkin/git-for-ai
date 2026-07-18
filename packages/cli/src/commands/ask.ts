// `git for-ai ask "<question>"` — Milestone 12 (architecture/CLI_PLAN.md), over M11's
// query engine. Spec: CLI_REFERENCE.md's `ask` section and ARCHITECTURE.md §9.1's
// example output. Hybrid keyword+vector retrieval is fully local; the prose answer is
// synthesized via the Anthropic API ONLY when a key is configured
// (GIT_FOR_AI_ANTHROPIC_KEY preferred, then ANTHROPIC_API_KEY — see core's
// SYNTHESIS_KEY_ENV note); with no key the command renders the ranked raw sources —
// the CLI_PLAN M11 honest-scope fallback — as a first-class result, not an error.
//
// ── Judgment calls ──
// 1. The default path is exactly `askQuestion` (engine.ts). `--since/--until` need a
//    filter BETWEEN enrichment and synthesis (so citations number the filtered list),
//    which askQuestion's one-shot pipeline cannot express — that path composes the same
//    three exported engine steps (retrieveSources → enrichSources → synthesizeAnswer)
//    directly, over-fetching so filtering still fills k slots.
// 2. Date filtering keeps only sources whose OWN record carries a timestamp in range
//    (ledger created_at, session captured_at). Code chunks carry no timestamp, so a
//    date-filtered query drops them — "what happened since X" is a question about
//    recorded activity, and pretending code chunks have dates would be fabrication.
// 3. `--sources-only` never calls the API and reports skippedReason "not-requested"
//    (the honest reason — a key may well be configured).
// 4. The §9.1 "Confidence:" line is a deterministic label derived from retrieval
//    signals (never model-claimed): high = a cited ledger source matched by BOTH
//    retrieval halves ("keyword confirms the embedding"); medium = captured records
//    (ledger/session) among the cited sources; low = code context only. Rendered only
//    for synthesized answers — ranked raw sources carry their own signals instead.
// 5. Zero retrieved sources exits 2 (degraded-but-answered, CLI_REFERENCE conventions):
//    the command answered honestly ("nothing indexed matches"), but nobody got an answer.

import {
  askQuestion,
  retrieveSources,
  enrichSources,
  synthesizeAnswer,
  SYNTHESIS_KEY_ENV,
  type AskResult,
  type Embedder,
  type EnrichedSource,
  type SynthesisOptions,
  type SynthesisResult,
} from "@git-for-ai/core";

import { openQueryDeps } from "./queryDeps.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Options for {@link runAsk}, mirroring CLI_REFERENCE.md's `ask` flags. */
export interface AskCliOptions {
  /** Repository to query (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--k <N>` — retrieval breadth (default 8). */
  k?: number;
  /** `--sources-only` — skip synthesis, just show the ranked hits. */
  sourcesOnly?: boolean;
  /** `--since <date>` — only sources whose record is dated after this. */
  since?: string;
  /** `--until <date>` — only sources whose record is dated before this. */
  until?: string;
  /** Injectable embedder (tests — the real model is never loaded in tests). */
  embedder?: Embedder;
  /**
   * Synthesis overrides (tests inject apiKey + fetchImpl; bin.ts leaves this unset so
   * the key comes from the environment).
   */
  synthesis?: SynthesisOptions;
}

/** Deterministic confidence label (judgment call #4). */
export interface AskConfidence {
  level: "high" | "medium" | "low";
  reason: string;
}

/** The structured result behind the rendered output (what `--json` serializes). */
export interface AskCliData extends AskResult {
  /** Present iff the answer was synthesized. */
  confidence?: AskConfidence;
}

export interface AskCliResult {
  data: AskCliData;
  /** Rendered console output (§9.1 shape). */
  output: string;
  /** 0 = answered; 2 = degraded (no sources to answer from). */
  exitCode: 0 | 2;
}

// ─── Shared rendering helpers (also used by blame.ts) ────────────────────────

const WRAP_WIDTH = 98;

/** Wrap `text` at word boundaries; continuation lines get `indent`. */
export function wrapText(text: string, firstPrefix: string, indent: string): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = firstPrefix;
  let bare = true; // current holds only its prefix
  for (const word of words) {
    if (!bare && current.length + 1 + word.length > WRAP_WIDTH) {
      lines.push(current);
      current = indent + word;
    } else {
      current = bare ? current + word : `${current} ${word}`;
    }
    bare = false;
  }
  lines.push(current);
  return lines;
}

const shortId = (id: string): string => id.slice(0, 8);

/** `sha256:1f4e9c` — the abbreviated session pointer §9.1 shows. */
function shortSessionRef(ref: string): string {
  return ref.startsWith("sha256:") ? `sha256:${ref.slice("sha256:".length, "sha256:".length + 6)}` : ref;
}

const dateOf = (iso: string): string => iso.slice(0, 10);

/**
 * One source reference line, §9.1 shape:
 *   `[1] ledger 9f2c1a7b  src/auth/session.rs:40-118  (agent-captured)`
 *   `[2] session sha256:1f4e9c  claude-code 2026-07-17`
 * Every absent record degrades to an explicit label, never silence.
 */
export function sourceRefLine(source: EnrichedSource, number: number): string {
  const chunk = source.chunk;
  const parts: string[] = [`[${number}]`, chunk.kind];
  if (chunk.kind === "ledger") {
    parts.push(chunk.changeId !== null ? shortId(chunk.changeId) : "(unknown change)");
    const scope = source.ledgerEntry?.scope[0];
    if (scope !== undefined) {
      parts.push(` ${scope.path}${scope.range ? `:${scope.range[0]}-${scope.range[1]}` : ""}`);
    }
    parts.push(
      source.ledgerEntry !== null
        ? ` (${source.ledgerEntry.provenance})`
        : " (ledger record unavailable)",
    );
  } else if (chunk.kind === "session") {
    parts.push(chunk.sessionRef !== null ? shortSessionRef(chunk.sessionRef) : "(unknown ref)");
    if (source.sessionRecord !== null) {
      parts.push(` ${source.sessionRecord.agent.tool} ${dateOf(source.sessionRecord.captured_at)}`);
    } else {
      parts.push(" (session record unavailable)");
    }
  } else {
    const lines =
      chunk.startLine !== null && chunk.endLine !== null
        ? `:${chunk.startLine}-${chunk.endLine}`
        : "";
    parts.push(`${chunk.path ?? "(unknown path)"}${lines}`);
  }
  // Parts carrying a leading space join into the §9.1 double-space separators.
  return parts.join(" ");
}

/** Indented content lines for one source — what makes the raw-sources view useful. */
export function sourceDetailLines(source: EnrichedSource, indent: string): string[] {
  const lines: string[] = [];
  const entry = source.ledgerEntry;
  if (source.chunk.kind === "ledger" && entry !== null) {
    lines.push(...wrapText(entry.summary, indent, `${indent}  `));
    if (entry.reasoning?.intent !== undefined) {
      lines.push(...wrapText(`intent: ${entry.reasoning.intent}`, indent, `${indent}  `));
    }
    for (const rejected of entry.reasoning?.rejected ?? []) {
      lines.push(
        ...wrapText(`rejected: ${rejected.option} — ${rejected.why}`, indent, `${indent}  `),
      );
    }
  } else if (source.chunk.kind === "session" && source.sessionRecord !== null) {
    const summary = source.sessionRecord.summary ?? source.chunk.text;
    lines.push(...wrapText(summary, indent, `${indent}  `));
  } else {
    // Code (or a chunk whose record vanished): the indexed text's first line, clipped.
    const first = source.chunk.text.split("\n", 1)[0]?.trim() ?? "";
    if (first.length > 0) {
      lines.push(`${indent}${first.length > 90 ? `${first.slice(0, 87)}…` : first}`);
    }
  }
  return lines;
}

/** `1 ledger entry, 1 session summary, 2 code chunks` — zero kinds omitted. */
function kindCountsPhrase(sources: EnrichedSource[]): string {
  const counts = { ledger: 0, session: 0, code: 0 };
  for (const source of sources) {
    counts[source.chunk.kind] += 1;
  }
  const parts: string[] = [];
  if (counts.ledger > 0) parts.push(`${counts.ledger} ledger entr${counts.ledger === 1 ? "y" : "ies"}`);
  if (counts.session > 0) {
    parts.push(`${counts.session} session summar${counts.session === 1 ? "y" : "ies"}`);
  }
  if (counts.code > 0) parts.push(`${counts.code} code chunk${counts.code === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Deterministic retrieval-signal confidence (judgment call #4). */
export function confidenceFor(
  sources: EnrichedSource[],
  citedSources: number[],
): AskConfidence {
  const consulted =
    citedSources.length > 0
      ? citedSources
          .map((n) => sources[n - 1])
          .filter((source): source is EnrichedSource => source !== undefined)
      : sources;
  if (
    consulted.some(
      (source) =>
        source.chunk.kind === "ledger" &&
        source.matchedBy.includes("vector") &&
        source.matchedBy.includes("keyword"),
    )
  ) {
    return {
      level: "high",
      reason: "recorded intent matched by both keyword and vector retrieval",
    };
  }
  if (consulted.some((source) => source.chunk.kind !== "code")) {
    return { level: "medium", reason: "drawn from captured intent/session records" };
  }
  return { level: "low", reason: "code context only — no captured intent among the sources" };
}

/** Why there is no prose, in one honest line (shared with blame's --explain). */
export function synthesisSkipLine(synthesis: SynthesisResult, sourcesOnly: boolean): string {
  if (sourcesOnly) {
    return "Synthesis skipped (--sources-only). Ranked sources:";
  }
  switch (synthesis.skippedReason) {
    case "no-api-key":
      return (
        "No synthesized answer: no API key configured " +
        `(set ${SYNTHESIS_KEY_ENV} to enable prose answers; retrieval stayed fully local). ` +
        "Ranked sources:"
      );
    case "api-error":
      return `No synthesized answer: the API call failed (${synthesis.error ?? "unknown error"}). Ranked sources:`;
    case "refusal":
      return "No synthesized answer: the model declined to answer. Ranked sources:";
    case "empty-response":
      return "No synthesized answer: the API returned no text. Ranked sources:";
    default:
      return "No synthesized answer. Ranked sources:";
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function render(data: AskCliData, sourcesOnly: boolean): string {
  const lines: string[] = [];

  if (data.sources.length === 0) {
    lines.push("No sources found for this question — nothing indexed matches.");
    lines.push(
      "  (If the repository has recent captured intent, run `git for-ai reindex` and retry.)",
    );
  } else if (data.synthesis.synthesized && data.synthesis.answer !== null) {
    const cited = data.synthesis.citedSources
      .map((n) => data.sources[n - 1])
      .filter((source): source is EnrichedSource => source !== undefined);
    const drawnFrom = kindCountsPhrase(cited.length > 0 ? cited : data.sources);
    lines.push(`Answer (from ${drawnFrom}):`);
    lines.push(...wrapText(data.synthesis.answer, "  ", "  "));
    lines.push("Sources:");
    data.sources.forEach((source, index) => {
      lines.push(`  ${sourceRefLine(source, index + 1)}`);
    });
    if (data.confidence !== undefined) {
      lines.push(`Confidence: ${data.confidence.level} (${data.confidence.reason})`);
    }
  } else {
    lines.push(synthesisSkipLine(data.synthesis, sourcesOnly));
    data.sources.forEach((source, index) => {
      lines.push(`  ${sourceRefLine(source, index + 1)}`);
      lines.push(...sourceDetailLines(source, "      "));
    });
  }

  for (const warning of data.warnings) {
    lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

// ─── Date filter (judgment call #2) ──────────────────────────────────────────

function sourceTimestamp(source: EnrichedSource): string | null {
  if (source.chunk.kind === "ledger") {
    return source.ledgerEntry?.created_at ?? null;
  }
  if (source.chunk.kind === "session") {
    return source.sessionRecord?.captured_at ?? null;
  }
  return null;
}

function parseDateFlag(flag: string, value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid ${flag} date: '${value}' (expected e.g. 2026-07-01)`);
  }
  return parsed;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * `git for-ai ask "<question>"`: hybrid local retrieval + optional synthesis.
 * Pure logic, no console I/O — bin.ts prints `result.output` and sets the exit code.
 */
export async function runAsk(question: string, options: AskCliOptions = {}): Promise<AskCliResult> {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    throw new Error("ask needs a non-empty question");
  }
  if (options.k !== undefined && (!Number.isInteger(options.k) || options.k < 1)) {
    throw new Error(`invalid --k ${options.k} (expected a positive integer)`);
  }
  const since = options.since !== undefined ? parseDateFlag("--since", options.since) : null;
  const until = options.until !== undefined ? parseDateFlag("--until", options.until) : null;

  const deps = await openQueryDeps({
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
  });
  try {
    const k = options.k ?? 8;
    // --sources-only never reaches the API (judgment call #3); the apiKey "" makes any
    // accidental call path fall back rather than bill anyone, and we overwrite the
    // reason below with the honest one.
    const synthesisOptions: SynthesisOptions | undefined = options.sourcesOnly
      ? { apiKey: "" }
      : options.synthesis;

    let result: AskResult;
    if (since === null && until === null) {
      result = await askQuestion({ store: deps.store, embedder: deps.embedder, ctx: deps.ctx }, trimmed, {
        k,
        ...(synthesisOptions !== undefined ? { synthesis: synthesisOptions } : {}),
      });
    } else {
      // Date-filtered path (judgment call #1): compose the same engine steps so the
      // filter lands between enrichment and synthesis. Over-fetch so k slots still fill.
      const warnings: string[] = [];
      const ranked = await retrieveSources(deps.store, deps.embedder, trimmed, { k: k * 4 });
      const enriched = await enrichSources(ranked, deps.ctx, warnings);
      const filtered = enriched
        .filter((source) => {
          const timestamp = sourceTimestamp(source);
          if (timestamp === null) {
            return false; // undated (code) sources drop under a date filter (#2)
          }
          const at = Date.parse(timestamp);
          return (since === null || at >= since) && (until === null || at <= until);
        })
        .slice(0, k)
        .map((source, index) => ({ ...source, rank: index + 1 }));
      const synthesis = await synthesizeAnswer(trimmed, filtered, synthesisOptions);
      result = { question: trimmed, sources: filtered, synthesis, warnings };
    }

    if (options.sourcesOnly === true) {
      result = {
        ...result,
        synthesis: {
          synthesized: false,
          answer: null,
          citedSources: [],
          skippedReason: "not-requested",
        },
      };
    }

    const data: AskCliData = {
      ...result,
      warnings: [...deps.warnings, ...result.warnings],
      ...(result.synthesis.synthesized
        ? { confidence: confidenceFor(result.sources, result.synthesis.citedSources) }
        : {}),
    };
    return {
      data,
      output: render(data, options.sourcesOnly === true),
      exitCode: data.sources.length === 0 ? 2 : 0,
    };
  } finally {
    deps.close();
  }
}

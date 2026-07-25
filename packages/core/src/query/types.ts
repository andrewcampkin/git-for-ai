// Milestone 11 — query engine result types (architecture/CLI_PLAN.md M11).
//
// These shapes are the contract with M12's two commands (`ask`, `blame --why`) AND with
// machine consumers (`--json` later), so they are designed to carry everything the
// ARCHITECTURE.md §9.1 example outputs render, without M12 re-fetching anything:
//
//   ask (§9.1):        prose answer + "Sources: [1] ledger 9f2c1a7b src/...:40-118
//                      (agent-captured) / [2] session sha256:1f4e9c claude-code ..." —
//                      needs ranked sources, each enriched with its full ledger entry
//                      (summary/reasoning/provenance/scope) and session record.
//   blame --why (§9.1): "change 9f2c1a7b (agent-captured, confidence 0.82) / WHY: ... /
//                      CONSIDERED & REJECTED: ... / SESSION: claude-code, date /
//                      LATER TOUCHED BY: c/7a2b ..." — needs the blamed commit, its
//                      change identity, the effective ledger entry, the session record,
//                      and the later-touching changes.
//
// Everything here is plain JSON-serializable data (no class instances, no functions).

import type { ChangeMapEntry, LedgerEntry, SessionRecord } from "@git-for-ai/schemas";

import type { StoredChunk } from "../embeddings/store.js";

/**
 * How a source earned its place: matched by the vector or keyword half of the hybrid
 * index — or included by the RECENCY floor ("recency"): ask always appends the most
 * recent changes' effective ledger entries, read from git directly (never the index, so
 * they are immune to index staleness), because embedding similarity has no concept of
 * time and temporal questions ("what changed recently?") would otherwise retrieve
 * nothing relevant. Added 2026-07-19 after exactly that failure, live.
 */
export type MatchSide = "vector" | "keyword" | "recency";

/** Position-boost level applied to a source during blame-style retrieval. */
export type PositionBoost = "path" | "line";

/** One ranked retrieval hit, before git-record enrichment. */
export interface RankedSource {
  /** 1-based final rank after reciprocal-rank fusion (and any position boost). */
  rank: number;
  /** Fused RRF score (bigger = better). Comparable only within one result set. */
  score: number;
  /** The stored chunk row (kind, text, path/lines or change-id/session-ref). */
  chunk: StoredChunk;
  /** Which retrieval halves surfaced this chunk. */
  matchedBy: MatchSide[];
  /** L2 distance from the vector half (smaller = closer); present iff matched by vector. */
  vectorDistance?: number;
  /** FTS5 bm25 score (more negative = better); present iff matched by keyword. */
  keywordScore?: number;
  /** Present when a blame-position boost was applied ("line" implies the path matched too). */
  positionBoost?: PositionBoost;
}

/**
 * A ranked source enriched with its full git-native records, so M12 renders without
 * re-fetching (plan requirement). All enrichment fields are null when not applicable
 * (e.g. a code chunk with no associated change) or when the record no longer exists.
 */
export interface EnrichedSource extends RankedSource {
  /** The change-map entry for the chunk's change-id (post-`folded_into` redirect). */
  changeMapEntry: ChangeMapEntry | null;
  /** The change's EFFECTIVE ledger entry (DATA_MODEL.md §2.4 resolution). */
  ledgerEntry: LedgerEntry | null;
  /** The full session record behind the chunk's (or ledger entry's) session_ref. */
  sessionRecord: SessionRecord | null;
}

/** Why synthesis produced no prose answer. */
export type SynthesisSkipReason =
  | "no-api-key" // ANTHROPIC_API_KEY not configured — the documented offline fallback
  | "no-sources" // nothing retrieved; nothing to synthesize from
  | "not-requested" // caller did not ask for synthesis (blame default)
  | "api-error" // request failed (network / non-2xx) — degraded, never thrown
  | "refusal" // model declined (stop_reason "refusal")
  | "empty-response" // 2xx but no text content came back
  | "tool-iteration-cap"; // still calling tools at the cap — labeled, never silently truncated

/**
 * One repository read the answering model performed for itself (ASK_TOOLS.md §4): the
 * tool it called and the arguments it chose. Recorded so the answer's grounding is
 * VISIBLE — a claim backed by `git show d487e6a` is more verifiable than one backed by
 * an embedding hit, and hiding that would waste the strongest signal we have.
 */
export interface SynthesisToolCall {
  /** Tool name as declared to the API (e.g. `commit_diff`). */
  name: string;
  /** Arguments the model chose, exactly as sent to the tool. */
  input: Record<string, unknown>;
  /** False when the tool threw — the failure is reported to the model AND recorded here. */
  ok: boolean;
  /** Failure message (present iff `ok` is false). Never swallowed. */
  error?: string;
  /** Size of the text handed back to the model, in characters. */
  chars: number;
}

/**
 * Outcome of the synthesis step. `synthesized: false` is a NORMAL result (the
 * ranked-raw-sources fallback from CLI_PLAN.md M11's honest-scope note), never an error.
 */
export interface SynthesisResult {
  /** True iff `answer` holds model-generated prose. */
  synthesized: boolean;
  /** Prose answer with inline `[n]` citation markers, or null when not synthesized. */
  answer: string | null;
  /**
   * 1-based source numbers the answer cites, in order of first appearance.
   * Index into the result's `sources` array via `sources[n - 1]`.
   */
  citedSources: number[];
  /** Model id that produced the answer (present iff synthesized). */
  model?: string;
  /**
   * Token usage reported by the API, summed across every request the tool loop made
   * (present iff synthesized) — one answer can now cost several round trips.
   */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Repository reads the model performed for itself, in call order. Present (and
   * possibly non-empty) even when synthesis failed part-way — what was consulted before
   * the failure is still true, and still worth showing.
   */
  toolCalls?: SynthesisToolCall[];
  /** Present iff not synthesized. */
  skippedReason?: SynthesisSkipReason;
  /** Human-readable detail for `api-error`. */
  error?: string;
}

/** Result of `ask` — M12's `git for-ai ask "<question>"`. */
export interface AskResult {
  question: string;
  /** Ranked, enriched sources — rendered as the "Sources:" list (and the whole answer when unsynthesized). */
  sources: EnrichedSource[];
  synthesis: SynthesisResult;
  /** Non-fatal problems hit during enrichment (unreadable notes, ...). */
  warnings: string[];
}

/** A file position, 1-based line. */
export interface BlamePosition {
  /** Repo-relative POSIX path. */
  path: string;
  line: number;
}

/** A later change that touched the same file (§9.1's "LATER TOUCHED BY" line). */
export interface RelatedChangeRef {
  changeId: string;
  /** `created_at` of that change's effective ledger entry. */
  createdAt: string;
  summary: string;
}

/** Result of `blame --why` — M12's `git for-ai blame --why <file>:<line>`. */
export interface BlameWhyResult {
  position: BlamePosition;
  /** Commit `git blame` attributes the line to; null when the line is uncommitted. */
  commit: string | null;
  /** Resolved change identity (read-only — never mints identity), or null. */
  changeId: string | null;
  /**
   * How the identity was found: "map" (commit known to the change-map) or "trailer"
   * (recovered read-only from a Change-Id trailer; the map row may not exist yet).
   * Read-path analogue of the resolver's R1/R2 branches — blame never writes.
   */
  resolvedVia: "map" | "trailer" | null;
  changeMapEntry: ChangeMapEntry | null;
  /** The change's effective ledger entry — the WHY payload. Null → "no captured intent". */
  entry: LedgerEntry | null;
  /** Every ledger entry for the change, oldest first (superseded history included). */
  entries: LedgerEntry[];
  /** Full session record behind the effective entry's session_ref. */
  sessionRecord: SessionRecord | null;
  /** Later changes whose effective entries also touched this file, oldest first. */
  laterTouchedBy: RelatedChangeRef[];
  /**
   * Supplementary hybrid-retrieval context, position-boosted toward the blamed file/line.
   * Empty when the caller provided no index (blame works without one).
   */
  sources: EnrichedSource[];
  /** Optional prose (off by default — §9.1's blame output renders from `entry` directly). */
  synthesis: SynthesisResult;
  warnings: string[];
}

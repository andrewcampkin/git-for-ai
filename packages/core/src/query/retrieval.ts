// Milestone 11 — hybrid retrieval (architecture/ARCHITECTURE.md §11.4, CLI_PLAN.md M11).
//
// The index always blends keyword and vector search (§11.4: "we always blend ... rather
// than betting the query layer on embeddings alone"). This module runs both halves of
// M9's `SqliteVectorStore` — `queryVector` (vec0 KNN) and `queryKeyword` (FTS5 bm25) —
// and merges them with RECIPROCAL-RANK FUSION.
//
// ── Why RRF (judgment call) ──
// The two halves score on incommensurable scales (L2 distance vs bm25); any weighted
// score-sum needs per-corpus calibration. RRF (score = Σ 1/(K + rank)) uses only ranks,
// is the standard baseline for exactly this two-list case, has one insensitive
// parameter (K = 60, the value from the original Cormack/Clarke paper), and rewards
// appearing in BOTH lists — which is precisely the "keyword confirms the embedding"
// signal hybrid retrieval exists to capture.
//
// ── Blame-position boosting ──
// `blame --why <file>:<line>` needs the chunk covering that line to surface even when
// pure text similarity wouldn't rank it first. Rather than a hard filter (which would
// hide the ledger/session context that makes the answer useful), position matches get
// an additive boost in RRF-score space: a path match outweighs a mid-list rank, and a
// line-covering match outweighs everything except a very confident dual-half top hit.
// Both halves are over-fetched (candidateFactor) so path-local chunks are in the
// candidate pool at all.
//
// ── Query embedding ──
// The query is embedded with the SAME model that built the index (fingerprint checked
// by the store on open). For the Voyage path, the query must be embedded with
// input_type "query" (voyageEmbedder.ts judgment call #4) — the M9 factory has no
// input-type knob (reported as a suggested embeddings/ change), so
// `createQueryEmbedderFromConfig` below constructs the Voyage embedder directly with
// inputType "query" and defers everything else to the M9 factory.

import type { RepoConfig } from "@git-for-ai/schemas";

import {
  toFtsQuery,
  type IndexedKind,
  type KeywordMatch,
  type VectorMatch,
  type VectorStore,
} from "../embeddings/store.js";
import type { Embedder } from "../embeddings/types.js";
import {
  createEmbedderFromConfig,
  type CreateEmbedderOptions,
} from "../embeddings/factory.js";
import { VoyageApiError, VoyageEmbedder } from "../embeddings/voyageEmbedder.js";

import type { BlamePosition, MatchSide, RankedSource } from "./types.js";

/** RRF constant from the original reciprocal-rank-fusion paper; results are insensitive to it. */
export const DEFAULT_RRF_K = 60;

/** Default number of fused sources returned. */
export const DEFAULT_TOP_K = 8;

/** Each half is asked for `k * candidateFactor` candidates before fusion. */
const DEFAULT_CANDIDATE_FACTOR = 4;

// Additive boosts, sized against RRF contributions: a rank-1 single-half hit scores
// 1/61 ≈ 0.0164, a rank-1 dual-half hit ≈ 0.0328. PATH_BOOST lifts a path match above
// any single-half hit; LINE_BOOST (applied on top of PATH_BOOST) lifts the covering
// chunk above even a dual-half rank-1 hit that is elsewhere in the tree.
const PATH_BOOST = 1 / 30;
const LINE_BOOST = 1 / 15;

/** Position argument for blame-style retrieval: boost chunks at this path (and line). */
export interface RetrievalPosition {
  path: string;
  /** 1-based; when present, chunks whose [startLine, endLine] covers it boost highest. */
  line?: number;
}

export interface RetrieveOptions {
  /** Final result count. Default {@link DEFAULT_TOP_K}. */
  k?: number;
  /** Over-fetch multiplier per half. Default 4. */
  candidateFactor?: number;
  /** Restrict results to these content kinds (post-fetch filter). */
  kinds?: IndexedKind[];
  /** Blame-position boost (see module header). */
  position?: RetrievalPosition;
  /** Override the RRF constant (tests). */
  rrfK?: number;
}

/**
 * Hybrid retrieval: embed the query, run vector KNN + FTS5 keyword search, fuse with
 * RRF, dedupe by chunk key, return the top-k ranked sources.
 */
export async function retrieveSources(
  store: VectorStore,
  embedder: Embedder,
  query: string,
  options: RetrieveOptions = {},
): Promise<RankedSource[]> {
  const k = options.k ?? DEFAULT_TOP_K;
  const candidates = Math.max(1, k) * (options.candidateFactor ?? DEFAULT_CANDIDATE_FACTOR);

  const [queryVector] = await embedder.embed([{ text: query }]);
  const vectorMatches =
    queryVector !== undefined ? store.queryVector(queryVector, candidates) : [];
  const keywordMatches = store.queryKeyword(toFtsQuery(query), candidates);

  return fuseMatches(vectorMatches, keywordMatches, options);
}

/**
 * Reciprocal-rank fusion of the two result lists (exported pure for direct testing).
 * Input lists must be in the store's ranked order (best first). Deterministic: ties
 * break by chunk key.
 */
export function fuseMatches(
  vectorMatches: VectorMatch[],
  keywordMatches: KeywordMatch[],
  options: RetrieveOptions = {},
): RankedSource[] {
  const k = options.k ?? DEFAULT_TOP_K;
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const kinds = options.kinds !== undefined ? new Set(options.kinds) : null;
  const position = options.position;

  interface Fused {
    source: Omit<RankedSource, "rank">;
  }
  const byKey = new Map<string, Fused>();

  const accumulate = (
    matches: Array<VectorMatch | KeywordMatch>,
    side: MatchSide,
  ): void => {
    let rank = 0;
    for (const match of matches) {
      if (kinds !== null && !kinds.has(match.kind)) {
        continue; // filtered out entirely — does not consume a rank slot
      }
      rank += 1;
      const contribution = 1 / (rrfK + rank);
      const existing = byKey.get(match.key);
      const detail =
        side === "vector"
          ? { vectorDistance: (match as VectorMatch).distance }
          : { keywordScore: (match as KeywordMatch).score };
      if (existing === undefined) {
        const { distance: _d, score: _s, ...chunk } = match as VectorMatch &
          KeywordMatch;
        byKey.set(match.key, {
          source: {
            score: contribution,
            chunk,
            matchedBy: [side],
            ...detail,
          },
        });
      } else {
        existing.source.score += contribution;
        if (!existing.source.matchedBy.includes(side)) {
          existing.source.matchedBy.push(side);
        }
        Object.assign(existing.source, detail);
      }
    }
  };

  accumulate(vectorMatches, "vector");
  accumulate(keywordMatches, "keyword");

  if (position !== undefined) {
    for (const { source } of byKey.values()) {
      const boost = positionBoostFor(source.chunk, position);
      if (boost === "line") {
        source.score += PATH_BOOST + LINE_BOOST;
        source.positionBoost = "line";
      } else if (boost === "path") {
        source.score += PATH_BOOST;
        source.positionBoost = "path";
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.source.score - a.source.score || compareKeys(a.source, b.source))
    .slice(0, k)
    .map(({ source }, index) => ({ ...source, rank: index + 1 }));
}

function compareKeys(a: { chunk: { key: string } }, b: { chunk: { key: string } }): number {
  return a.chunk.key < b.chunk.key ? -1 : a.chunk.key > b.chunk.key ? 1 : 0;
}

function positionBoostFor(
  chunk: { path: string | null; startLine: number | null; endLine: number | null },
  position: RetrievalPosition,
): "path" | "line" | null {
  if (chunk.path === null || chunk.path !== position.path) {
    return null;
  }
  if (
    position.line !== undefined &&
    chunk.startLine !== null &&
    chunk.endLine !== null &&
    chunk.startLine <= position.line &&
    position.line <= chunk.endLine
  ) {
    return "line";
  }
  return "path";
}

/** Convert a {@link BlamePosition} into a retrieval position (identity today; typed seam). */
export function toRetrievalPosition(position: BlamePosition): RetrievalPosition {
  return { path: position.path, line: position.line };
}

/**
 * Build the QUERY-side embedder for the configured provider. Identical to M9's
 * `createEmbedderFromConfig` except that the Voyage path embeds with input_type
 * "query" (asymmetric retrieval models embed queries and documents differently).
 * The offline transformers path has no query/document asymmetry — delegated as-is.
 */
export function createQueryEmbedderFromConfig(
  config: RepoConfig,
  options: CreateEmbedderOptions = {},
): Embedder {
  if (config.embedder.provider === "voyage-code-3") {
    if (options.voyageApiKey === undefined || options.voyageApiKey === "") {
      throw new VoyageApiError(
        "voyage-code-3 is configured but no API key was provided (set VOYAGE_API_KEY)",
      );
    }
    return new VoyageEmbedder({
      consent: config.embedder.voyage_consent,
      apiKey: options.voyageApiKey,
      dim: config.embedder.dim,
      inputType: "query",
    });
  }
  return createEmbedderFromConfig(config, options);
}

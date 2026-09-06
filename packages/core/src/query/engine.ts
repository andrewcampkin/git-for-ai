// The query engine's two entry points, shaped for the CLI's two commands:
//
//   askQuestion  → `git for-ai ask "<question>"`      (ARCHITECTURE.md §9.1)
//   explainLine  → `git for-ai blame --why <file>:<line>`
//
// Both are pure orchestration over the module's parts (retrieval → enrichment →
// synthesis) with injected dependencies: the caller (the CLI, or a test) opens the store
// and constructs the embedder — mirroring how reindex.ts owns config/store lifecycle —
// so this module has no filesystem/config knowledge and is trivially testable with a
// synthetic store + fake embedder.
//
// ── Judgment calls ──
// 1. `explainLine` works WITHOUT an index (store/embedder optional): the §9.1 blame
//    output is renderable entirely from git-native records (blame → identity → ledger
//    → session). The index only adds supplementary position-boosted context sources.
// 2. Blame synthesis is OFF by default: the §9.1 blame output is a deterministic
//    template over the ledger entry, not generated prose. `synthesize: true` opts in.
// 3. Ask retrieval defaults to all three content kinds — "one embedding space"
//    (§11.1) is the point; callers can narrow via `kinds`.

import type { GitContext } from "../identity/changeMap.js";
import type { IndexedKind, VectorStore } from "../embeddings/store.js";
import type { Embedder } from "../embeddings/types.js";

import { blameLineCommit, findLaterTouches } from "./blame.js";
import {
  enrichSources,
  readChangeLedger,
  recentChangeSources,
  resolveChangeIdReadOnly,
} from "./enrich.js";
import { retrieveSources, toRetrievalPosition } from "./retrieval.js";
import { synthesizeAnswer, type SynthesisOptions } from "./synthesis.js";
import type {
  AskResult,
  BlamePosition,
  BlameWhyResult,
  EnrichedSource,
  SynthesisResult,
} from "./types.js";
import { readSessionRecord } from "../sessions/store.js";

/** Dependencies for `askQuestion` — the index is required for ask. */
export interface AskDeps {
  store: VectorStore;
  embedder: Embedder;
  /** Repository context (cwd/env for git subprocesses). Default: process cwd. */
  ctx?: GitContext;
}

export interface AskOptions {
  /** Number of sources to return (default 8). */
  k?: number;
  /** Restrict retrieval to specific content kinds. */
  kinds?: IndexedKind[];
  /**
   * The recency floor: how many of the repo's most recent changes (effective ledger
   * entries, read from git — index-staleness-proof) are appended as additional sources
   * so temporal questions can be answered. Default 5; 0 disables. A change already
   * retrieved semantically is not duplicated — it just gains the "recency" match side.
   */
  recent?: number;
  /** Synthesis configuration (API key, model, fetch seam). */
  synthesis?: SynthesisOptions;
}

/** Default recency-floor size (see AskOptions.recent). */
export const DEFAULT_RECENT_SOURCES = 5;

/** Hybrid retrieval + enrichment + (key-gated) synthesis for a free-form question. */
export async function askQuestion(
  deps: AskDeps,
  question: string,
  options: AskOptions = {},
): Promise<AskResult> {
  const ctx = deps.ctx ?? {};
  const warnings: string[] = [];

  const ranked = await retrieveSources(deps.store, deps.embedder, question, {
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
  });
  const sources = await enrichSources(ranked, ctx, warnings);

  // Recency floor: temporal questions can't be served by similarity alone (no source
  // text resembles "most recent"), so the newest changes ride along as extra sources —
  // unless the caller narrowed kinds away from ledger content.
  const recent = options.recent ?? DEFAULT_RECENT_SOURCES;
  if (recent > 0 && (options.kinds === undefined || options.kinds.includes("ledger"))) {
    const byKey = new Map(sources.map((s) => [s.chunk.key, s]));
    for (const recentSource of await recentChangeSources(recent, ctx, warnings)) {
      const existing = byKey.get(recentSource.chunk.key);
      if (existing !== undefined) {
        if (!existing.matchedBy.includes("recency")) {
          existing.matchedBy.push("recency");
        }
      } else {
        sources.push({ ...recentSource, rank: sources.length + 1 });
      }
    }
  }

  const synthesis = await synthesizeAnswer(question, sources, options.synthesis);

  return { question, sources, synthesis, warnings };
}

/** Dependencies for `explainLine` — the index is optional (see judgment call #1). */
export interface BlameWhyDeps {
  ctx?: GitContext;
  store?: VectorStore;
  embedder?: Embedder;
}

export interface BlameWhyOptions {
  /** Number of supplementary context sources (default 8; ignored without an index). */
  k?: number;
  /** Override the supplementary-retrieval query text (default: entry summary, else path). */
  queryText?: string;
  /** Opt into generating prose from the blame context (default false). */
  synthesize?: boolean;
  synthesis?: SynthesisOptions;
}

/** Full `blame --why` resolution for one file:line. */
export async function explainLine(
  deps: BlameWhyDeps,
  position: BlamePosition,
  options: BlameWhyOptions = {},
): Promise<BlameWhyResult> {
  const ctx = deps.ctx ?? {};
  const warnings: string[] = [];

  const commit = await blameLineCommit(position, ctx);

  let changeId: string | null = null;
  let resolvedVia: BlameWhyResult["resolvedVia"] = null;
  let changeMapEntry: BlameWhyResult["changeMapEntry"] = null;
  let entry: BlameWhyResult["entry"] = null;
  let entries: BlameWhyResult["entries"] = [];
  let sessionRecord: BlameWhyResult["sessionRecord"] = null;

  if (commit !== null) {
    const identity = await resolveChangeIdReadOnly(commit, ctx);
    if (identity !== null) {
      changeId = identity.changeId;
      resolvedVia = identity.via;
      changeMapEntry = identity.entry;
      if (identity.entry !== null) {
        const ledger = await readChangeLedger(identity.entry, ctx, warnings);
        entries = ledger.entries;
        entry = ledger.effective;
      }
    }
    if (entry?.session_ref !== undefined && entry?.session_ref !== null) {
      try {
        sessionRecord = await readSessionRecord(entry.session_ref, ctx);
      } catch (error) {
        warnings.push(
          `session ${entry.session_ref} could not be read: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const laterTouchedBy = await findLaterTouches(
    position.path,
    entry?.created_at ?? null,
    changeId,
    ctx,
    warnings,
  );

  let sources: EnrichedSource[] = [];
  if (deps.store !== undefined && deps.embedder !== undefined) {
    const queryText = options.queryText ?? entry?.summary ?? position.path;
    const ranked = await retrieveSources(deps.store, deps.embedder, queryText, {
      ...(options.k !== undefined ? { k: options.k } : {}),
      position: toRetrievalPosition(position),
    });
    sources = await enrichSources(ranked, ctx, warnings);
  }

  let synthesis: SynthesisResult;
  if (options.synthesize === true) {
    synthesis = await synthesizeAnswer(
      `Why does ${position.path} line ${position.line} look the way it does — what was the intent behind the change that introduced it?`,
      sources,
      options.synthesis,
    );
  } else {
    synthesis = {
      synthesized: false,
      answer: null,
      citedSources: [],
      skippedReason: "not-requested",
    };
  }

  return {
    position,
    commit,
    changeId,
    resolvedVia,
    changeMapEntry,
    entry,
    entries,
    sessionRecord,
    laterTouchedBy,
    sources,
    synthesis,
    warnings,
  };
}

// Milestone 11 — query engine barrel (hybrid retrieval + synthesis).
// Public surface re-exported from ../index.ts; see engine.ts for the two entry points.

export {
  DEFAULT_RRF_K,
  DEFAULT_TOP_K,
  retrieveSources,
  fuseMatches,
  toRetrievalPosition,
  createQueryEmbedderFromConfig,
} from "./retrieval.js";
export type { RetrievalPosition, RetrieveOptions } from "./retrieval.js";

export {
  enrichSources,
  readChangeLedger,
  resolveChangeIdReadOnly,
  followFoldedInto,
} from "./enrich.js";
export type { ChangeLedger } from "./enrich.js";

export { blameLineCommit, findLaterTouches } from "./blame.js";

export {
  DEFAULT_SYNTHESIS_MODEL,
  SYNTHESIS_MODEL_ENV,
  SYNTHESIS_KEY_ENV,
  buildSynthesisPrompt,
  extractCitations,
  synthesizeAnswer,
} from "./synthesis.js";
export type { SynthesisOptions, SynthesisPrompt } from "./synthesis.js";

export { askQuestion, explainLine } from "./engine.js";
export type { AskDeps, AskOptions, BlameWhyDeps, BlameWhyOptions } from "./engine.js";

export type {
  MatchSide,
  PositionBoost,
  RankedSource,
  EnrichedSource,
  SynthesisSkipReason,
  SynthesisResult,
  AskResult,
  BlamePosition,
  RelatedChangeRef,
  BlameWhyResult,
} from "./types.js";

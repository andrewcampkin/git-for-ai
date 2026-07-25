// The change-id assignment + resolution algorithm — architecture/ARCHITECTURE.md §7.
// This is the hardest and most important module in core: identity must survive amend,
// rebase, squash (via post-rewrite) and lazily heal after cherry-pick/filter-branch
// (which post-rewrite never observes — §7.5).

export {
  mintChangeId,
  normalizeChangeId,
  parseChangeIdTrailer,
  formatChangeIdTrailer,
} from "./changeId.js";

export {
  CHANGE_MAP_REF,
  shardPathFor,
  readChangeMapCommit,
  readChangeMapEntry,
  readAllChangeMapEntries,
  readChangeMapSnapshot,
  findEntryByCommitSha,
  upsertChangeMapEntries,
} from "./changeMap.js";
export type { GitContext, UpsertChangeMapOptions, ChangeMapSnapshot } from "./changeMap.js";

export { assignChangeId } from "./assign.js";
export type { AssignChangeIdResult } from "./assign.js";

export { resolveChangeId, DEFAULT_INFER_SIMILARITY_THRESHOLD } from "./resolve.js";
export type {
  ResolutionBranch,
  ResolveChangeIdOptions,
  ResolveChangeIdResult,
} from "./resolve.js";

export { onPostRewrite, parsePostRewriteInput, INTENT_NOTES_REF } from "./postRewrite.js";
export type { RewritePair, PostRewriteResult } from "./postRewrite.js";

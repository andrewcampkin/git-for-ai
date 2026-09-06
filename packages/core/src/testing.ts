// The `@git-for-ai/core/testing` subpath barrel: test-only helpers shared with
// consuming packages' test suites, deliberately kept out of the production API surface
// (see ./index.ts's note). Two groups:
//
//   - real-git fixture repos (git/testFixtures.ts) — the no-mocks foundation;
//   - the deterministic query-test fakes (query/testSupport.ts): BagOfWordsEmbedder
//     (token-overlap vectors, so ranking assertions are meaningful WITHOUT ever loading
//     the real embedding model) plus schema-valid record builders.
//
// The CLI tests (`ask`, `blame --why`, the review server's /api/ask) consume both.

export { createFixtureRepo } from "./git/testFixtures.js";
export type { FixtureRepo, CommitOptions, CreateFixtureRepoOptions } from "./git/testFixtures.js";

export {
  BagOfWordsEmbedder,
  storeItem,
  makeLedgerEntry,
  makeSessionRecord,
} from "./query/testSupport.js";

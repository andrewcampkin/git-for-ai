import { defineConfig } from "vitest/config";

// Every test in this package drives a REAL git repository via subprocesses (the no-mocks
// rule, CLI_PLAN.md). Individually the tests run in a few seconds, but under a full
// parallel `turbo test` the subprocess contention on Windows can push a single test past
// vitest's 5s default — which is a machine-load artifact, not a failure. 60s matches the
// vi.setConfig values the earlier test files carried per-file before this config existed.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

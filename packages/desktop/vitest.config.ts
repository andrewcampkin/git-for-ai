import { defineConfig } from "vitest/config";

// Same rationale as the CLI's config: these tests drive REAL git repositories via
// subprocesses (the no-mocks rule), and under a fully parallel `turbo test` on Windows
// the subprocess contention can push individual tests past vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

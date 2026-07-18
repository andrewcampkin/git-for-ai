import { defineConfig } from "vitest/config";

// Pure-logic + built-output tests only (no DOM environment needed): the load-bearing UI
// logic (filtering, degradation labeling, attention computation) lives in src/lib as pure
// functions precisely so it is testable without a browser emulator dependency.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});

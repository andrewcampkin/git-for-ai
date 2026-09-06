import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static build only — the SPA is served by `git for-ai review` (packages/cli), never by a
// Vite dev server in production. `base: "./"` keeps every asset reference relative so the
// build is self-contained wherever it is mounted (REVIEW_UI.md §2 self-contained rule: zero external
// requests — asserted by test/no-external.test.ts against this build's output).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

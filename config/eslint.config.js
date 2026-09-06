// Shared flat ESLint config, imported by each package's own eslint.config.js
// (each package extends this and can add package-specific overrides).
// Not wired up to actual dependencies; `pnpm lint` does not run. `tsc -b` via
// build/typecheck is the effective gate.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**"]
  }
);

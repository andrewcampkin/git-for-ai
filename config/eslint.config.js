// Shared flat ESLint config, imported by each package's own eslint.config.js
// (each package extends this and can add package-specific overrides).
// Not wired up to actual dependencies yet — see architecture/CLI_PLAN.md for when
// tooling gets installed and this gets exercised for real.
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

import { describe, expect, it } from "vitest";
import { repoConfigSchema } from "./repo-config.js";

// Worked (illustrative) example from architecture/DATA_MODEL.md §5, as it
// would parse from TOML into a JS object.
const workedExample = {
  schema: "git-for-ai/config@1",
  embedder: {
    provider: "jina-v2-code",
    dim: 768,
    offline: true,
    voyage_consent: false,
  },
  capture: {
    enabled: true,
    never_capture: [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"],
    max_span_bytes: 16384,
  },
  redaction: {
    ruleset: "builtin@1",
    extra_patterns: [],
  },
  index: {
    hybrid: true,
  },
};

describe("repoConfigSchema", () => {
  it("parses the DATA_MODEL.md §5 worked example", () => {
    const result = repoConfigSchema.safeParse(workedExample);
    expect(result.success).toBe(true);
  });

  it("rejects a config with an unrecognized major schema version", () => {
    const bad = { ...workedExample, schema: "git-for-ai/config@99" };
    const result = repoConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  for (const field of [
    "schema",
    "embedder",
    "capture",
    "redaction",
    "index",
  ] as const) {
    it(`rejects a config missing required section "${field}"`, () => {
      const clone: Record<string, unknown> = { ...workedExample };
      delete clone[field];
      const result = repoConfigSchema.safeParse(clone);
      expect(result.success).toBe(false);
    });
  }

  it("rejects an embedder section with an unrecognized provider", () => {
    const bad = {
      ...workedExample,
      embedder: { ...workedExample.embedder, provider: "gpt-embed-9000" },
    };
    const result = repoConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts the other two documented embedder providers", () => {
    for (const provider of ["nomic-embed-code", "voyage-code-3"] as const) {
      const ok = {
        ...workedExample,
        embedder: { ...workedExample.embedder, provider },
      };
      const result = repoConfigSchema.safeParse(ok);
      expect(result.success).toBe(true);
    }
  });

  it("rejects a capture section missing max_span_bytes", () => {
    const bad = {
      ...workedExample,
      capture: { enabled: true, never_capture: [] },
    };
    const result = repoConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("preserves unknown fields (forward-compat, DATA_MODEL.md §6)", () => {
    const withExtra = { ...workedExample, from_the_future: "wow" };
    const result = repoConfigSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from_the_future).toBe("wow");
    }
  });
});

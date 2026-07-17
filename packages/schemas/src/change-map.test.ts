import { describe, expect, it } from "vitest";
import { changeMapEntrySchema } from "./change-map.js";

// Worked example from architecture/DATA_MODEL.md §4.4. Note: the doc's
// second history entry ("3d4e5f...455667") is transcribed with 41 hex
// characters rather than 40 (a documentation typo) -- corrected here to a
// valid 40-hex SHA since DATA_MODEL.md's own field table defines `history`
// as `array<hex(40)>` and every other SHA in the spec is exactly 40 chars.
const workedExample = {
  schema: "git-for-ai/change-map-entry@1",
  change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
  head: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
  history: [
    "a0f1c2d3e4f5061728394a5b6c7d8e9f00112233",
    "3d4e5f60718293a4b5c6d7e8f900112233445566",
    "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
  ],
  trailer_seen: true,
  origin: "post-rewrite",
  updated_at: "2026-07-17T09:40:12Z",
};

describe("changeMapEntrySchema", () => {
  it("parses the DATA_MODEL.md §4.4 worked example", () => {
    const result = changeMapEntrySchema.safeParse(workedExample);
    expect(result.success).toBe(true);
  });

  it("parses the ARCHITECTURE.md §6.3 worked example", () => {
    // ARCHITECTURE.md §6.3's summary snippet omits `schema` (it's a summary
    // shape, not the authority — DATA_MODEL.md's header states every record
    // carries a `schema` field, so it's added here to reflect a real record).
    const architectureExample = {
      schema: "git-for-ai/change-map-entry@1",
      change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
      head: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      history: [
        "a0f1c2d3e4f5061728394a5b6c7d8e9f00112233",
        "3d4e5f60718293a4b5c6d7e8f900112233445566",
        "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      ],
      trailer_seen: true,
      origin: "post-commit",
      updated_at: "2026-07-17T09:22:41Z",
    };
    const result = changeMapEntrySchema.safeParse(architectureExample);
    expect(result.success).toBe(true);
  });

  it("rejects an entry with an unrecognized major schema version", () => {
    const bad = { ...workedExample, schema: "git-for-ai/change-map-entry@99" };
    const result = changeMapEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  for (const field of [
    "schema",
    "change_id",
    "head",
    "history",
    "trailer_seen",
    "origin",
    "updated_at",
  ] as const) {
    it(`rejects an entry missing required field "${field}"`, () => {
      const clone: Record<string, unknown> = { ...workedExample };
      delete clone[field];
      const result = changeMapEntrySchema.safeParse(clone);
      expect(result.success).toBe(false);
    });
  }

  it("rejects an entry with an invalid origin value", () => {
    const bad = { ...workedExample, origin: "some-other-thing" };
    const result = changeMapEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts an entry with folded_into/absorbed/divergent_heads set", () => {
    const withMerge = {
      ...workedExample,
      absorbed: ["3d1f0a2b4c6d8e0f1a2b3c4d5e6f7081"],
      divergent_heads: [
        "a0f1c2d3e4f5061728394a5b6c7d8e9f00112233",
        "3d4e5f60718293a4b5c6d7e8f900112233445566",
      ],
    };
    const result = changeMapEntrySchema.safeParse(withMerge);
    expect(result.success).toBe(true);
  });

  it("rejects a folded_into that isn't a valid 32-hex change-id", () => {
    const bad = { ...workedExample, folded_into: "not-a-change-id" };
    const result = changeMapEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("preserves unknown fields (forward-compat, DATA_MODEL.md §6)", () => {
    const withExtra = { ...workedExample, from_the_future: "wow" };
    const result = changeMapEntrySchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from_the_future).toBe("wow");
    }
  });
});

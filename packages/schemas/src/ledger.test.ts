import { describe, expect, it } from "vitest";
import {
  ledgerEntrySchema,
  ledgerNoteSchema,
  ledgerNoteLineSchema,
  LEDGER_NOTE_JSONL_SCHEMA,
} from "./ledger.js";

// Worked example from architecture/DATA_MODEL.md §2.6.
const workedNoteExample = {
  schema: "git-for-ai/ledger-note@1",
  change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
  entries: [
    {
      schema: "git-for-ai/ledger-entry@1",
      change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
      revision: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      created_at: "2026-07-17T09:22:41Z",
      author: {
        type: "agent",
        tool: "claude-code",
        model: "claude-opus-4-8",
        human: "dev@example.com",
      },
      scope: [
        {
          path: "src/auth/session.rs",
          range: [40, 118],
          blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
        },
      ],
      summary: "Switch session store from in-proc map to signed-cookie tokens.",
      reasoning: {
        intent:
          "Make auth stateless so the API can run >1 replica without sticky sessions.",
        constraints: [
          "must not break existing /login clients",
          "no new infra services",
        ],
        rejected: [
          {
            option: "Redis session store",
            why: "adds an infra dependency we explicitly want to avoid",
          },
        ],
        confidence: 0.82,
        scope_risk: "medium",
        reversibility: "easy",
        directive: "make auth work across multiple replicas",
        tested: ["cargo test auth::", "manual: login/logout round-trip"],
        related: [
          "3d1f0a2b4c6d8e0f1a2b3c4d5e6f7081",
          "c/7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4",
        ],
      },
      session_ref:
        "sha256:1f4e9caa77bb33cc22dd11ee00ff9988aabbccddeeff00112233445566778899",
      provenance: "agent-captured",
    },
  ],
};

// ARCHITECTURE.md §6.1 worked example (a slightly different/summarized shape,
// without session_ref/nested note envelope) — validate the single entry.
const architectureSummaryEntry = {
  schema: "git-for-ai/ledger-entry@1",
  change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
  revision: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
  created_at: "2026-07-17T09:22:41Z",
  author: {
    type: "agent",
    tool: "claude-code",
    model: "claude-opus-4-8",
    human: "dev@example.com",
  },
  scope: [
    {
      path: "src/auth/session.rs",
      range: [40, 118],
      blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
    },
  ],
  summary: "Switch session store from in-proc map to signed-cookie tokens.",
  reasoning: {
    intent:
      "Make auth stateless so we can run >1 API replica without sticky sessions.",
    constraints: [
      "must not break existing /login clients",
      "no new infra services",
    ],
    rejected: [
      {
        option: "Redis session store",
        why: "adds an infra dependency we explicitly want to avoid",
      },
    ],
    confidence: 0.82,
    scope_risk: "medium",
    reversibility: "easy",
    tested: ["cargo test auth::", "manual: login/logout round-trip"],
    related: ["3d1f0a2b4c6d8e0f1a2b3c4d5e6f7081", "c/7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4"],
  },
  session_ref:
    "sha256:1f4e9caa77bb33cc22dd11ee00ff9988aabbccddeeff00112233445566778899",
  provenance: "agent-captured",
};

describe("ledgerNoteSchema", () => {
  it("parses the DATA_MODEL.md §2.6 worked example", () => {
    const result = ledgerNoteSchema.safeParse(workedNoteExample);
    expect(result.success).toBe(true);
  });

  it("rejects a note with an unrecognized major schema version", () => {
    const bad = {
      ...workedNoteExample,
      schema: "git-for-ai/ledger-note@99",
    };
    const result = ledgerNoteSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a note missing the required change_id field", () => {
    const { change_id, ...rest } = workedNoteExample;
    const result = ledgerNoteSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a note whose entries array is empty", () => {
    const bad = { ...workedNoteExample, entries: [] };
    const result = ledgerNoteSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts the current JSONL-era envelope tag (@2) as an in-memory shape", () => {
    const current = { ...workedNoteExample, schema: LEDGER_NOTE_JSONL_SCHEMA };
    expect(ledgerNoteSchema.safeParse(current).success).toBe(true);
  });
});

describe("ledgerNoteLineSchema (JSONL wire format)", () => {
  const line = {
    schema: LEDGER_NOTE_JSONL_SCHEMA,
    change_id: workedNoteExample.change_id,
    entry: workedNoteExample.entries[0],
  };

  it("parses a well-formed note line", () => {
    expect(ledgerNoteLineSchema.safeParse(line).success).toBe(true);
  });

  it("rejects a line with the legacy envelope tag", () => {
    const bad = { ...line, schema: "git-for-ai/ledger-note@1" };
    expect(ledgerNoteLineSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a line carrying an entries array instead of one entry", () => {
    const bad = {
      schema: LEDGER_NOTE_JSONL_SCHEMA,
      change_id: workedNoteExample.change_id,
      entries: workedNoteExample.entries,
    };
    expect(ledgerNoteLineSchema.safeParse(bad).success).toBe(false);
  });

  it("preserves unknown fields on the line wrapper (forward-compat)", () => {
    const withExtra = { ...line, merged_from: "clone-b" };
    const result = ledgerNoteLineSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)["merged_from"]).toBe("clone-b");
    }
  });
});

describe("ledgerEntrySchema", () => {
  it("parses the ARCHITECTURE.md §6.1 worked example entry", () => {
    const result = ledgerEntrySchema.safeParse(architectureSummaryEntry);
    expect(result.success).toBe(true);
  });

  it("parses a minimal entry with only required fields (no reasoning)", () => {
    const minimal = {
      schema: "git-for-ai/ledger-entry@1",
      change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
      revision: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      created_at: "2026-07-17T09:22:41Z",
      author: { type: "human", human: "dev@example.com" },
      scope: [
        {
          path: "README.md",
          blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
        },
      ],
      summary: "Fix typo.",
      provenance: "human-authored",
    };
    const result = ledgerEntrySchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognized major schema version", () => {
    const bad = { ...architectureSummaryEntry, schema: "git-for-ai/ledger-entry@99" };
    const result = ledgerEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  for (const field of [
    "schema",
    "change_id",
    "revision",
    "created_at",
    "author",
    "scope",
    "summary",
    "provenance",
  ] as const) {
    it(`rejects an entry missing required field "${field}"`, () => {
      const clone: Record<string, unknown> = { ...architectureSummaryEntry };
      delete clone[field];
      const result = ledgerEntrySchema.safeParse(clone);
      expect(result.success).toBe(false);
    });
  }

  it("rejects an entry with a malformed change_id (not 32 hex chars)", () => {
    const bad = { ...architectureSummaryEntry, change_id: "not-hex" };
    const result = ledgerEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an entry with a malformed revision (not 40 hex chars)", () => {
    const bad = { ...architectureSummaryEntry, revision: "abc123" };
    const result = ledgerEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an entry with an invalid provenance value", () => {
    const bad = { ...architectureSummaryEntry, provenance: "guessed" };
    const result = ledgerEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a scope item missing the required blob field", () => {
    const bad = {
      ...architectureSummaryEntry,
      scope: [{ path: "src/auth/session.rs", range: [40, 118] }],
    };
    const result = ledgerEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts a scope item without a range (whole file)", () => {
    const ok = {
      ...architectureSummaryEntry,
      scope: [
        {
          path: "src/auth/session.rs",
          blob: "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f",
        },
      ],
    };
    const result = ledgerEntrySchema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it("preserves unknown fields (forward-compat, DATA_MODEL.md §6)", () => {
    const withExtra = { ...architectureSummaryEntry, from_the_future: "wow" };
    const result = ledgerEntrySchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from_the_future).toBe("wow");
    }
  });
});

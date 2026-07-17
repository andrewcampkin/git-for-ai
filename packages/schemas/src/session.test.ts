import { describe, expect, it } from "vitest";
import { sessionRecordSchema } from "./session.js";

// Worked example from architecture/DATA_MODEL.md §3.4.
const workedExample = {
  schema: "git-for-ai/session@1",
  session_id: "b1e2c3d4-5678-90ab-cdef-1234567890ab",
  agent: { tool: "claude-code", version: "2.x", model: "claude-opus-4-8" },
  captured_at: "2026-07-17T09:22:41Z",
  commit_range: {
    since: "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334",
    until: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
  },
  redaction: {
    applied: true,
    rules: ["aws-key", "generic-token"],
    redacted_count: 3,
    truncated_count: 0,
  },
  source_fingerprint: "claude-code-jsonl/2026.07",
  spans: [
    {
      span_id: "s1",
      kind: "agent.plan",
      start: "2026-07-17T09:05:00Z",
      end: "2026-07-17T09:05:02Z",
      body: {
        plan: "1. Extract session logic into session.rs\n2. Replace in-proc map with signed cookie\n3. Add tests",
      },
    },
    {
      span_id: "s2",
      parent_id: "s1",
      kind: "gen_ai.tool.execution",
      name: "Edit",
      attributes: { file: "src/auth/session.rs" },
      body: { diff_summary: "replace HashMap store with cookie codec" },
    },
    {
      span_id: "s3",
      parent_id: "s1",
      kind: "gen_ai.tool.execution",
      name: "Bash",
      attributes: { command: "cargo test auth::" },
      body: { exit: 0 },
    },
    {
      span_id: "s4",
      kind: "gen_ai.completion",
      body: {
        text: "Chose signed cookies over Redis to avoid a new infra dependency «redacted:generic-token»",
      },
    },
  ],
  summary:
    "Agent refactored auth to stateless signed-cookie sessions; rejected Redis to avoid infra dep; tests pass.",
};

describe("sessionRecordSchema", () => {
  it("parses the DATA_MODEL.md §3.4 worked example", () => {
    const result = sessionRecordSchema.safeParse(workedExample);
    expect(result.success).toBe(true);
  });

  it("parses the ARCHITECTURE.md §6.2 worked example (redaction without truncated_count)", () => {
    // ARCHITECTURE.md's summary example omits truncated_count and summary,
    // and uses a 3-span array without parent_id on the completion span.
    const architectureExample = {
      schema: "git-for-ai/session@1",
      session_id: "b1e2...",
      agent: { tool: "claude-code", version: "...", model: "claude-opus-4-8" },
      captured_at: "2026-07-17T09:22:41Z",
      commit_range: {
        since: "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334",
        until: "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      },
      redaction: {
        applied: true,
        rules: ["aws-key", "generic-token"],
        redacted_count: 3,
      },
      source_fingerprint: "claude-code-jsonl/2026.07",
      spans: [
        {
          span_id: "s1",
          kind: "agent.plan",
          start: "2026-07-17T09:05:00Z",
          end: "2026-07-17T09:05:02Z",
          body: { plan: "1. extract session module ... 2. ..." },
        },
        {
          span_id: "s2",
          kind: "gen_ai.tool.execution",
          name: "Edit",
          attributes: { file: "src/auth/session.rs" },
          body: { diff_summary: "..." },
        },
        {
          span_id: "s3",
          kind: "gen_ai.completion",
          body: { text: "<redacted-or-summarized model turn>" },
        },
      ],
    };
    const result = sessionRecordSchema.safeParse(architectureExample);
    expect(result.success).toBe(true);
  });

  it("rejects a session record with an unrecognized major schema version", () => {
    const bad = { ...workedExample, schema: "git-for-ai/session@99" };
    const result = sessionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  for (const field of [
    "schema",
    "session_id",
    "agent",
    "captured_at",
    "commit_range",
    "redaction",
    "source_fingerprint",
    "spans",
  ] as const) {
    it(`rejects a session record missing required field "${field}"`, () => {
      const clone: Record<string, unknown> = { ...workedExample };
      delete clone[field];
      const result = sessionRecordSchema.safeParse(clone);
      expect(result.success).toBe(false);
    });
  }

  it("rejects a span missing the required kind field", () => {
    const bad = {
      ...workedExample,
      spans: [{ span_id: "s1" }],
    };
    const result = sessionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a span with an unrecognized kind value", () => {
    const bad = {
      ...workedExample,
      spans: [{ span_id: "s1", kind: "gen_ai.something_else" }],
    };
    const result = sessionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a commit_range missing the required until field", () => {
    const bad = {
      ...workedExample,
      commit_range: { since: workedExample.commit_range.since },
    };
    const result = sessionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("preserves unknown fields (forward-compat, DATA_MODEL.md §6)", () => {
    const withExtra = { ...workedExample, from_the_future: "wow" };
    const result = sessionRecordSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from_the_future).toBe("wow");
    }
  });
});

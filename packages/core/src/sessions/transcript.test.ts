// Unit tests for the versioned Claude Code transcript adapter (./transcript.ts):
// a synthetic but format-accurate JSONL fixture normalizes into the DATA_MODEL.md §3.3
// span shapes; slicing honors the line marker; malformed lines are skipped, not thrown
// on; and an unrecognizable file degrades (`ok: false`) instead of crashing (§10.2).

import { describe, expect, it } from "vitest";

import { parseTranscriptSlice } from "./transcript.js";

/** A hand-written, format-accurate transcript: plan, edits, a bash run, a text turn. */
const FIXTURE_LINES = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-07-17T09:04:55.000Z",
    message: { content: [{ type: "text", text: "please make auth stateless" }] },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-17T09:05:00.000Z",
    version: "2.0.13",
    message: {
      model: "claude-opus-4-8",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "ExitPlanMode",
          input: { plan: "1. Extract session logic\n2. Replace map with signed cookie\n3. Tests" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-17T09:06:10.000Z",
    message: {
      model: "claude-opus-4-8",
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: "src/auth/session.ts", old_string: "a", new_string: "b" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-17T09:07:00.000Z",
    message: {
      model: "claude-opus-4-8",
      content: [
        { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-17T09:08:00.000Z",
    message: {
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "Done — chose signed cookies over Redis." }],
    },
  }),
];

const FIXTURE = `${FIXTURE_LINES.join("\n")}\n`;

describe("parseTranscriptSlice — happy path", () => {
  it("normalizes plan / tool / completion blocks into §3.3 spans, in order", () => {
    const result = parseTranscriptSlice(FIXTURE);
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);

    expect(result.spans.map((s) => s.kind)).toEqual([
      "agent.plan",
      "gen_ai.tool.execution",
      "gen_ai.tool.execution",
      "gen_ai.completion",
    ]);

    const [plan, edit, bash, completion] = result.spans;
    expect(plan!.body!["plan"]).toContain("Extract session logic");
    expect(plan!.start).toBe("2026-07-17T09:05:00.000Z");

    expect(edit!.name).toBe("Edit");
    expect(edit!.attributes).toEqual({ file: "src/auth/session.ts" });

    expect(bash!.name).toBe("Bash");
    expect(bash!.attributes).toEqual({ command: "pnpm test" });

    expect(completion!.body!["text"]).toContain("signed cookies over Redis");

    // span ids unique within the record
    expect(new Set(result.spans.map((s) => s.span_id)).size).toBe(result.spans.length);

    expect(result.totalLines).toBe(5);
    expect(result.skippedLines).toBe(0);
    expect(result.meta).toEqual({ model: "claude-opus-4-8", version: "2.0.13" });
  });

  it("slices from a line marker (only content after `sinceLine` is captured)", () => {
    const result = parseTranscriptSlice(FIXTURE, { sinceLine: 3 });
    if (!result.ok) throw new Error("expected ok");
    // lines 4-5 remain: the Bash tool_use and the text turn.
    expect(result.spans.map((s) => s.kind)).toEqual(["gen_ai.tool.execution", "gen_ai.completion"]);
    expect(result.totalLines).toBe(5);
  });

  it("a marker beyond the file falls back to the whole transcript (rotation-safe)", () => {
    const result = parseTranscriptSlice(FIXTURE, { sinceLine: 999 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.spans.length).toBe(4);
  });

  it("an empty slice (nothing new since the marker) is ok with zero spans", () => {
    const result = parseTranscriptSlice(FIXTURE, { sinceLine: 5 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.spans).toEqual([]);
  });
});

describe("parseTranscriptSlice — defensive parsing (§10.2)", () => {
  it("skips (and counts) malformed lines without throwing", () => {
    const withGarbage = [FIXTURE_LINES[1], "{not json at all", '{"noTypeField": true}', FIXTURE_LINES[4]].join("\n");
    const result = parseTranscriptSlice(withGarbage);
    if (!result.ok) throw new Error("expected ok");
    expect(result.spans.map((s) => s.kind)).toEqual(["agent.plan", "gen_ai.completion"]);
    expect(result.skippedLines).toBe(2);
  });

  it("a completely unrecognizable file degrades to ok:false with a reason", () => {
    const result = parseTranscriptSlice("plain text log\nanother line\nnot a transcript\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected degrade");
    expect(result.reason).toContain("not recognized");
  });

  it("an empty file is ok with zero spans (nothing to capture, not a format error)", () => {
    const result = parseTranscriptSlice("");
    if (!result.ok) throw new Error("expected ok");
    expect(result.spans).toEqual([]);
    expect(result.totalLines).toBe(0);
  });

  it("tolerates blocks with unexpected shapes inside a recognizable line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use" /* no name */, input: {} },
          { type: "text" /* no text */ },
          "not-an-object",
          { type: "tool_use", name: "ExitPlanMode", input: { plan: 42 } }, // non-string plan
        ],
      },
    });
    const result = parseTranscriptSlice(`${line}\n`);
    if (!result.ok) throw new Error("expected ok");
    expect(result.spans).toEqual([]); // nothing usable, but no crash and no skip-count
    expect(result.skippedLines).toBe(0);
  });
});

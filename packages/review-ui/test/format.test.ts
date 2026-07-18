// Degradation labeling / rendering helpers — the honesty labels must match report.ts's
// wording exactly (this SPA is the report page made live).

import { describe, expect, it } from "vitest";

import type { Span } from "../src/types";
import {
  flagParts,
  fmtWhen,
  sessionLine,
  sessionLineFromShow,
  sourceTag,
  spanHeadline,
} from "../src/lib/format";

describe("fmtWhen", () => {
  it("renders date + minutes from RFC 3339", () => {
    expect(fmtWhen("2026-07-18T09:22:41Z")).toBe("2026-07-18 09:22");
    expect(fmtWhen("2026-07-18T09:22:41+10:00")).toBe("2026-07-18 09:22");
  });
  it("passes degraded input through as-is, never guessing", () => {
    expect(fmtWhen("not-a-date")).toBe("not-a-date");
    expect(fmtWhen("")).toBe("");
  });
});

describe("sourceTag (honest degradation labels, verbatim from report.ts)", () => {
  it("labels each summary source", () => {
    expect(sourceTag("ledger")).toBeNull();
    expect(sourceTag("git-subject")).toBe(
      "no captured intent — showing the commit's own git subject",
    );
    expect(sourceTag("git-subject-note-unreadable")).toBe(
      "ledger note unreadable — showing the commit's own git subject",
    );
  });
});

describe("flagParts", () => {
  it("renders only the flags that are present — absent flags are absent, not defaulted", () => {
    expect(flagParts({})).toEqual([]);
    expect(flagParts({ confidence: 0.82 })).toEqual(["conf 0.82"]);
    expect(
      flagParts({ confidence: 0.5, scopeRisk: "high", reversibility: "moderate" }),
    ).toEqual(["conf 0.50", "risk high", "undo moderate"]);
  });
});

describe("sessionLine", () => {
  it("labels the three statuses honestly", () => {
    expect(sessionLine({ ref: null, status: "none" })).toBe("no session captured");
    expect(
      sessionLine({ ref: "sha256:ab", status: "unavailable", reason: "ref missing" }),
    ).toBe("session trace unavailable — ref missing");
    expect(
      sessionLine({
        ref: "sha256:ab",
        status: "available",
        agentTool: "claude-code",
        agentVersion: "2.x",
        agentModel: "claude-opus-4-8",
        spanCount: 2,
        capturedAt: "2026-07-17T09:22:41Z",
      }),
    ).toBe("claude-code 2.x (claude-opus-4-8) · 2 spans · captured 2026-07-17 09:22");
  });
});

describe("sessionLineFromShow", () => {
  it("adapts show.ts's nested-record shape", () => {
    expect(sessionLineFromShow({ ref: null, status: "none" })).toBe("no session captured");
    expect(
      sessionLineFromShow({ ref: "sha256:ab", status: "unavailable", reason: "gone" }),
    ).toBe("session trace unavailable — gone");
    expect(
      sessionLineFromShow({
        ref: "sha256:ab",
        status: "available",
        record: {
          schema: "git-for-ai/session@1",
          session_id: "s",
          agent: { tool: "claude-code", version: "2.x", model: "claude-opus-4-8" },
          captured_at: "2026-07-17T09:22:41Z",
          commit_range: { since: "a".repeat(40), until: "a".repeat(40) },
          redaction: { applied: true, rules: [], redacted_count: 0 },
          source_fingerprint: "f",
          spans: [{ span_id: "s1", kind: "agent.plan" }],
        },
      }),
    ).toBe("claude-code 2.x (claude-opus-4-8) · 1 span · captured 2026-07-17 09:22");
  });
});

describe("spanHeadline", () => {
  it("prefers the command attribute, then file-ish attributes", () => {
    const span: Span = {
      span_id: "s1",
      kind: "gen_ai.tool.execution",
      name: "Bash",
      attributes: { command: "pnpm test auth", file: "ignored.ts" },
    };
    expect(spanHeadline(span)).toBe("pnpm test auth");
    expect(
      spanHeadline({
        span_id: "s2",
        kind: "gen_ai.tool.execution",
        name: "Edit",
        attributes: { file: "src/auth/session.ts" },
      }),
    ).toBe("src/auth/session.ts");
  });

  it("falls back to the first line of a plan/text body, truncated", () => {
    expect(
      spanHeadline({
        span_id: "s3",
        kind: "agent.plan",
        body: { plan: "1. Do the thing\n2. Then more" },
      }),
    ).toBe("1. Do the thing");
    const long = "x".repeat(200);
    expect(spanHeadline({ span_id: "s4", kind: "agent.plan", body: { plan: long } })).toBe(
      `${"x".repeat(117)}…`,
    );
  });

  it("returns null when nothing headline-worthy exists — never invents a description", () => {
    expect(spanHeadline({ span_id: "s5", kind: "agent.step" })).toBeNull();
  });
});

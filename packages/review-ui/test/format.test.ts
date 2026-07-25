// Degradation labeling / rendering helpers — the honesty labels must match report.ts's
// wording exactly (this SPA is the report page made live).

import { describe, expect, it } from "vitest";

import type { Span } from "../src/types";
import {
  dayHeading,
  flagParts,
  fmtTime,
  fmtWhen,
  isNoteworthyProvenance,
  sessionLine,
  sessionLineFromShow,
  sourceTag,
  spanHeadline,
  spanKindLabel,
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

describe("fmtTime", () => {
  it("renders just the minutes from RFC 3339, for rows under a day heading", () => {
    expect(fmtTime("2026-07-18T09:22:41Z")).toBe("09:22");
  });
  it("passes degraded input through as-is, never guessing", () => {
    expect(fmtTime("not-a-date")).toBe("not-a-date");
  });
});

describe("dayHeading (v2 day-grouped timeline)", () => {
  it("labels today and yesterday relative to the injected today", () => {
    expect(dayHeading("2026-07-19", "2026-07-19")).toBe("Today · 2026-07-19");
    expect(dayHeading("2026-07-18", "2026-07-19")).toBe("Yesterday · 2026-07-18");
    // month boundary
    expect(dayHeading("2026-06-30", "2026-07-01")).toBe("Yesterday · 2026-06-30");
  });
  it("renders older days plainly and the degraded-day group honestly", () => {
    expect(dayHeading("2026-07-10", "2026-07-19")).toBe("2026-07-10");
    expect(dayHeading("", "2026-07-19")).toBe("date unavailable");
  });
});

describe("isNoteworthyProvenance", () => {
  it("keeps the normal cases quiet and surfaces inferred", () => {
    expect(isNoteworthyProvenance("agent-captured")).toBe(false);
    expect(isNoteworthyProvenance("human-authored")).toBe(false);
    expect(isNoteworthyProvenance("inferred")).toBe(true);
  });
});

describe("sourceTag (honest degradation labels, verbatim from report.ts)", () => {
  it("labels each summary source", () => {
    expect(sourceTag("ledger")).toBeNull();
    expect(sourceTag("git-subject")).toBe(
      "no reasoning recorded — showing the commit message",
    );
    expect(sourceTag("git-subject-note-unreadable")).toBe(
      "note unreadable — showing the commit message",
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
    ).toBe("no session record available — ref missing");
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
    ).toBe("claude-code 2.x (claude-opus-4-8) · 2 steps · captured 2026-07-17 09:22");
  });
});

describe("sessionLineFromShow", () => {
  it("adapts show.ts's nested-record shape", () => {
    expect(sessionLineFromShow({ ref: null, status: "none" })).toBe("no session captured");
    expect(
      sessionLineFromShow({ ref: "sha256:ab", status: "unavailable", reason: "gone" }),
    ).toBe("no session record available — gone");
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
    ).toBe("claude-code 2.x (claude-opus-4-8) · 1 step · captured 2026-07-17 09:22");
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

describe("spanKindLabel", () => {
  it("renders each known kind in plain words", () => {
    expect(spanKindLabel("agent.plan")).toBe("plan");
    expect(spanKindLabel("gen_ai.completion")).toBe("response");
    expect(spanKindLabel("gen_ai.tool.execution")).toBe("tool use");
    expect(spanKindLabel("agent.step")).toBe("step");
  });

  it("passes an unrecognized kind through as-is, never guessing", () => {
    expect(spanKindLabel("something.new")).toBe("something.new");
  });
});

// Tests for the annotate form's rules (src/lib/annotate.ts). The form is the one place a
// human AUTHORS a ledger record instead of reading one, so what is under test is that
// nothing reaches the ledger half-written and nothing the person typed is silently
// dropped — the same honesty contract the read path holds itself to.

import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  buildAnnotateBody,
  draftFromEntry,
  lines,
  type AnnotateDraft,
} from "../src/lib/annotate";

const draft = (overrides: Partial<AnnotateDraft> = {}): AnnotateDraft => ({
  ...EMPTY_DRAFT,
  summary: "Move session state to signed cookies",
  ...overrides,
});

describe("lines", () => {
  it("trims, drops blanks, and keeps order", () => {
    expect(lines("  pnpm test \n\n  pnpm build\n \n")).toEqual(["pnpm test", "pnpm build"]);
  });
});

describe("buildAnnotateBody", () => {
  it("sends only what was filled in, plus the target", () => {
    const result = buildAnnotateBody("c/abc123", draft());
    expect(result).toEqual({
      ok: true,
      body: { target: "c/abc123", summary: "Move session state to signed cookies" },
    });
  });

  it("carries the whole reasoning vocabulary when it is filled in", () => {
    const result = buildAnnotateBody(
      "HEAD",
      draft({
        intent: "run more than one replica without sticky sessions",
        constraints: "no new infrastructure\nmust survive a restart",
        rejected: [{ option: "Redis session store", why: "avoid an infra dependency" }],
        tested: "pnpm turbo test\nmanual login round-trip",
        confidence: "0.82",
        scopeRisk: "medium",
        reversibility: "easy",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      target: "HEAD",
      summary: "Move session state to signed cookies",
      intent: "run more than one replica without sticky sessions",
      constraints: ["no new infrastructure", "must survive a restart"],
      // The CLI's repeatable-flag encoding, rebuilt exactly.
      rejected: ["Redis session store::avoid an infra dependency"],
      tested: ["pnpm turbo test", "manual login round-trip"],
      confidence: 0.82,
      scopeRisk: "medium",
      reversibility: "easy",
    });
  });

  it("requires a summary — an entry without one records nothing", () => {
    const result = buildAnnotateBody("HEAD", draft({ summary: "   " }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("summary is required") });
  });

  it("refuses half a rejected alternative rather than recording half a reason", () => {
    const missingWhy = buildAnnotateBody("HEAD", draft({ rejected: [{ option: "Redis", why: "" }] }));
    expect(missingWhy.ok).toBe(false);
    const missingOption = buildAnnotateBody(
      "HEAD",
      draft({ rejected: [{ option: "", why: "too slow" }] }),
    );
    expect(missingOption.ok).toBe(false);
    if (missingOption.ok) return;
    expect(missingOption.error).toContain("both parts");
  });

  it("ignores an untouched rejected row", () => {
    const result = buildAnnotateBody("HEAD", draft({ rejected: [{ option: "  ", why: "" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body["rejected"]).toBeUndefined();
  });

  it("refuses '::' in a rejected option — the CLI splits on it", () => {
    const result = buildAnnotateBody(
      "HEAD",
      draft({ rejected: [{ option: "a::b", why: "because" }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("'::'");
  });

  it("rejects a confidence that is not a 0–1 number", () => {
    for (const confidence of ["high", "1.5", "-0.2"]) {
      const result = buildAnnotateBody("HEAD", draft({ confidence }));
      expect(result.ok, confidence).toBe(false);
    }
    // The boundaries themselves are fine.
    for (const confidence of ["0", "1", "0.5"]) {
      expect(buildAnnotateBody("HEAD", draft({ confidence })).ok, confidence).toBe(true);
    }
  });

  it("omits empty optional fields entirely rather than sending blanks", () => {
    const result = buildAnnotateBody(
      "HEAD",
      draft({ intent: "   ", constraints: "\n\n", tested: " ", confidence: "  " }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.body).sort()).toEqual(["summary", "target"]);
  });
});

describe("draftFromEntry", () => {
  it("round-trips a recorded entry back into an editable draft", () => {
    const entry = {
      summary: "Move session state to signed cookies",
      reasoning: {
        intent: "multi-replica",
        constraints: ["no new infra"],
        rejected: [{ option: "Redis", why: "infra dependency" }],
        tested: ["pnpm turbo test"],
        confidence: 0.82,
        scope_risk: "medium",
        reversibility: "easy",
      },
    };
    const built = buildAnnotateBody("HEAD", draftFromEntry(entry));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({
      target: "HEAD",
      summary: "Move session state to signed cookies",
      intent: "multi-replica",
      constraints: ["no new infra"],
      rejected: ["Redis::infra dependency"],
      tested: ["pnpm turbo test"],
      confidence: 0.82,
      scopeRisk: "medium",
      reversibility: "easy",
    });
  });

  it("survives an entry with no reasoning at all", () => {
    expect(draftFromEntry({ summary: "just a summary" })).toEqual({
      ...EMPTY_DRAFT,
      summary: "just a summary",
    });
  });

  it("drops an out-of-vocabulary risk/reversibility rather than putting it in a select", () => {
    const result = draftFromEntry({
      summary: "s",
      reasoning: { scope_risk: "catastrophic", reversibility: "never" },
    });
    expect(result.scopeRisk).toBe("");
    expect(result.reversibility).toBe("");
  });
});

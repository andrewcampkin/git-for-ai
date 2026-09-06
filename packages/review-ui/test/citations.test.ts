// Tests for lib/citations.ts — the [n]-marker splitter behind the live ask panel's
// linked citations. Mirrors core synthesis.ts's extractCitations contract.

import { describe, expect, it } from "vitest";

import { splitCitations } from "../src/lib/citations";

describe("splitCitations", () => {
  it("splits text and in-range citations, preserving order and duplicates", () => {
    expect(splitCitations("Rejected in [1]; confirmed by [2] and again [1].", 2)).toEqual([
      { kind: "text", text: "Rejected in " },
      { kind: "citation", n: 1 },
      { kind: "text", text: "; confirmed by " },
      { kind: "citation", n: 2 },
      { kind: "text", text: " and again " },
      { kind: "citation", n: 1 },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves out-of-range markers as literal text (never fabricates a link target)", () => {
    expect(splitCitations("See [3] maybe, but [1] is real.", 1)).toEqual([
      { kind: "text", text: "See [3] maybe, but " },
      { kind: "citation", n: 1 },
      { kind: "text", text: " is real." },
    ]);
    expect(splitCitations("Zero is invalid [0].", 5)).toEqual([
      { kind: "text", text: "Zero is invalid [0]." },
    ]);
  });

  it("handles answers with no markers, and markers at the edges", () => {
    expect(splitCitations("Plain prose.", 4)).toEqual([{ kind: "text", text: "Plain prose." }]);
    expect(splitCitations("[1] leads and trails [2]", 2)).toEqual([
      { kind: "citation", n: 1 },
      { kind: "text", text: " leads and trails " },
      { kind: "citation", n: 2 },
    ]);
    expect(splitCitations("", 2)).toEqual([]);
  });

  it("ignores non-numeric bracket text", () => {
    expect(splitCitations("An array [a, b] and [12x] stay text with [1].", 1)).toEqual([
      { kind: "text", text: "An array [a, b] and [12x] stay text with " },
      { kind: "citation", n: 1 },
      { kind: "text", text: "." },
    ]);
  });
});

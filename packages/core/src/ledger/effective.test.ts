// Pure unit tests for effective-entry resolution (DATA_MODEL.md §2.4): newest
// `created_at` wins; equal timestamps break by (author.human, revision, sha256(entry))
// lexicographic, greatest tuple winning. No git, no I/O.

import { describe, expect, it } from "vitest";

import type { LedgerEntry } from "@git-for-ai/schemas";

import { resolveEffectiveEntry } from "./effective.js";

const REVISION = "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70";

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schema: "git-for-ai/ledger-entry@1",
    change_id: "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
    revision: REVISION,
    created_at: "2026-07-17T09:22:41Z",
    author: { type: "agent", tool: "claude-code", human: "dev@example.com" },
    scope: [],
    summary: "a change",
    provenance: "agent-captured",
    ...overrides,
  };
}

describe("resolveEffectiveEntry", () => {
  it("returns the single entry unchanged", () => {
    const only = makeEntry();
    expect(resolveEffectiveEntry([only])).toBe(only);
  });

  it("picks the newest created_at regardless of array order", () => {
    const older = makeEntry({ created_at: "2026-07-17T09:22:41Z", summary: "older" });
    const newer = makeEntry({ created_at: "2026-07-18T00:00:00Z", summary: "newer" });

    expect(resolveEffectiveEntry([older, newer])).toBe(newer);
    expect(resolveEffectiveEntry([newer, older])).toBe(newer);
  });

  it("compares timestamps as instants, not strings (fractional seconds)", () => {
    // Lexicographic string comparison would order these incorrectly.
    const plain = makeEntry({ created_at: "2026-07-17T09:22:41Z", summary: "plain" });
    const fractional = makeEntry({ created_at: "2026-07-17T09:22:41.500Z", summary: "later" });

    expect(resolveEffectiveEntry([fractional, plain])).toBe(fractional);
  });

  it("breaks a timestamp tie by author.human (greatest wins), absent human sorting lowest", () => {
    const abe = makeEntry({ author: { type: "human", human: "abe@example.com" }, summary: "abe" });
    const zoe = makeEntry({ author: { type: "human", human: "zoe@example.com" }, summary: "zoe" });
    const anonymous = makeEntry({ author: { type: "human" }, summary: "anon" });

    expect(resolveEffectiveEntry([abe, zoe])).toBe(zoe);
    expect(resolveEffectiveEntry([zoe, abe])).toBe(zoe);
    expect(resolveEffectiveEntry([anonymous, abe])).toBe(abe);
  });

  it("breaks a timestamp + author tie by revision (greatest wins)", () => {
    const low = makeEntry({ revision: "0000000000000000000000000000000000000000" });
    const high = makeEntry({ revision: "ffffffffffffffffffffffffffffffffffffffff" });

    expect(resolveEffectiveEntry([low, high])).toBe(high);
    expect(resolveEffectiveEntry([high, low])).toBe(high);
  });

  it("breaks a full metadata tie by sha256 of the canonical entry, deterministically across orderings", () => {
    // Same created_at, same author.human, same revision — only the summary differs, so
    // only the sha256(entry) component can decide. Whatever it decides must not depend
    // on input order.
    const a = makeEntry({ summary: "variant a" });
    const b = makeEntry({ summary: "variant b" });

    const forward = resolveEffectiveEntry([a, b]);
    const reversed = resolveEffectiveEntry([b, a]);
    expect(forward).toBe(reversed);
    expect([a, b]).toContain(forward);
  });

  it("throws on an empty array (that case is readLedgerEntries returning null, not [])", () => {
    expect(() => resolveEffectiveEntry([])).toThrow(/at least one entry/);
  });
});

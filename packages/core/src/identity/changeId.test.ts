import { describe, expect, it } from "vitest";

import {
  mintChangeId,
  normalizeChangeId,
  parseChangeIdTrailer,
  formatChangeIdTrailer,
} from "./changeId.js";

describe("mintChangeId", () => {
  it("produces 32 lowercase hex characters (DATA_MODEL.md §1)", () => {
    const id = mintChangeId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces distinct ids (random, never content-derived — §7.7)", () => {
    expect(mintChangeId()).not.toBe(mintChangeId());
  });
});

describe("normalizeChangeId", () => {
  it("strips the leading I from our trailer form", () => {
    expect(normalizeChangeId("I9f2c1a7b6e4d0f83c5a1b2d3e4f50617")).toBe(
      "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
    );
  });

  it("lowercases uppercase hex", () => {
    expect(normalizeChangeId("I9F2C1A7B6E4D0F83C5A1B2D3E4F50617")).toBe(
      "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
    );
  });

  it("accepts a bare 32-hex id without the I prefix", () => {
    expect(normalizeChangeId("9f2c1a7b6e4d0f83c5a1b2d3e4f50617")).toBe(
      "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
    );
  });

  it("adopts a Gerrit 40-hex id by taking the first 32 hex chars (§7.6)", () => {
    const gerrit = "I7944e5ed80f6a3b5b70e7d76d69b9c4f52d0d1a9";
    expect(normalizeChangeId(gerrit)).toBe("7944e5ed80f6a3b5b70e7d76d69b9c4f");
  });

  it("rejects garbage", () => {
    expect(normalizeChangeId("not-a-change-id")).toBeNull();
    expect(normalizeChangeId("I123")).toBeNull();
    expect(normalizeChangeId("")).toBeNull();
  });
});

describe("parseChangeIdTrailer", () => {
  it("finds the trailer in a normal commit message", () => {
    const message = "feat: add widget\n\nSome body text.\n\nChange-Id: I9f2c1a7b6e4d0f83c5a1b2d3e4f50617";
    expect(parseChangeIdTrailer(message)).toBe("9f2c1a7b6e4d0f83c5a1b2d3e4f50617");
  });

  it("returns null when there is no trailer", () => {
    expect(parseChangeIdTrailer("feat: add widget\n\nno trailer here")).toBeNull();
  });

  it("returns null when the trailer value is unparseable", () => {
    expect(parseChangeIdTrailer("feat: x\n\nChange-Id: bogus")).toBeNull();
  });

  it("takes the last trailer when a message carries more than one (Gerrit copy-paste failure mode)", () => {
    const message = [
      "feat: pasted message",
      "",
      "Change-Id: Iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Change-Id: Ibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ].join("\n");
    expect(parseChangeIdTrailer(message)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

describe("formatChangeIdTrailer", () => {
  it("renders the frozen trailer form and round-trips through the parser", () => {
    const id = mintChangeId();
    const trailer = formatChangeIdTrailer(id);
    expect(trailer).toBe(`Change-Id: I${id}`);
    expect(parseChangeIdTrailer(`msg\n\n${trailer}`)).toBe(id);
  });

  it("rejects a malformed id rather than writing a bad trailer", () => {
    expect(() => formatChangeIdTrailer("NOT-HEX")).toThrow();
  });
});

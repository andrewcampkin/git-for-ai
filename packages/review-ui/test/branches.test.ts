// Branch-selector labeling: the honest-degradation rules restated for branches — an
// untracked branch says "not tracked" rather than borrowing the reassuring wording of a
// branch that is genuinely level with its upstream.

import { describe, expect, it } from "vitest";

import type { ReviewBranch } from "../src/types";
import { branchTitle, orderBranches, scopeLabel, trackLabel } from "../src/lib/branches";

function makeBranch(overrides: Partial<ReviewBranch> = {}): ReviewBranch {
  return {
    name: "main",
    ref: "refs/heads/main",
    sha: "1111111111111111111111111111111111111111",
    shortSha: "1111111",
    current: false,
    subject: "a commit",
    committerDate: "2026-07-19T10:00:00+00:00",
    upstream: null,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

describe("orderBranches", () => {
  it("puts the checked-out branch first and keeps the server's order after it", () => {
    const branches = [
      makeBranch({ name: "topic", ref: "refs/heads/topic" }),
      makeBranch({ name: "main", current: true }),
      makeBranch({ name: "old", ref: "refs/heads/old" }),
    ];
    expect(orderBranches(branches).map((b) => b.name)).toEqual(["main", "topic", "old"]);
  });

  it("is a no-op ordering when nothing is checked out (detached HEAD)", () => {
    const branches = [makeBranch({ name: "a" }), makeBranch({ name: "b" })];
    expect(orderBranches(branches).map((b) => b.name)).toEqual(["a", "b"]);
  });
});

describe("trackLabel", () => {
  it("distinguishes 'not tracked' from 'in sync'", () => {
    expect(trackLabel(makeBranch())).toBe("not tracked");
    expect(trackLabel(makeBranch({ upstream: "origin/main", ahead: 0, behind: 0 }))).toBe(
      "in sync with origin/main",
    );
  });

  it("reports divergence in both directions", () => {
    expect(trackLabel(makeBranch({ upstream: "origin/main", ahead: 2, behind: 0 }))).toBe(
      "2 ahead relative to origin/main",
    );
    expect(trackLabel(makeBranch({ upstream: "origin/main", ahead: 0, behind: 3 }))).toBe(
      "3 behind relative to origin/main",
    );
    expect(trackLabel(makeBranch({ upstream: "origin/main", ahead: 2, behind: 3 }))).toBe(
      "2 ahead, 3 behind relative to origin/main",
    );
  });
});

describe("branchTitle", () => {
  it("carries the tip subject and the upstream relationship", () => {
    const title = branchTitle(
      makeBranch({ subject: "Fix the parser", upstream: "origin/main", ahead: 1, behind: 0 }),
    );
    expect(title).toBe("1111111 Fix the parser — 1 ahead relative to origin/main");
  });

  it("labels an empty subject rather than rendering a blank", () => {
    expect(branchTitle(makeBranch({ subject: "" }))).toContain("(no subject)");
  });
});

describe("scopeLabel", () => {
  it("names the branch when one is selected", () => {
    expect(scopeLabel("feature/x", "main", false)).toBe("feature/x");
  });

  it("falls back to the checked-out branch, and says 'detached HEAD' when there is none", () => {
    expect(scopeLabel(null, "main", false)).toBe("main");
    expect(scopeLabel(null, null, true)).toBe("detached HEAD");
    expect(scopeLabel(null, null, false)).toBe("HEAD");
  });
});

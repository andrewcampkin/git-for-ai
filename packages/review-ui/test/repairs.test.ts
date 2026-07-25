// Tests for guided repair's planning rules (src/lib/repairs.ts). These actions rewrite
// identity records, so the assertions here are about restraint: the exact command is
// always derivable, an argument doctor cannot know is asked for rather than guessed, and
// a repair never plans itself into a half-specified state.

import { describe, expect, it } from "vitest";

import type { DoctorRepair } from "../src/types";
import {
  EMPTY_REPAIR_INPUT,
  planRepair,
  repairsFrom,
  seedRepairInput,
  shortChange,
} from "../src/lib/repairs";

const CHANGE_A = "3e15ffc5e25e6dd81440d1d8fe578630";
const CHANGE_B = "0f30b7b4e25e6dd81440d1d8fe578630";

const reconcile: DoctorRepair = {
  action: "reconcile",
  what: "Rebuild the links.",
  detach: false,
  needsCommit: false,
  changeIds: [CHANGE_A],
};
const repoint: DoctorRepair = {
  action: "relink",
  what: "Point the change at the commit that survived.",
  detach: false,
  needsCommit: true,
  changeIds: [CHANGE_A, CHANGE_B],
};
const detach: DoctorRepair = {
  action: "relink",
  what: "Detach a commit that isn't really part of this change.",
  detach: true,
  needsCommit: true,
  changeIds: [CHANGE_A],
};

describe("planRepair", () => {
  it("plans reconcile with no input at all", () => {
    expect(planRepair(reconcile, EMPTY_REPAIR_INPUT)).toEqual({
      ok: true,
      action: "reconcile",
      body: {},
      command: "git for-ai reconcile",
    });
  });

  it("plans a re-point as the exact CLI command it corresponds to", () => {
    const plan = planRepair(repoint, { changeId: CHANGE_A, commit: "2fe7d26" });
    expect(plan).toEqual({
      ok: true,
      action: "relink",
      body: { args: [CHANGE_A, "2fe7d26"] },
      command: `git for-ai relink ${CHANGE_A} 2fe7d26`,
    });
  });

  it("plans a detach without a change — the commit is the whole argument", () => {
    const plan = planRepair(detach, { changeId: "", commit: "2fe7d26" });
    expect(plan).toEqual({
      ok: true,
      action: "relink",
      body: { args: ["2fe7d26"], detach: true },
      command: "git for-ai relink --detach 2fe7d26",
    });
  });

  it("asks for the commit rather than guessing one", () => {
    const missing = planRepair(repoint, { changeId: CHANGE_A, commit: "   " });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("point at");

    const detaching = planRepair(detach, EMPTY_REPAIR_INPUT);
    expect(detaching.ok).toBe(false);
    if (detaching.ok) return;
    expect(detaching.error).toContain("detach");
  });

  it("asks which change to re-point when one was not chosen", () => {
    const plan = planRepair(repoint, { changeId: "", commit: "2fe7d26" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("which change");
  });

  it("refuses a commit that is more than one word", () => {
    const plan = planRepair(detach, { changeId: "", commit: "2fe7d26 && rm -rf /" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("single word");
  });

  it("trims what was typed rather than sending stray whitespace", () => {
    const plan = planRepair(detach, { changeId: "", commit: "  2fe7d26\n" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.body["args"]).toEqual(["2fe7d26"]);
  });
});

describe("seedRepairInput", () => {
  it("pre-selects a single candidate change — there is no choice to make", () => {
    expect(seedRepairInput({ ...repoint, changeIds: [CHANGE_A] })).toEqual({
      changeId: CHANGE_A,
      commit: "",
    });
  });

  it("leaves the change unselected when several are candidates", () => {
    expect(seedRepairInput(repoint)).toEqual({ changeId: "", commit: "" });
  });

  it("never seeds a change for a detach — the change is not an argument there", () => {
    expect(seedRepairInput(detach)).toEqual({ changeId: "", commit: "" });
  });
});

describe("repairsFrom", () => {
  it("collects repairs across checks, in report order, ignoring checks without any", () => {
    const collected = repairsFrom([
      { repairs: [reconcile] },
      {},
      { repairs: [repoint, detach] },
    ]);
    expect(collected).toEqual([reconcile, repoint, detach]);
  });
});

describe("shortChange", () => {
  it("renders the c/ short form the rest of the app uses", () => {
    expect(shortChange(CHANGE_A)).toBe("c/3e15ffc5");
  });
});

// Turning a checkup finding into a repair the person can actually run (DESKTOP.md §3
// item 4, "guided repair"). The analysis is doctor's — it publishes each finding's repair
// as data (`DoctorRepair`), so nothing here parses doctor's prose or re-derives which fix
// applies. This module only does the last mile: what to show, and what to POST.
//
// The rule that shapes all of it: **these actions rewrite identity records, so nothing
// runs without the person seeing the exact command first.** A repair with an argument
// doctor cannot know (which commit is the right one) asks for it rather than guessing —
// that judgement is the reason a human is looking at this screen at all.

import type { DoctorRepair } from "../types";

/** What the person has filled in for a repair that needs input. */
export interface RepairInput {
  /** The change to re-point (repoint form only). */
  changeId: string;
  /** The commit to point at, or to detach. */
  commit: string;
}

export const EMPTY_REPAIR_INPUT: RepairInput = { changeId: "", commit: "" };

export type RepairPlan =
  | { ok: true; action: string; body: Record<string, unknown>; command: string }
  | { ok: false; error: string };

/** Short id form used in the command preview and the change picker. */
export function shortChange(changeId: string): string {
  return `c/${changeId.slice(0, 8)}`;
}

/**
 * Build the request for a repair, plus the exact CLI command it corresponds to — the
 * command is shown to the person before they confirm, so what the button does is never a
 * mystery and is always reproducible in a terminal.
 */
export function planRepair(repair: DoctorRepair, input: RepairInput): RepairPlan {
  if (repair.action === "reconcile") {
    return {
      ok: true,
      action: "reconcile",
      body: {},
      command: "git for-ai reconcile",
    };
  }

  const commit = input.commit.trim();
  if (commit.length === 0) {
    return {
      ok: false,
      error: repair.detach
        ? "Name the commit to detach (a SHA, or anything git accepts)."
        : "Name the commit to point at (a SHA, or anything git accepts).",
    };
  }
  if (/\s/.test(commit)) {
    return { ok: false, error: "A commit is a single word — no spaces." };
  }

  if (repair.detach) {
    return {
      ok: true,
      action: "relink",
      body: { args: [commit], detach: true },
      command: `git for-ai relink --detach ${commit}`,
    };
  }

  const changeId = input.changeId.trim();
  if (changeId.length === 0) {
    return { ok: false, error: "Choose which change to re-point." };
  }
  return {
    ok: true,
    action: "relink",
    body: { args: [changeId, commit] },
    command: `git for-ai relink ${changeId} ${commit}`,
  };
}

/**
 * Seed the input for a repair. A single candidate change is pre-selected (there is no
 * choice to make); several are left unselected, because picking one for the person would
 * be the app deciding something it cannot know.
 */
export function seedRepairInput(repair: DoctorRepair): RepairInput {
  const only = repair.changeIds.length === 1 && !repair.detach ? repair.changeIds[0]! : "";
  return { changeId: only, commit: "" };
}

/** Every repair offered by a checkup, in the order the findings were reported. */
export function repairsFrom(checks: Array<{ repairs?: DoctorRepair[] }>): DoctorRepair[] {
  return checks.flatMap((check) => check.repairs ?? []);
}

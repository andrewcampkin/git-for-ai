// Turning what a person typed into an annotate request (DESKTOP.md §5 step 4, §3 item 4).
//
// This is the only place in the SPA where a human AUTHORS a record rather than reading
// one, which makes validation a correctness concern rather than a politeness one: a
// half-filled rejected alternative or an unparseable confidence must be refused here,
// with a sentence saying what to fix, instead of being dropped on the way to the ledger.
// Everything that reaches the server is what the person actually wrote.
//
// Pure functions, no React: the review-ui test suite tests logic, not rendering, so the
// rules live here and the component stays a set of inputs.

/** One rejected alternative as the form holds it, before it becomes `option::why`. */
export interface RejectedDraft {
  option: string;
  why: string;
}

/** The form's state. All strings — multi-line fields are one entry per line. */
export interface AnnotateDraft {
  summary: string;
  intent: string;
  /** One constraint per line. */
  constraints: string;
  rejected: RejectedDraft[];
  /** One test command or evidence line per line. */
  tested: string;
  /** Empty, or a number 0–1. */
  confidence: string;
  scopeRisk: "" | "low" | "medium" | "high";
  reversibility: "" | "easy" | "moderate" | "hard";
}

export const EMPTY_DRAFT: AnnotateDraft = {
  summary: "",
  intent: "",
  constraints: "",
  rejected: [],
  tested: "",
  confidence: "",
  scopeRisk: "",
  reversibility: "",
};

/** Split a textarea into trimmed, non-empty lines. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type BuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Build the `POST /api/actions/annotate` body, or explain what is wrong with the draft.
 * The rules are the ledger's, not the form's: a summary is what an entry IS, a rejected
 * alternative without a reason records nothing, and confidence is a 0–1 number or absent.
 */
export function buildAnnotateBody(target: string, draft: AnnotateDraft): BuildResult {
  const summary = draft.summary.trim();
  if (summary.length === 0) {
    return { ok: false, error: "A summary is required — one line saying what this change did." };
  }

  const rejected: string[] = [];
  for (const alternative of draft.rejected) {
    const option = alternative.option.trim();
    const why = alternative.why.trim();
    if (option.length === 0 && why.length === 0) {
      continue; // an untouched row, not a mistake
    }
    if (option.length === 0 || why.length === 0) {
      return {
        ok: false,
        error:
          "Each rejected alternative needs both parts: what was rejected, and why. " +
          "Fill in the missing half or clear the row.",
      };
    }
    if (option.includes("::")) {
      // The CLI encodes these as `option::why` and splits on the first `::`, so an
      // option containing one would silently cut the record in the wrong place.
      return { ok: false, error: "A rejected alternative cannot contain '::' in its name." };
    }
    rejected.push(`${option}::${why}`);
  }

  const body: Record<string, unknown> = { target, summary };
  const intent = draft.intent.trim();
  if (intent.length > 0) body["intent"] = intent;

  const constraints = lines(draft.constraints);
  if (constraints.length > 0) body["constraints"] = constraints;
  if (rejected.length > 0) body["rejected"] = rejected;
  const tested = lines(draft.tested);
  if (tested.length > 0) body["tested"] = tested;

  const confidenceText = draft.confidence.trim();
  if (confidenceText.length > 0) {
    const confidence = Number(confidenceText);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: "Confidence must be a number between 0 and 1 (e.g. 0.8)." };
    }
    body["confidence"] = confidence;
  }
  if (draft.scopeRisk !== "") body["scopeRisk"] = draft.scopeRisk;
  if (draft.reversibility !== "") body["reversibility"] = draft.reversibility;

  return { ok: true, body };
}

/**
 * Seed the form from what is already recorded, so editing a change means correcting a
 * draft rather than retyping it. Ledger entries are append-only: saving writes a NEW
 * entry that supersedes this one, and the old one stays readable — which is exactly why
 * pre-filling is safe rather than destructive.
 */
export function draftFromEntry(entry: {
  // Structural, and explicitly `| undefined`, so a real (zod passthrough) LedgerEntry
  // satisfies it under exactOptionalPropertyTypes without this module importing the
  // schema package — the same types-only discipline the rest of review-ui follows.
  summary?: string | undefined;
  reasoning?:
    | {
        intent?: string | undefined;
        constraints?: string[] | undefined;
        rejected?: Array<{ option: string; why: string }> | undefined;
        tested?: string[] | undefined;
        confidence?: number | undefined;
        scope_risk?: string | undefined;
        reversibility?: string | undefined;
      }
    | undefined;
}): AnnotateDraft {
  const reasoning = entry.reasoning ?? {};
  const risk = reasoning.scope_risk;
  const reversibility = reasoning.reversibility;
  return {
    summary: entry.summary ?? "",
    intent: reasoning.intent ?? "",
    constraints: (reasoning.constraints ?? []).join("\n"),
    rejected: (reasoning.rejected ?? []).map((alternative) => ({
      option: alternative.option,
      why: alternative.why,
    })),
    tested: (reasoning.tested ?? []).join("\n"),
    confidence: reasoning.confidence !== undefined ? String(reasoning.confidence) : "",
    scopeRisk:
      risk === "low" || risk === "medium" || risk === "high" ? risk : "",
    reversibility:
      reversibility === "easy" || reversibility === "moderate" || reversibility === "hard"
        ? reversibility
        : "",
  };
}

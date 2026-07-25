// Recording reasoning by hand (DESKTOP.md §5 step 4 — "annotate wants a real form").
//
// Everything else in this app reads what agents recorded. This is the one surface where
// the person at the keyboard writes it themselves: they read a change, find the reasoning
// thin or missing or wrong, and say what actually happened. It lives on the change route
// rather than in the maintenance panel because that is where the gap is visible — you
// notice "no reasoning recorded for this change yet" and fix it in place.
//
// Three things this form is careful about:
//
//   1. **Nothing is overwritten.** The ledger is append-only, so saving writes a NEW entry
//      that supersedes the old one, and the old one stays readable under "superseded
//      entries". The form says so before you save, because a form that looks like it
//      edits, but appends, teaches the wrong model of the data.
//   2. **It is honest about who wrote it.** No author fields: the server records a human
//      author for a form submission, which is what actually happened. A GUI that let you
//      claim an agent wrote something would be a provenance lie with a nice widget.
//   3. **Half-records are refused, not trimmed.** A rejected alternative with no reason,
//      or an unparseable confidence, stops the save with a sentence naming the fix
//      (see lib/annotate.ts) rather than quietly reaching the ledger incomplete.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EMPTY_DRAFT,
  buildAnnotateBody,
  draftFromEntry,
  type AnnotateDraft,
} from "../lib/annotate";
import { JOB_POLL_MS, readJob, runAction, type ActionJob } from "../lib/actions";
import type { LedgerEntry } from "../types";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="annotate-field">
      <span className="annotate-label">{label}</span>
      {hint !== undefined && <span className="annotate-hint">{hint}</span>}
      {children}
    </label>
  );
}

export function AnnotateForm({
  target,
  existing,
  onSaved,
}: {
  /** What to annotate — the change id when we have one, else the commit. */
  target: string;
  /** The current effective entry, if any: the form starts from it rather than blank. */
  existing: LedgerEntry | null;
  /** Called after a save lands, so the page can re-read the change. */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AnnotateDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ActionJob | null>(null);
  const timer = useRef<number | null>(null);
  const notified = useRef(false);

  const set = <K extends keyof AnnotateDraft>(key: K, value: AnnotateDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const openForm = useCallback(() => {
    setDraft(existing !== null ? draftFromEntry(existing) : EMPTY_DRAFT);
    setError(null);
    setJob(null);
    notified.current = false;
    setOpen(true);
  }, [existing]);

  // Poll the job until it finishes, then tell the page to re-read the change once.
  useEffect(() => {
    const stop = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
    if (job === null) {
      return stop;
    }
    if (job.status === "done" && !notified.current) {
      notified.current = true;
      onSaved();
      return stop;
    }
    if (job.status !== "running") {
      return stop;
    }
    timer.current = window.setTimeout(() => {
      readJob(job.id)
        .then(setJob)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
    }, JOB_POLL_MS);
    return stop;
  }, [job, onSaved]);

  const save = (): void => {
    const built = buildAnnotateBody(target, draft);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    runAction("annotate", built.body)
      .then(setJob)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };

  if (!open) {
    return (
      <div className="annotate-launch">
        <button type="button" onClick={openForm}>
          {existing !== null ? "Correct this record" : "Record what happened"}
        </button>
      </div>
    );
  }

  const saving = job !== null && job.status === "running";
  const saved = job !== null && job.status === "done";

  return (
    <section className="annotate" aria-labelledby="annotate-heading">
      <h3 id="annotate-heading">
        {existing !== null ? "Correct this record" : "Record what happened"}
      </h3>
      <p className="annotate-intro">
        {existing !== null
          ? "Saving adds a corrected version. The current one is kept and stays readable."
          : "Written down as yours — this is you saying what happened, not an agent's report."}
      </p>

      <Field label="Summary" hint="One line: what this change did.">
        <input
          type="text"
          value={draft.summary}
          onChange={(event) => set("summary", event.target.value)}
          placeholder="Move session state to signed cookies"
          autoFocus
        />
      </Field>

      <Field label="Why" hint="What were you actually trying to achieve?">
        <textarea
          rows={2}
          value={draft.intent}
          onChange={(event) => set("intent", event.target.value)}
          placeholder="run more than one replica without sticky sessions"
        />
      </Field>

      <Field label="Constraints" hint="One per line — what you had to work within.">
        <textarea
          rows={2}
          value={draft.constraints}
          onChange={(event) => set("constraints", event.target.value)}
          placeholder={"no new infrastructure\nmust survive a restart"}
        />
      </Field>

      <Field label="Tested" hint="One per line — how you know it works.">
        <textarea
          rows={2}
          value={draft.tested}
          onChange={(event) => set("tested", event.target.value)}
          placeholder={"pnpm turbo test\nlogged in and back out"}
        />
      </Field>

      <div className="annotate-field">
        <span className="annotate-label">Considered and rejected</span>
        <span className="annotate-hint">
          The alternatives you turned down, and why — the part nobody writes down and
          everybody later asks about.
        </span>
        {draft.rejected.map((alternative, index) => (
          <div className="annotate-rejected-row" key={index}>
            <input
              type="text"
              value={alternative.option}
              placeholder="Redis session store"
              onChange={(event) =>
                set(
                  "rejected",
                  draft.rejected.map((row, i) =>
                    i === index ? { ...row, option: event.target.value } : row,
                  ),
                )
              }
            />
            <input
              type="text"
              value={alternative.why}
              placeholder="avoid an infra dependency"
              onChange={(event) =>
                set(
                  "rejected",
                  draft.rejected.map((row, i) =>
                    i === index ? { ...row, why: event.target.value } : row,
                  ),
                )
              }
            />
            <button
              type="button"
              className="annotate-drop"
              aria-label="Remove this alternative"
              onClick={() =>
                set(
                  "rejected",
                  draft.rejected.filter((_, i) => i !== index),
                )
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="annotate-add"
          onClick={() => set("rejected", [...draft.rejected, { option: "", why: "" }])}
        >
          + add an alternative
        </button>
      </div>

      <div className="annotate-flags">
        <Field label="Confidence" hint="0–1, optional.">
          <input
            type="text"
            inputMode="decimal"
            value={draft.confidence}
            onChange={(event) => set("confidence", event.target.value)}
            placeholder="0.8"
          />
        </Field>
        <Field label="Risk">
          <select
            value={draft.scopeRisk}
            onChange={(event) => set("scopeRisk", event.target.value as AnnotateDraft["scopeRisk"])}
          >
            <option value="">not saying</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
        <Field label="Undo difficulty">
          <select
            value={draft.reversibility}
            onChange={(event) =>
              set("reversibility", event.target.value as AnnotateDraft["reversibility"])
            }
          >
            <option value="">not saying</option>
            <option value="easy">easy</option>
            <option value="moderate">moderate</option>
            <option value="hard">hard</option>
          </select>
        </Field>
      </div>

      {error !== null && <div className="error-box">{error}</div>}
      {job?.error !== undefined && <div className="error-box">{job.error}</div>}
      {saved && <p className="action-ok">Saved.</p>}

      <div className="annotate-buttons">
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="annotate-cancel" onClick={() => setOpen(false)}>
          {saved ? "Close" : "Cancel"}
        </button>
      </div>
    </section>
  );
}

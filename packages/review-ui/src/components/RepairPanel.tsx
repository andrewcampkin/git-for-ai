// Guided repair (DESKTOP.md §3 item 4, §5 step 4) — the last of the served-but-unreachable
// verbs. It sits under the attention inbox because that is the section that says "look at
// these first"; a checkup belongs beside the list of things needing a person, not in a
// maintenance drawer somewhere else.
//
// The shape is deliberately three steps, not one button:
//
//   1. **Run a checkup.** Nothing is inspected until asked — the page stays a read.
//   2. **Read what it found**, in plain language, with the changes it names.
//   3. **Repair, having seen the exact command.** These actions rewrite identity records,
//      so the command is shown before it runs and is copy-pasteable into a terminal. An
//      argument doctor cannot know (which commit is the right one) is asked for, never
//      guessed — that judgement is why a person is looking at this screen.
//
// Findings with no mechanical repair still appear. "Here is what is wrong and no button
// fixes it" is information; hiding it because we have nothing to offer would not be.

import { useCallback, useEffect, useRef, useState } from "react";

import type { DoctorCheck, DoctorData, DoctorRepair } from "../types";
import { JOB_POLL_MS, readJob, runAction, type ActionJob } from "../lib/actions";
import {
  EMPTY_REPAIR_INPUT,
  planRepair,
  seedRepairInput,
  shortChange,
  type RepairInput,
} from "../lib/repairs";

/** Poll one job to completion, reporting each state through `onUpdate`. */
function useJob(onDone: () => void) {
  const [job, setJob] = useState<ActionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const notified = useRef(false);

  useEffect(() => {
    const stop = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
    if (job === null) return stop;
    if (job.status === "done" && !notified.current) {
      notified.current = true;
      onDone();
      return stop;
    }
    if (job.status !== "running") return stop;
    timer.current = window.setTimeout(() => {
      readJob(job.id)
        .then(setJob)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
    }, JOB_POLL_MS);
    return stop;
  }, [job, onDone]);

  const start = useCallback((action: string, body: Record<string, unknown>) => {
    notified.current = false;
    setError(null);
    runAction(action, body)
      .then(setJob)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  return { job, error, start, reset: () => { notified.current = false; setJob(null); } };
}

function RepairOffer({ repair, onRan }: { repair: DoctorRepair; onRan: () => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<RepairInput>(EMPTY_REPAIR_INPUT);
  const [error, setError] = useState<string | null>(null);
  const run = useJob(onRan);

  const plan = planRepair(repair, input);
  const ran = run.job !== null;

  if (!open) {
    return (
      <button
        type="button"
        className="repair-open"
        onClick={() => {
          setInput(seedRepairInput(repair));
          setError(null);
          run.reset();
          setOpen(true);
        }}
      >
        Fix this…
      </button>
    );
  }

  return (
    <div className="repair-offer">
      <p className="repair-what">{repair.what}</p>

      {!repair.detach && repair.changeIds.length > 1 && (
        <label className="repair-field">
          <span>Which change</span>
          <select
            value={input.changeId}
            onChange={(event) => setInput({ ...input, changeId: event.target.value })}
          >
            <option value="">choose…</option>
            {repair.changeIds.map((changeId) => (
              <option key={changeId} value={changeId}>
                {shortChange(changeId)}
              </option>
            ))}
          </select>
        </label>
      )}

      {repair.needsCommit && (
        <label className="repair-field">
          <span>{repair.detach ? "Commit to detach" : "Commit to point at"}</span>
          <input
            type="text"
            value={input.commit}
            placeholder="2fe7d26"
            onChange={(event) => setInput({ ...input, commit: event.target.value })}
          />
        </label>
      )}

      {/* What will actually run. Shown before the button, always. */}
      <pre className="repair-command">{plan.ok ? plan.command : "…"}</pre>

      {error !== null && <div className="error-box">{error}</div>}
      {run.error !== null && <div className="error-box">{run.error}</div>}
      {run.job?.error !== undefined && <div className="error-box">{run.job.error}</div>}
      {run.job?.status === "done" && <p className="action-ok">Done.</p>}
      {run.job?.progress !== undefined && run.job.progress.length > 0 && (
        <pre className="action-progress">{run.job.progress.slice(-4).join("\n")}</pre>
      )}

      <div className="repair-buttons">
        <button
          type="button"
          disabled={run.job?.status === "running" || ran}
          onClick={() => {
            if (!plan.ok) {
              setError(plan.error);
              return;
            }
            setError(null);
            run.start(plan.action, plan.body);
          }}
        >
          {run.job?.status === "running" ? "Running…" : "Run it"}
        </button>
        <button type="button" className="repair-cancel" onClick={() => setOpen(false)}>
          {ran ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function Finding({ check, onRepaired }: { check: DoctorCheck; onRepaired: () => void }) {
  return (
    <li className={`repair-finding finding-${check.status}`}>
      <div className="repair-message">{check.message}</div>
      {(check.repairs ?? []).map((repair, index) => (
        <RepairOffer key={index} repair={repair} onRan={onRepaired} />
      ))}
      {(check.repairs ?? []).length === 0 && check.remediation.length > 0 && (
        // No button for this one — say what a person would have to do instead.
        <ul className="repair-manual">
          {check.remediation.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function RepairPanel() {
  const [checkedAt, setCheckedAt] = useState<number>(0);
  const [data, setData] = useState<DoctorData | null>(null);
  const check = useJob(useCallback(() => setCheckedAt(Date.now()), []));

  // After a repair lands, re-run the checkup rather than announcing success: the fresh
  // finding list is the evidence, and a stale one beside a "Done." would be a small lie.
  // Safe to fire here — the repair job has finished, so the server's one-job-at-a-time
  // rule is satisfied.
  const recheck = useCallback(() => check.start("doctor", {}), [check]);

  // Lift the doctor result out of the finished job.
  useEffect(() => {
    if (check.job?.status === "done" && check.job.action === "doctor") {
      const result = check.job.result as { data?: DoctorData } | undefined;
      if (result?.data !== undefined) {
        setData(result.data);
      }
    }
  }, [check.job]);

  const problems = (data?.checks ?? []).filter((row) => row.status !== "ok");
  const running = check.job?.status === "running";

  return (
    <div className="repair-panel">
      <div className="repair-head">
        <button type="button" disabled={running} onClick={() => check.start("doctor", {})}>
          {running ? "Checking…" : data === null ? "Run a checkup" : "Check again"}
        </button>
        {data !== null && !running && (
          <span className="repair-summary">
            {problems.length === 0
              ? `Everything looks right — ${data.checks.length} checks passed.`
              : `${problems.length} thing${problems.length === 1 ? "" : "s"} to look at.`}
          </span>
        )}
      </div>

      {check.error !== null && <div className="error-box">{check.error}</div>}
      {check.job?.error !== undefined && <div className="error-box">{check.job.error}</div>}

      {problems.length > 0 && (
        <ul className="repair-findings">
          {problems.map((row) => (
            // Re-mount findings after a repair so any open offer resets against fresh data.
            <Finding key={`${row.name}-${checkedAt}`} check={row} onRepaired={recheck} />
          ))}
        </ul>
      )}
    </div>
  );
}

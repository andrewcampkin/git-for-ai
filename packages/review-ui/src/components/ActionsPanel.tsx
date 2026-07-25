// Maintenance actions (DESKTOP.md §5 step 4b, §3 item 4) — the desktop app's write path,
// rendered only when the server says it offers actions AND this window holds the launch
// token. In the browser neither is true, so nothing here ever appears there.
//
// Each button starts a job and then shows what that job is doing, because the actions a
// person actually waits on (a reindex is minutes on a large repo) are worthless as a
// spinner: the progress lines are the same ones the CLI prints.
//
// The checkup is NOT here: it moved to the attention inbox (DESKTOP.md §3 item 4), where
// what it finds is actionable next to the rest of what needs a person. Two buttons for one
// action, in two places, would be worse than one in the right place.
//
// Pushing is deliberately two clicks. It is the one action that sends this repository's
// recorded reasoning to a remote, and the CLI has always asked first; a GUI that quietly
// dropped that question would be a less careful tool, not a more convenient one.

import { useCallback, useEffect, useRef, useState } from "react";

import { JOB_POLL_MS, readJob, runAction, type ActionJob } from "../lib/actions";

interface ReindexResultShape {
  chunksEmbedded?: number;
  chunksTotal?: number;
  warnings?: string[];
}

function JobView({ job }: { job: ActionJob }) {
  const lastLines = job.progress.slice(-6);
  return (
    <div className={`action-job status-${job.status}`}>
      <div className="action-job-head">
        {job.status === "running" && <span className="action-spinner">●</span>}
        <strong>{job.action}</strong>
        <span className="action-status">
          {job.status === "running" ? "running…" : job.status === "done" ? "finished" : "failed"}
        </span>
      </div>
      {lastLines.length > 0 && (
        <pre className="action-progress">{lastLines.join("\n")}</pre>
      )}
      {job.error !== undefined && <div className="error-box">{job.error}</div>}
      {job.status === "done" && job.action === "reindex" && (
        <p className="action-ok">
          Search is up to date
          {(job.result as ReindexResultShape | undefined)?.chunksEmbedded !== undefined &&
            ` — ${(job.result as ReindexResultShape).chunksEmbedded} pieces updated`}
          .
        </p>
      )}
      {job.status === "done" && job.action === "sync" && (
        <p className="action-ok">Sync finished.</p>
      )}
    </div>
  );
}

export function ActionsPanel() {
  const [job, setJob] = useState<ActionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Poll while a job runs. The effect owns the timer so leaving the page cannot leave a
  // request loop behind.
  useEffect(() => {
    if (job === null || job.status !== "running") {
      stopPolling();
      return;
    }
    timer.current = window.setTimeout(() => {
      readJob(job.id)
        .then(setJob)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
    }, JOB_POLL_MS);
    return stopPolling;
  }, [job]);

  const start = useCallback((name: string, body: Record<string, unknown> = {}) => {
    setError(null);
    setConfirmPush(false);
    runAction(name, body)
      .then(setJob)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  const busy = job !== null && job.status === "running";

  return (
    <section className="actions" aria-labelledby="actions-heading">
      <h2 id="actions-heading">Maintenance</h2>
      <div className="action-buttons">
        <button type="button" disabled={busy} onClick={() => start("reindex")}>
          Update search
        </button>
        <button type="button" disabled={busy} onClick={() => start("sync", { fetch: true })}>
          Fetch from remote
        </button>
        <button
          type="button"
          disabled={busy}
          className={confirmPush ? "danger" : ""}
          onClick={() =>
            confirmPush ? start("sync", { push: true, confirmed: true }) : setConfirmPush(true)
          }
        >
          {confirmPush ? "Yes, send it" : "Send to remote"}
        </button>
      </div>
      {confirmPush && (
        <p className="action-confirm">
          This sends the recorded reasoning and session records for this repository to its
          remote. Your code is pushed by git as usual and is not affected.
        </p>
      )}
      {error !== null && <div className="error-box">{error}</div>}
      {job !== null && <JobView job={job} />}
    </section>
  );
}

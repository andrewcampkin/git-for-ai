// App shell (Review UI v2): hash routing (no router dependency — three routes) over the
// same read-only API, reordered around the human reader. The overview reads top-to-bottom
// as: ask your repo anything (the primary interaction), a one-line activity digest, the
// attention inbox ("look at these first"), then the day-grouped timeline. Internals that
// only agents need (index chunk counts, change-ids, provenance-when-normal) are off the
// page — the CLI's --json output is the agent contract.

import { useEffect, useState } from "react";

import type { ReportData, ReviewMeta } from "./types";
import { useFetch } from "./lib/useFetch";
import { hasActionToken } from "./lib/actions";
import { ActionsPanel } from "./components/ActionsPanel";
import { AskPanel } from "./components/AskPanel";
import { AttentionQueue } from "./components/AttentionQueue";
import { BranchBar } from "./components/BranchBar";
import { ChangeDetail } from "./components/ChangeDetail";
import { SessionTrace } from "./components/SessionTrace";
import { Timeline } from "./components/Timeline";

type Route =
  | { view: "overview"; rev: string | null }
  | { view: "change"; target: string }
  | { view: "session"; ref: string };

/**
 * Hash routes, now with one query parameter: `#/?rev=<branch>` scopes the overview to a
 * branch. It lives in the URL rather than in component state so a branch view is a
 * shareable/reloadable address (and the desktop shell can restore it).
 */
function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : raw.slice(queryAt + 1));

  if (path.startsWith("/change/")) {
    const target = path.slice("/change/".length);
    if (target.length > 0) {
      return { view: "change", target };
    }
  }
  if (path.startsWith("/session/")) {
    const ref = path.slice("/session/".length);
    if (ref.length > 0) {
      return { view: "session", ref };
    }
  }
  const rev = params.get("rev");
  return { view: "overview", rev: rev !== null && rev.length > 0 ? rev : null };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

/** Compact masthead status: HEAD and capture state. Index status lives on the ask panel. */
function MetaLine({ meta }: { meta: ReviewMeta }) {
  return (
    <p className="meta-line">
      {meta.head !== null ? (
        <span>
          HEAD{" "}
          <span className="sha" title={meta.head.sha}>
            {meta.head.shortSha}
          </span>{" "}
          {meta.head.subject}
        </span>
      ) : (
        <span className="absent">no commits yet</span>
      )}
      <span>
        session recording {meta.initialized ? (meta.captureEnabled ? "on" : "off") : "not set up"}
      </span>
    </p>
  );
}

/**
 * One readable line of what the agents have been up to — replaces v1's stat-card grid.
 * Every number is real; the model list is shown because "which models touched my repo"
 * is a question humans actually have.
 */
function Digest({ data }: { data: ReportData }) {
  const { totals } = data;
  return (
    <div className="digest">
      <span className="digest-item">
        <strong>{totals.commits}</strong> commit{totals.commits === 1 ? "" : "s"}
      </span>
      <span className="digest-item">
        <strong>{totals.agentCommits}</strong> by agents
      </span>
      <span className="digest-item">
        <strong>{totals.humanCommits}</strong> by humans
      </span>
      {totals.mixedCommits > 0 && (
        <span className="digest-item">
          <strong>{totals.mixedCommits}</strong> mixed
        </span>
      )}
      {totals.noIntentCommits > 0 && (
        <span className="digest-item digest-warn">
          <strong>{totals.noIntentCommits}</strong> without recorded reasoning
        </span>
      )}
      <span className="digest-item">
        <strong>{totals.sessionsCaptured}</strong> session
        {totals.sessionsCaptured === 1 ? "" : "s"} captured
      </span>
      <span className="digest-item">
        {totals.modelsSeen.length > 0 ? totals.modelsSeen.join(", ") : "no models recorded"}
      </span>
    </div>
  );
}

function Overview({ data }: { data: ReportData }) {
  return (
    <>
      <Digest data={data} />
      {data.warnings.length > 0 && (
        <section className="warnings" style={{ marginTop: "1.2rem" }}>
          <div className="w-title">Warnings</div>
          <ul>
            {data.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
      <AttentionQueue data={data} />
      <Timeline rows={data.timeline} />
    </>
  );
}

export function App() {
  const route = useRoute();
  const meta = useFetch<ReviewMeta>("/api/meta");
  const rev = route.view === "overview" ? route.rev : null;
  const overview = useFetch<ReportData>(
    rev === null ? "/api/overview" : `/api/overview?rev=${encodeURIComponent(rev)}`,
  );
  // The branch bar only renders where the server says it can be served (and where it
  // means something — the overview is the only rev-scoped route).
  const showBranches = meta.state === "ok" && meta.data.capabilities.branches;
  // Maintenance needs BOTH halves: a server that offers actions, and a window holding the
  // launch token that can call them. Either alone renders nothing.
  const showActions =
    meta.state === "ok" && meta.data.capabilities.actions && hasActionToken();

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="eyebrow">
          <a href="#/">git-for-ai · review</a>
        </div>
        <h1>{meta.state === "ok" ? meta.data.repoName : "repository"}</h1>
        {meta.state === "ok" && <MetaLine meta={meta.data} />}
        {meta.state === "error" && (
          <div className="error-box">Could not load repository metadata: {meta.error}</div>
        )}
      </header>

      {route.view === "overview" && (
        <>
          {showBranches && (
            <BranchBar
              rev={rev}
              onSelect={(next) => {
                window.location.hash = next === null ? "#/" : `#/?rev=${encodeURIComponent(next)}`;
              }}
            />
          )}
          <AskPanel meta={meta.state === "ok" ? meta.data : null} />
          {rev !== null && (
            <p className="absent scope-note">
              The timeline below is scoped to <strong>{rev}</strong>. Answers above may not
              reflect this branch — they're based on the last time search was updated.
            </p>
          )}
          {overview.state === "loading" && <p className="loading">Reading the repository…</p>}
          {overview.state === "error" && (
            <div className="error-box">Could not load the overview: {overview.error}</div>
          )}
          {overview.state === "ok" && <Overview data={overview.data} />}
          {showActions && <ActionsPanel />}
        </>
      )}
      {route.view === "change" && (
        <ChangeDetail
          target={route.target}
          showDiff={meta.state === "ok" && meta.data.capabilities.diff}
          canAnnotate={showActions}
          key={route.target}
        />
      )}
      {route.view === "session" && <SessionTrace sessionRef={route.ref} key={route.ref} />}
    </div>
  );
}

// App shell: hash routing (no router dependency — three routes), overview data fetch, and
// the masthead the report page carries, made live. The overview is the report's header
// stats + timeline; the change detail and session trace are routes over the same read-only
// API (REVIEW_UI.md §4).

import { useEffect, useState } from "react";

import type { ReportData, ReviewMeta } from "./types";
import { fmtWhen } from "./lib/format";
import { useFetch } from "./lib/useFetch";
import { AskPanel } from "./components/AskPanel";
import { AttentionQueue } from "./components/AttentionQueue";
import { ChangeDetail } from "./components/ChangeDetail";
import { SessionTrace } from "./components/SessionTrace";
import { Timeline } from "./components/Timeline";

type Route =
  | { view: "overview" }
  | { view: "change"; target: string }
  | { view: "session"; ref: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
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
  return { view: "overview" };
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
        capture {meta.initialized ? (meta.captureEnabled ? "on" : "off") : "off (not initialized)"}
      </span>
      <span>
        {meta.index.built
          ? `index: ${meta.index.chunkCount ?? 0} chunks @ ${
              meta.index.lastIndexedCommit?.slice(0, 7) ?? "?"
            }${meta.index.updatedAt !== undefined ? ` (${fmtWhen(meta.index.updatedAt)})` : ""}`
          : meta.index.error !== undefined
            ? `index state unreadable: ${meta.index.error}`
            : "index: not built"}
      </span>
    </p>
  );
}

function Stats({ data }: { data: ReportData }) {
  const { totals } = data;
  const attribution =
    `${totals.agentCommits} agent · ${totals.humanCommits} human` +
    (totals.mixedCommits > 0 ? ` · ${totals.mixedCommits} mixed` : "") +
    ` · ${totals.noIntentCommits} no intent`;
  return (
    <div className="stats">
      <div className="stat">
        <div className="num">{totals.commits}</div>
        <div className="lbl">commits</div>
      </div>
      <div className="stat">
        <div className="num">{totals.changes}</div>
        <div className="lbl">changes</div>
      </div>
      <div className="stat">
        <div className="num">{totals.agentCommits}</div>
        <div className="lbl">agent-attributed</div>
        <div className="sub">{attribution}</div>
      </div>
      <div className="stat">
        <div className="num">{totals.sessionsCaptured}</div>
        <div className="lbl">sessions captured</div>
      </div>
      <div className="stat">
        <div className="num">{totals.modelsSeen.length}</div>
        <div className="lbl">models seen</div>
        <div className="sub">
          {totals.modelsSeen.length > 0 ? totals.modelsSeen.join(", ") : "none recorded"}
        </div>
      </div>
    </div>
  );
}

function Overview({ data }: { data: ReportData }) {
  return (
    <>
      <Stats data={data} />
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
      <AskPanel />
    </>
  );
}

export function App() {
  const route = useRoute();
  const meta = useFetch<ReviewMeta>("/api/meta");
  const overview = useFetch<ReportData>("/api/overview");

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
          {overview.state === "loading" && <p className="loading">Reading the repository…</p>}
          {overview.state === "error" && (
            <div className="error-box">Could not load the overview: {overview.error}</div>
          )}
          {overview.state === "ok" && <Overview data={overview.data} />}
        </>
      )}
      {route.view === "change" && <ChangeDetail target={route.target} key={route.target} />}
      {route.view === "session" && <SessionTrace sessionRef={route.ref} key={route.ref} />}

      <footer>
        Served locally by <code>git for-ai review</code> (127.0.0.1 only, read-only).
        Missing data is labeled, never inferred or fabricated: commits without a ledger
        entry show their own git subject, marked "no captured intent"; unresolvable session
        traces are reported as unavailable.
      </footer>
    </div>
  );
}

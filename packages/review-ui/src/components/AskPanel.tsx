// Ask panel — the page's PRIMARY interaction (Review UI v2): "ask your repo anything"
// sits at the top of the overview, above the activity digest. Served by GET /api/ask,
// the same engine as `git for-ai ask`. The honesty rules carry over unchanged: an index
// that is not ready renders the server's actionable reason; with no API key the panel
// shows the ranked raw sources and says why there is no prose; synthesized answers keep
// their [n] citations, linked to the numbered source list (ledger sources link to the
// change detail route, sessions to the trace viewer).

import { useState, type FormEvent } from "react";

import type { ReviewAskData, ReviewAskSource, ReviewAskSynthesis, ReviewMeta } from "../types";
import { splitCitations } from "../lib/citations";
import { fmtWhen } from "../lib/format";

type AskState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ok"; data: ReviewAskData };

/** Example phrasings (UI affordance only — clicking fills the box, nothing is faked). */
const SUGGESTIONS = [
  "What did agents change this week?",
  "Why was this approach chosen?",
  "What was tested, and how?",
];

/** Why there is no prose, in one honest line (mirrors the CLI's wording). */
function skipNote(synthesis: ReviewAskSynthesis): string {
  switch (synthesis.skippedReason) {
    case "no-api-key":
      return (
        "No API key configured, so there is no synthesized answer — the ranked sources " +
        "below are the local retrieval result. Set GIT_FOR_AI_ANTHROPIC_KEY before " +
        "running `git for-ai review` to enable prose answers."
      );
    case "no-sources":
      return "Nothing indexed matches this question.";
    case "api-error":
      return `Synthesis failed (${synthesis.error ?? "unknown error"}) — showing the ranked sources.`;
    case "refusal":
      return "The model declined to answer — showing the ranked sources.";
    case "empty-response":
      return "The API returned no text — showing the ranked sources.";
    default:
      return "No synthesized answer — showing the ranked sources.";
  }
}

function SourceRef({ source }: { source: ReviewAskSource }) {
  if (source.kind === "ledger" && source.changeId !== null) {
    return (
      <>
        <a href={`#/change/c/${source.changeId}`} className="sha">
          c/{source.changeId.slice(0, 8)}
        </a>
        {source.scope !== null && <code className="ask-src-path">{source.scope}</code>}
      </>
    );
  }
  if (source.kind === "session" && source.sessionRef !== null) {
    return (
      <>
        <a href={`#/session/${source.sessionRef}`} className="sha">
          {source.sessionRef.slice(0, 13)}
        </a>
        {source.agentTool !== null && <span>{source.agentTool}</span>}
      </>
    );
  }
  const lines =
    source.startLine !== null && source.endLine !== null
      ? `:${source.startLine}-${source.endLine}`
      : "";
  return <code className="ask-src-path">{`${source.path ?? "(unknown path)"}${lines}`}</code>;
}

function SourceRow({ source }: { source: ReviewAskSource }) {
  return (
    <li id={`ask-src-${source.rank}`} className="ask-source">
      <span className="ask-src-rank">[{source.rank}]</span>
      <span className="ask-src-kind">{source.kind}</span>
      <SourceRef source={source} />
      {source.when !== null && <span className="when">{fmtWhen(source.when)}</span>}
      {source.summary.length > 0 && <div className="ask-src-summary">{source.summary}</div>}
    </li>
  );
}

function Answer({ data }: { data: ReviewAskData }) {
  if (data.status === "unavailable") {
    return (
      <p className="ask-note">
        Ask is not ready for this repository: {data.reason ?? "unknown reason"}
      </p>
    );
  }
  const sources = data.sources ?? [];
  const synthesis = data.synthesis;
  return (
    <div className="ask-result">
      {synthesis !== undefined && synthesis.synthesized && synthesis.answer !== null ? (
        <p className="ask-answer">
          {splitCitations(synthesis.answer, sources.length).map((segment, index) =>
            segment.kind === "text" ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <a key={index} className="cite" href={`#ask-src-${segment.n}`}>
                [{segment.n}]
              </a>
            ),
          )}
        </p>
      ) : (
        synthesis !== undefined && <p className="ask-note">{skipNote(synthesis)}</p>
      )}
      {sources.length > 0 && (
        <details className="ask-sources-fold" open={synthesis?.synthesized !== true}>
          <summary>
            {sources.length} source{sources.length === 1 ? "" : "s"}
          </summary>
          <ul className="ask-sources">
            {sources.map((source) => (
              <SourceRow key={source.rank} source={source} />
            ))}
          </ul>
        </details>
      )}
      {(data.warnings ?? []).length > 0 && (
        <ul className="ask-warnings">
          {(data.warnings ?? []).map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Index-readiness hint: speak only when something is wrong (not built / unreadable).
 * A healthy index says nothing — its chunk counts are agent-facing internals.
 */
function IndexHint({ meta }: { meta: ReviewMeta | null }) {
  if (meta === null || meta.index.built) {
    return null;
  }
  return (
    <p className="ask-note">
      {meta.index.error !== undefined
        ? `Index state unreadable: ${meta.index.error}`
        : "The search index has not been built yet — run `git for-ai index` to enable answers."}
    </p>
  );
}

export function AskPanel({ meta }: { meta: ReviewMeta | null }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskState>({ state: "idle" });

  async function ask(text: string) {
    if (text.length === 0 || result.state === "loading") {
      return;
    }
    setResult({ state: "loading" });
    try {
      const response = await fetch(`/api/ask?q=${encodeURIComponent(text)}`);
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      setResult({ state: "ok", data: body as ReviewAskData });
    } catch (error) {
      setResult({
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(question.trim());
  }

  return (
    <section className="ask" aria-labelledby="ask">
      <h2 id="ask" className="ask-title">
        Ask this repository
      </h2>
      <p className="ask-sub">
        Answers come from captured intent — ledger entries, session traces, and the code
        itself. Every answer lists its sources.
      </p>
      <form className="ask-controls" onSubmit={submit}>
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Why was the session store replaced? Who touched the auth flow?"
          aria-label="Question about this repository's changes"
        />
        <button type="submit" disabled={result.state === "loading"}>
          {result.state === "loading" ? "Asking…" : "Ask"}
        </button>
      </form>
      {result.state === "idle" && (
        <div className="ask-suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="ask-chip"
              onClick={() => {
                setQuestion(suggestion);
                void ask(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <IndexHint meta={meta} />
      {result.state === "loading" && <p className="ask-note">Searching the local index…</p>}
      {result.state === "error" && <div className="error-box">Ask failed: {result.error}</div>}
      {result.state === "ok" && <Answer data={result.data} />}
    </section>
  );
}

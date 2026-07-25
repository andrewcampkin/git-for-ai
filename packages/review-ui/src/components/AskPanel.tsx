// Ask panel — the page's PRIMARY interaction (Review UI v2): "ask your repo anything"
// sits at the top of the overview, above the activity digest. Served by GET /api/ask,
// the same engine as `git for-ai ask`. The honesty rules carry over unchanged: an index
// that is not ready renders the server's actionable reason; with no API key the panel
// shows the ranked raw sources and says why there is no prose; synthesized answers keep
// their [n] citations, linked to the numbered source list (ledger sources link to the
// change detail route, sessions to the trace viewer).

import { useState, type FormEvent } from "react";

import type {
  ReviewAskConsulted,
  ReviewAskData,
  ReviewAskSource,
  ReviewAskSynthesis,
  ReviewMeta,
} from "../types";
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

/** Why there is no written answer, in one honest line. */
function skipNote(synthesis: ReviewAskSynthesis): string {
  switch (synthesis.skippedReason) {
    case "no-api-key":
      return (
        "No API key configured, so there's no written answer — the sources found below " +
        "are shown instead. Set GIT_FOR_AI_ANTHROPIC_KEY before running " +
        "`git for-ai review` to enable written answers."
      );
    case "no-sources":
      return "Nothing found that matches this question.";
    case "api-error":
      return `Couldn't generate an answer (${synthesis.error ?? "unknown error"}) — showing the sources found instead.`;
    case "refusal":
      return "The model declined to answer — showing the sources found instead.";
    case "empty-response":
      return "No answer came back — showing the sources found instead.";
    case "tool-iteration-cap":
      return "The answer was still digging when it ran out of time — showing the sources found instead.";
    default:
      return "No answer available — showing the sources found instead.";
  }
}

/**
 * What the answer went and looked at, in the reader's words. Never the tool name: the
 * person reading this wants to know the answer was checked against their repository, not
 * which function we called (the audience split — this page is for humans).
 */
function consultedLabel(entry: ReviewAskConsulted): string {
  const text = (field: string): string | undefined => {
    const value = entry.input[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  switch (entry.name) {
    case "commit_diff":
      return `the changes in ${text("sha") ?? "a commit"}`;
    case "show_change":
      return `the record for ${text("target") ?? "a change"}`;
    case "log_intent": {
      const path = text("path");
      return path !== undefined ? `recent history for ${path}` : "recent history";
    }
    case "blame_why": {
      const file = text("file");
      const line = entry.input["line"];
      return file !== undefined
        ? `${file}${typeof line === "number" ? `, line ${line}` : ""}`
        : "a specific line";
    }
    default:
      return "this repository";
  }
}

/** "Also checked: the changes in ce23522" — the strongest grounding an answer can have. */
function Consulted({ consulted }: { consulted: ReviewAskConsulted[] }) {
  if (consulted.length === 0) {
    return null;
  }
  return (
    <p className="ask-consulted">
      Also checked:{" "}
      {consulted.map((entry, index) => (
        <span key={index}>
          {index > 0 && " · "}
          {entry.ok ? consultedLabel(entry) : `couldn't read ${consultedLabel(entry)}`}
        </span>
      ))}
    </p>
  );
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

/** Plain label for a source's kind — "ledger" is our storage word, not the reader's. */
function sourceKindLabel(kind: ReviewAskSource["kind"]): string {
  switch (kind) {
    case "ledger":
      return "reasoning";
    case "session":
      return "session";
    case "code":
      return "code";
  }
}

function SourceRow({ source }: { source: ReviewAskSource }) {
  return (
    <li id={`ask-src-${source.rank}`} className="ask-source">
      <span className="ask-src-rank">[{source.rank}]</span>
      <span className="ask-src-kind">{sourceKindLabel(source.kind)}</span>
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
      {synthesis?.consulted !== undefined && <Consulted consulted={synthesis.consulted} />}
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
        ? `Couldn't check search status: ${meta.index.error}`
        : "Search hasn't been set up yet — run `git for-ai reindex` to enable answers."}
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
        Answers come from recorded reasoning, session records, and the code itself. Every
        answer lists its sources.
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
      {result.state === "loading" && <p className="ask-note">Searching…</p>}
      {result.state === "error" && <div className="error-box">Ask failed: {result.error}</div>}
      {result.state === "ok" && <Answer data={result.data} />}
    </section>
  );
}

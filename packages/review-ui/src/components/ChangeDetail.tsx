// Change detail route (REVIEW_UI.md §4.2): one change, REASONING-FIRST — intent,
// constraints, rejected alternatives (option + why), tested evidence, scope file list —
// with superseded ledger entries collapsed-but-present (DATA_MODEL.md §2.4) and the
// session summary line. Commit diff rendering is explicitly v2; this reviews the recorded
// intent. Absent data renders labeled ("not captured"), never guessed.

import type { ReactNode } from "react";

import type { LedgerEntry, ShowData, ShowLedgerRow } from "../types";
import { fmtWhen, sessionLineFromShow } from "../lib/format";
import { useFetch } from "../lib/useFetch";
import { BadgePill, FlagPills, ProvenancePill } from "./Pills";

/** Derive the badge from a ledger entry (same derivation as report.ts's toBadge). */
function entryBadge(entry: LedgerEntry) {
  const parts = [entry.author.type, entry.author.tool, entry.author.model].filter(
    (part): part is string => part !== undefined,
  );
  if (entry.author.type === "human" && entry.author.human !== undefined) {
    parts.push(entry.author.human);
  }
  return {
    kind: entry.author.type,
    ...(entry.author.tool !== undefined ? { tool: entry.author.tool } : {}),
    ...(entry.author.model !== undefined ? { model: entry.author.model } : {}),
    label: parts.join(" · "),
  };
}

function entryFlags(entry: LedgerEntry) {
  const reasoning = entry.reasoning;
  return {
    ...(reasoning?.confidence !== undefined ? { confidence: reasoning.confidence } : {}),
    ...(reasoning?.scope_risk !== undefined ? { scopeRisk: reasoning.scope_risk } : {}),
    ...(reasoning?.reversibility !== undefined
      ? { reversibility: reasoning.reversibility }
      : {}),
  };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EffectiveEntry({ data, entry }: { data: ShowData; entry: LedgerEntry }) {
  const reasoning = entry.reasoning;
  const session = data.session;
  return (
    <>
      <p className="change-summary">{entry.summary}</p>
      <div className="meta">
        <BadgePill badge={entryBadge(entry)} />
        <ProvenancePill provenance={entry.provenance} />
        <FlagPills flags={entryFlags(entry)} />
      </div>
      <dl className="facts">
        <Fact label="Intent">
          {reasoning?.intent !== undefined ? (
            reasoning.intent
          ) : (
            <span className="absent">not captured</span>
          )}
        </Fact>
        {reasoning?.directive !== undefined && <Fact label="Directive">{reasoning.directive}</Fact>}
        {(reasoning?.constraints ?? []).length > 0 && (
          <Fact label="Constraints">
            <ul>
              {reasoning!.constraints!.map((constraint, index) => (
                <li key={index}>{constraint}</li>
              ))}
            </ul>
          </Fact>
        )}
        {(reasoning?.rejected ?? []).length > 0 && (
          <Fact label="Rejected">
            <ul>
              {reasoning!.rejected!.map((alt, index) => (
                <li key={index}>
                  <strong>{alt.option}</strong> — {alt.why}
                </li>
              ))}
            </ul>
          </Fact>
        )}
        <Fact label="Tested">
          {(reasoning?.tested ?? []).length > 0 ? (
            <ul>
              {reasoning!.tested!.map((test, index) => (
                <li key={index}>
                  <code>{test}</code>
                </li>
              ))}
            </ul>
          ) : (
            <span className="absent">no verification evidence captured</span>
          )}
        </Fact>
        {entry.scope.length > 0 && (
          <Fact label="Scope">
            <ul>
              {entry.scope.map((item, index) => (
                <li key={index}>
                  <code>
                    {item.path}
                    {item.range ? `:${item.range[0]}–${item.range[1]}` : ""}
                  </code>
                </li>
              ))}
            </ul>
          </Fact>
        )}
        <Fact label="Session">
          {session.status === "available" && session.ref !== null ? (
            <>
              {sessionLineFromShow(session)}{" "}
              <a href={`#/session/${session.ref}`}>view span trace</a>
              {session.record?.summary !== undefined && (
                <div className="commit-line">{session.record.summary}</div>
              )}
            </>
          ) : (
            <span className="absent">{sessionLineFromShow(session)}</span>
          )}
        </Fact>
      </dl>
    </>
  );
}

function SupersededEntries({ rows }: { rows: ShowLedgerRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="superseded">
      <summary>
        {rows.length} superseded entr{rows.length === 1 ? "y" : "ies"} (retained — the
        ledger is append-only)
      </summary>
      {rows.map((row, index) => (
        <div className="superseded-entry" key={index}>
          <span className="s-summary">{row.entry.summary}</span>
          <br />
          {fmtWhen(row.entry.created_at)} · {entryBadge(row.entry).label} ·{" "}
          {row.entry.provenance}
        </div>
      ))}
    </details>
  );
}

export function ChangeDetail({ target }: { target: string }) {
  const result = useFetch<ShowData>(`/api/change/${target}`);

  if (result.state === "loading") {
    return <p className="loading">Loading change {target}…</p>;
  }
  if (result.state === "error") {
    return (
      <>
        <a className="back-link" href="#/">
          ← back to timeline
        </a>
        <div className="error-box">
          Could not load <code>{target}</code>: {result.error}
        </div>
      </>
    );
  }

  const data = result.data;
  const effective = data.ledger.find((row) => row.effective)?.entry ?? null;
  const superseded = data.ledger.filter((row) => !row.effective);

  return (
    <>
      <a className="back-link" href="#/">
        ← back to timeline
      </a>
      <section className="change">
        <h3>
          {data.changeId !== null ? (
            <code title={data.changeId}>c/{data.changeId.slice(0, 8)}</code>
          ) : (
            <code>no identity</code>
          )}{" "}
          {data.commit !== null && (
            <span className="commit-line">
              <span className="sha" title={data.commit.sha}>
                {data.commit.shortSha}
              </span>{" "}
              {data.commit.subject}
            </span>
          )}
        </h3>
        {data.redirectedFrom !== undefined && (
          <p className="commit-line">
            redirected from absorbed change c/{data.redirectedFrom}
          </p>
        )}
        {data.commit === null && (
          <p className="absent">Head commit not present in this repository.</p>
        )}
        {data.changeId === null && (
          <p className="absent">
            No identity: no change-map entry and no Change-Id trailer. Shown from git
            metadata only.
          </p>
        )}

        {effective !== null ? (
          <EffectiveEntry data={data} entry={effective} />
        ) : (
          <p className="change-summary absent">
            {data.changeId !== null
              ? "This change has identity but no captured intent yet."
              : "No captured intent."}
          </p>
        )}

        {data.changeMap !== null && (
          <dl className="facts">
            <Fact label="Change-map">
              origin <code>{data.changeMap.origin}</code> · {data.changeMap.history.length}{" "}
              revision{data.changeMap.history.length === 1 ? "" : "s"} · head{" "}
              <span className="sha" title={data.changeMap.head}>
                {data.changeMap.head.slice(0, 7)}
              </span>{" "}
              · updated {fmtWhen(data.changeMap.updated_at)}
            </Fact>
          </dl>
        )}

        <SupersededEntries rows={superseded} />
      </section>

      {data.warnings.length > 0 && (
        <section className="warnings">
          <div className="w-title">Warnings</div>
          <ul>
            {data.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

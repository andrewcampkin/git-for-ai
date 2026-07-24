// Change detail route (Review UI v2): one change, ordered the way a human reviews it —
// the CLAIM (summary) as the title, then the EVIDENCE right next to it (tested commands,
// the captured session), then the reasoning (intent, constraints, rejected alternatives).
// Internals are folded, not deleted: file scope collapses to a count, and change-id /
// change-map / provenance internals live in a closed "Record details" disclosure —
// agents get all of it from the CLI's --json, which is the machine contract. Absent data
// renders labeled ("not captured"), never guessed. PLAN_2026-07-18 §2.2: "the prove-it
// pixel: claim next to evidence".

import type { ReactNode } from "react";

import type { LedgerEntry, ShowData, ShowLedgerRow } from "../types";
import { fmtWhen, isNoteworthyProvenance, sessionLineFromShow } from "../lib/format";
import { useFetch } from "../lib/useFetch";
import { DiffPane } from "./DiffPane";
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

/** The prove-it block: verification evidence and the captured session, side by side. */
function Evidence({ data, entry }: { data: ShowData; entry: LedgerEntry }) {
  const tested = entry.reasoning?.tested ?? [];
  const session = data.session;
  return (
    <div className="evidence">
      <div className="evidence-block">
        <div className="evidence-title">Tested</div>
        {tested.length > 0 ? (
          <ul className="evidence-list">
            {tested.map((test, index) => (
              <li key={index}>
                <code>{test}</code>
              </li>
            ))}
          </ul>
        ) : (
          <span className="absent">no verification evidence captured</span>
        )}
      </div>
      <div className="evidence-block">
        <div className="evidence-title">Session</div>
        {session.status === "available" && session.ref !== null ? (
          <>
            <div>{sessionLineFromShow(session)}</div>
            {session.record?.summary !== undefined && (
              <div className="commit-line">{session.record.summary}</div>
            )}
            <a href={`#/session/${session.ref}`}>view the full trace →</a>
          </>
        ) : (
          <span className="absent">{sessionLineFromShow(session)}</span>
        )}
      </div>
    </div>
  );
}

function EffectiveEntry({ data, entry }: { data: ShowData; entry: LedgerEntry }) {
  const reasoning = entry.reasoning;
  return (
    <>
      <h3 className="change-summary">{entry.summary}</h3>
      <div className="meta">
        <BadgePill badge={entryBadge(entry)} />
        <FlagPills flags={entryFlags(entry)} />
        {isNoteworthyProvenance(entry.provenance) && (
          <ProvenancePill provenance={entry.provenance} />
        )}
        <span className="when">{fmtWhen(entry.created_at)}</span>
      </div>

      <Evidence data={data} entry={entry} />

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
      </dl>

      {entry.scope.length > 0 && (
        <details className="scope-fold">
          <summary>
            {entry.scope.length} file{entry.scope.length === 1 ? "" : "s"} touched
          </summary>
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
        </details>
      )}
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

/** Closed-by-default fold for the identity/provenance internals a human rarely needs. */
function RecordDetails({ data, effective }: { data: ShowData; effective: LedgerEntry | null }) {
  if (data.changeId === null && data.changeMap === null && effective === null) {
    return null;
  }
  return (
    <details className="record-details">
      <summary>Record details</summary>
      <dl className="facts">
        {data.changeId !== null && (
          <Fact label="Change-id">
            <code>{data.changeId}</code>
          </Fact>
        )}
        {effective !== null && (
          <Fact label="Provenance">
            <code>{effective.provenance}</code>
          </Fact>
        )}
        {data.changeMap !== null && (
          <Fact label="Change-map">
            origin <code>{data.changeMap.origin}</code> · {data.changeMap.history.length}{" "}
            revision{data.changeMap.history.length === 1 ? "" : "s"} · head{" "}
            <span className="sha" title={data.changeMap.head}>
              {data.changeMap.head.slice(0, 7)}
            </span>{" "}
            · updated {fmtWhen(data.changeMap.updated_at)}
          </Fact>
        )}
        {data.redirectedFrom !== undefined && (
          <Fact label="Redirected">
            from absorbed change <code>c/{data.redirectedFrom}</code>
          </Fact>
        )}
      </dl>
    </details>
  );
}

export function ChangeDetail({
  target,
  showDiff = false,
}: {
  target: string;
  /** `/api/meta`'s diff capability — the pane must not render where it would 404. */
  showDiff?: boolean;
}) {
  const result = useFetch<ShowData>(`/api/change/${target}`);

  if (result.state === "loading") {
    return <p className="loading">Loading change {target}…</p>;
  }
  if (result.state === "error") {
    return (
      <>
        <a className="back-link" href="#/">
          ← back to the overview
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
        ← back to the overview
      </a>
      <section className="change">
        {data.commit !== null ? (
          <p className="commit-line change-commit">
            commit{" "}
            <span className="sha" title={data.commit.sha}>
              {data.commit.shortSha}
            </span>{" "}
            {data.commit.subject}
          </p>
        ) : (
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

        <RecordDetails data={data} effective={effective} />
        <SupersededEntries rows={superseded} />
      </section>

      {/* The evidence the ledger cannot fake: the code this change actually made. */}
      {showDiff && data.commit !== null && <DiffPane sha={data.commit.sha} />}

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

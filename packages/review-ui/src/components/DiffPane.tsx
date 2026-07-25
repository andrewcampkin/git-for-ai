// Diff pane (DESKTOP.md §5 step 3, v1 feature 3): the code itself, rendered next to the
// change's recorded intent — the claim-next-to-evidence principle extended from the ledger
// to the diff. Fetched from the read-only `/api/diff/:sha`.
//
// Honest degradation, same as everywhere else on this page:
//   - a merge commit says which parent its diff is against (the server's warning, shown);
//   - a truncated body says so, and the +/- counts stay complete;
//   - a binary file is labeled, never rendered as an empty patch.
//
// Not in this version: syntax highlighting (DESKTOP.md §3 lists it). Every bundled
// highlighter is a real dependency with real weight, and the diff reads fine in mono with
// add/delete coloring; it is recorded as deferred rather than quietly dropped.

import { useState } from "react";

import type { ReviewDiffData, ReviewDiffFile } from "../types";
import { countsLabel, fileTitle, gutterWidth, lineMarker, startsOpen, statusLabel } from "../lib/diff";
import { useFetch } from "../lib/useFetch";

function FilePane({
  file,
  gutter,
  defaultOpen,
}: {
  file: ReviewDiffFile;
  gutter: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const pad = (value: number | null): string =>
    (value === null ? "" : String(value)).padStart(gutter, " ");

  return (
    <section className={`diff-file status-${file.status}`}>
      <button
        type="button"
        className="diff-file-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="diff-caret">{open ? "▾" : "▸"}</span>
        <code className="diff-path">{fileTitle(file)}</code>
        <span className="diff-status">{statusLabel(file)}</span>
        <span className="diff-counts">{countsLabel(file)}</span>
      </button>
      {open && (
        <div className="diff-body">
          {file.binary && <p className="absent">Binary file — git produced no text diff.</p>}
          {!file.binary && file.hunks.length === 0 && (
            <p className="absent">
              No line changes{file.modeChange !== null ? " (file mode only)" : ""}.
            </p>
          )}
          {file.hunks.map((hunk, index) => (
            <div className="diff-hunk" key={index}>
              <div className="hunk-head">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div className={`diff-line ${line.kind}`} key={lineIndex}>
                  <span className="ln">{pad(line.oldLine)}</span>
                  <span className="ln">{pad(line.newLine)}</span>
                  <span className="mk">{lineMarker(line)}</span>
                  <span className="tx">
                    {line.text}
                    {line.noNewline === true && (
                      <span className="absent"> ⏎ no newline at end of file</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {file.truncated && (
            <p className="absent">
              Large file — showing the first part of this diff. The change counts above
              are complete. See it in full with <code>git show {file.path}</code>.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function DiffPane({ sha }: { sha: string }) {
  const result = useFetch<ReviewDiffData>(`/api/diff/${sha}`);

  if (result.state === "loading") {
    return <p className="loading">Loading the diff…</p>;
  }
  if (result.state === "error") {
    return <div className="error-box">Could not load the diff: {result.error}</div>;
  }

  const data: ReviewDiffData = result.data;
  const gutter = gutterWidth(data.files);

  return (
    <section className="diff" aria-labelledby="diff-heading">
      <h3 id="diff-heading">
        Code
        <span className="diff-totals">
          {data.totals.files} file{data.totals.files === 1 ? "" : "s"} · +
          {data.totals.additions} −{data.totals.deletions}
        </span>
      </h3>
      {data.warnings.map((warning, index) => (
        <p className="diff-warning" key={index}>
          {warning}
        </p>
      ))}
      {data.files.length === 0 && (
        <p className="absent">This commit changed no files (an empty commit).</p>
      )}
      {data.files.map((file) => (
        <FilePane
          key={`${file.oldPath ?? ""}→${file.path}`}
          file={file}
          gutter={gutter}
          defaultOpen={startsOpen(file, data.files.length)}
        />
      ))}
    </section>
  );
}

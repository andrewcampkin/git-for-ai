// Branch selector (DESKTOP.md §5 step 3, item 2 of the v1 feature set). Selecting a branch
// scopes the overview to that branch's history via `/api/overview?rev=`.
//
// Design note (deviation from DESKTOP.md §3, recorded rather than done silently): the plan
// said "sidebar". This page is a single narrow reading column, and most repos have a
// handful of branches — a permanent sidebar would spend the page's scarcest resource
// (horizontal space) on a control used once a session. So the same function ships as a
// compact chip row under the masthead, with a fold once there are more branches than fit.
// If the desktop window later grows a real multi-pane layout, this component moves; its
// contract (a rev in, a rev out) does not change.
//
// Metadata refs can't appear here: the server lists `refs/heads/` only (reviewGit.ts #1).

import { useState } from "react";

import type { ReviewBranchesData } from "../types";
import { branchTitle, orderBranches, trackLabel } from "../lib/branches";
import { useFetch } from "../lib/useFetch";

/** How many chips render before the rest fold away. */
const VISIBLE_CHIPS = 8;

export function BranchBar({
  rev,
  onSelect,
}: {
  /** The rev the overview is currently scoped to; null means HEAD. */
  rev: string | null;
  onSelect: (rev: string | null) => void;
}) {
  const result = useFetch<ReviewBranchesData>("/api/branches");
  const [expanded, setExpanded] = useState(false);

  // A branch list that fails to load is not worth an error box on a page whose job is
  // something else — the timeline below is still correct, scoped to HEAD.
  if (result.state !== "ok" || result.data.branches.length === 0) {
    return null;
  }

  const data = result.data;
  const ordered = orderBranches(data.branches);
  const visible = expanded ? ordered : ordered.slice(0, VISIBLE_CHIPS);
  const hidden = ordered.length - visible.length;
  const selected = rev === null ? undefined : ordered.find((branch) => branch.name === rev);

  return (
    <nav className="branch-bar" aria-label="branches">
      <span className="branch-label">
        {data.detached ? "detached HEAD" : "branches"}
      </span>
      <button
        type="button"
        className={`branch-chip${rev === null ? " selected" : ""}`}
        onClick={() => onSelect(null)}
        title="the checked-out revision"
      >
        HEAD
      </button>
      {visible.map((branch) => (
        <button
          key={branch.ref}
          type="button"
          className={`branch-chip${rev === branch.name ? " selected" : ""}${
            branch.current ? " current" : ""
          }`}
          onClick={() => onSelect(branch.name)}
          title={branchTitle(branch)}
        >
          {branch.name}
          {branch.upstream !== null && (branch.ahead ?? 0) + (branch.behind ?? 0) > 0 && (
            <span className="branch-track">
              {(branch.ahead ?? 0) > 0 && `↑${branch.ahead}`}
              {(branch.behind ?? 0) > 0 && `↓${branch.behind}`}
            </span>
          )}
        </button>
      ))}
      {hidden > 0 && (
        <button type="button" className="branch-more" onClick={() => setExpanded(true)}>
          {hidden} more…
        </button>
      )}
      {selected !== undefined && (
        <span className="branch-scope">
          showing <strong>{selected.name}</strong> — {trackLabel(selected)}
        </span>
      )}
    </nav>
  );
}

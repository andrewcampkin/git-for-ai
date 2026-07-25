// Plain-git read helpers the review server serves: the branch list and per-commit diffs
// (architecture/DESKTOP.md §5 step 2 — "API groundwork", still strictly read-only, so the
// browser mode gains them too). They live beside ./review.ts rather than inside it because
// diff parsing is real work, and beside it rather than in `core` because nothing else in
// the system needs them: this is presentation shaping for one consumer, the UI.
//
// Read-path discipline (the rule from ./log.ts / ./show.ts / ./report.ts): these are READS.
// They run `git for-each-ref`, `git log -1`, `git show`, `git diff` and nothing else — no
// identity is resolved, minted, or healed here, so serving them keeps every ref
// byte-identical (review.test.ts asserts that property across the whole surface).
//
// Judgment calls:
//   1. **Metadata refs are invisible.** DESKTOP.md §1's design note: `refs/git-for-ai/*`
//      and `refs/notes/*` carry our own storage commits and must never appear in a branch
//      or graph view. `listBranches` reads `refs/heads/` exclusively, so they cannot leak
//      in by construction (not by filtering after the fact).
//   2. **A merge commit's diff is shown against its FIRST parent, and said so out loud.**
//      `git show` on a merge prints nothing by default, which would render as "this merge
//      changed nothing" — a lie of omission in a tool whose product is honesty. We diff
//      against parent 1 (what every review tool means by "the merge's changes") and return
//      both `against` and an explicit warning so the UI can label it.
//   3. **Truncation is reported, never silent.** A huge commit is capped at
//      MAX_TOTAL_LINES / MAX_LINES_PER_FILE stored diff lines, but the +/- counts keep
//      being tallied past the cap, so the stats stay true even when the body is clipped.
//      Every clip sets a `truncated` flag the UI must render.
//   4. **`core.quotePath=false`** is set per-invocation so non-ASCII paths arrive as real
//      UTF-8 rather than octal escapes; the residual quoting cases (a path containing a
//      quote, backslash, or control character) are handled by `unquotePath`.

import { runGit, type GitContext } from "@git-for-ai/core";

// ---------------------------------------------------------------------------------------
// Branches (`GET /api/branches`)
// ---------------------------------------------------------------------------------------

/** One local branch, as the sidebar renders it. */
export interface ReviewBranch {
  /** Short name (`main`), suitable for `?rev=`. */
  name: string;
  /** Full ref (`refs/heads/main`) — the unambiguous identity. */
  ref: string;
  sha: string;
  shortSha: string;
  /** True for the checked-out branch. Always false when HEAD is detached. */
  current: boolean;
  /** Tip commit subject and committer date (RFC 3339) — timeline context in the list. */
  subject: string;
  committerDate: string;
  /** Configured upstream (`origin/main`), or null when the branch tracks nothing. */
  upstream: string | null;
  /** Ahead/behind the upstream, as git already computed it; null without an upstream. */
  ahead: number | null;
  behind: number | null;
}

/** `GET /api/branches` — local branches only; metadata refs are structurally excluded. */
export interface ReviewBranchesData {
  /** Checked-out branch name, or null when HEAD is detached. */
  current: string | null;
  /** True when HEAD points at a commit rather than a branch (honest, not hidden). */
  detached: boolean;
  /** HEAD's commit SHA, or null on an unborn branch. */
  headSha: string | null;
  /** Newest-committer-date first — the order a human scans for "what was I doing". */
  branches: ReviewBranch[];
}

/** Field separator for git format strings (`%1f` / `%x1f`) — never appears in a subject. */
const FIELD_SEP = "\u001f";

/** Parse git's `%(upstream:track)` — `[ahead 2, behind 1]`, `[gone]`, or empty. */
function parseTrack(track: string): { ahead: number | null; behind: number | null } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (ahead === null && behind === null) {
    // An upstream with no divergence reports nothing; "in sync" is 0/0, not unknown.
    return { ahead: 0, behind: 0 };
  }
  return {
    ahead: ahead === null ? 0 : Number.parseInt(ahead[1]!, 10),
    behind: behind === null ? 0 : Number.parseInt(behind[1]!, 10),
  };
}

/** List local branches (`refs/heads/` only — judgment call #1), newest commit first. */
export async function listBranches(ctx: GitContext = {}): Promise<ReviewBranchesData> {
  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  const symbolic = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    ...ctx,
    allowFailure: true,
  });
  const current = symbolic.exitCode === 0 && symbolic.stdout.length > 0 ? symbolic.stdout : null;

  const headRev = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
    ...ctx,
    allowFailure: true,
  });
  const headSha = headRev.exitCode === 0 && headRev.stdout.length > 0 ? headRev.stdout : null;

  const format = [
    "%(refname:short)",
    "%(refname)",
    "%(objectname)",
    "%(objectname:short)",
    "%(committerdate:iso-strict)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(contents:subject)",
  ].join("%1f");
  const result = await runGit(
    ["for-each-ref", `--format=${format}`, "--sort=-committerdate", "refs/heads/"],
    ctx,
  );

  const branches: ReviewBranch[] =
    result.stdout.length === 0
      ? []
      : result.stdout.split("\n").flatMap((line) => {
          const [name, ref, sha, shortSha, committerDate, upstream, track, ...rest] =
            line.split(FIELD_SEP);
          if (name === undefined || name.length === 0 || ref === undefined || sha === undefined) {
            return [];
          }
          const tracking = upstream !== undefined && upstream.length > 0;
          const { ahead, behind } = tracking
            ? parseTrack(track ?? "")
            : { ahead: null, behind: null };
          return [
            {
              name,
              ref,
              sha,
              shortSha: shortSha ?? sha.slice(0, 7),
              current: current !== null && name === current,
              subject: rest.join(FIELD_SEP),
              committerDate: committerDate ?? "",
              upstream: tracking ? upstream : null,
              ahead,
              behind,
            },
          ];
        });

  return { current, detached: headSha !== null && current === null, headSha, branches };
}

// ---------------------------------------------------------------------------------------
// Commit diff (`GET /api/diff/:sha`)
// ---------------------------------------------------------------------------------------

/** One rendered diff line. Exactly one of oldLine/newLine is null on +/- lines. */
export interface ReviewDiffLine {
  kind: "context" | "add" | "del";
  /** 1-based line number in the pre-image, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the post-image, or null for a deleted line. */
  newLine: number | null;
  /** Line content WITHOUT the leading +/-/space marker. */
  text: string;
  /** True when git reported "\ No newline at end of file" for this line. */
  noNewline?: boolean;
}

/** One `@@` hunk. */
export interface ReviewDiffHunk {
  /** The raw header line, including git's trailing section heading when present. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ReviewDiffLine[];
}

export type ReviewDiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

/** One file's diff within a commit. */
export interface ReviewDiffFile {
  /** Post-image path (pre-image path for a deletion) — what the UI titles the pane. */
  path: string;
  /** Pre-image path, present only for renames/copies. */
  oldPath: string | null;
  status: ReviewDiffStatus;
  additions: number;
  deletions: number;
  /** True when git could not produce a text patch; `hunks` is then empty. */
  binary: boolean;
  /** Mode change (`100644` → `100755`), when git reported one. */
  modeChange: { from: string; to: string } | null;
  /** Rename/copy similarity percentage, when git reported one. */
  similarity: number | null;
  hunks: ReviewDiffHunk[];
  /** True when this file's body hit a cap; the counts above are still complete. */
  truncated: boolean;
}

/** `GET /api/diff/:sha` — one commit's diff, with honest merge and truncation labeling. */
export interface ReviewDiffData {
  sha: string;
  shortSha: string;
  subject: string;
  /** Full parent SHAs, in git's order. Empty for a root commit. */
  parents: string[];
  /** The SHA this diff is against: parent 1, or null for a root commit (vs the empty tree). */
  against: string | null;
  isMerge: boolean;
  files: ReviewDiffFile[];
  totals: { files: number; additions: number; deletions: number };
  /** True when any cap was hit anywhere in this diff. */
  truncated: boolean;
  /** Explicit notices (merge-vs-first-parent, truncation) — never silent. */
  warnings: string[];
}

/** Options for {@link readCommitDiff} (all defaults are the server's). */
export interface ReadCommitDiffOptions extends GitContext {
  /** Context lines around each hunk (`git diff --unified`). Default 3. */
  contextLines?: number;
}

/** Caps (judgment call #3): generous for review, bounded against a pathological commit. */
const MAX_TOTAL_LINES = 20_000;
const MAX_LINES_PER_FILE = 2_000;

/**
 * Undo git's C-style path quoting (`"src/caf\303\251.ts"`). With core.quotePath=false most
 * paths arrive raw; quotes remain only for paths containing `"`, `\`, or control chars.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    const simple: Record<string, number> = {
      a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
    };
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    bytes.push(...Buffer.from(next, "utf8"));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip git's `a/` / `b/` prefix from a `---` / `+++` path; `/dev/null` becomes null. */
function stripPrefix(raw: string): string | null {
  const path = unquotePath(raw.trim());
  if (path === "/dev/null") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

interface DiffParseState {
  files: ReviewDiffFile[];
  storedLines: number;
  truncated: boolean;
}

/** Parse a unified patch (`git show`/`git diff` output) into structured files and hunks. */
function parsePatch(patch: string): DiffParseState {
  const state: DiffParseState = { files: [], storedLines: 0, truncated: false };
  if (patch.length === 0) return state;

  let file: ReviewDiffFile | null = null;
  let hunk: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Header-derived paths win over the ambiguous `diff --git a/x b/y` line (paths may
  // contain spaces); this holds what the headers said until the file is pushed.
  let headerOld: string | null = null;
  let headerNew: string | null = null;

  const finishFile = (): void => {
    if (file === null) return;
    if (headerNew !== null) file.path = headerNew;
    else if (headerOld !== null && file.status === "deleted") file.path = headerOld;
    if (headerOld !== null && (file.status === "renamed" || file.status === "copied")) {
      file.oldPath = headerOld;
    }
    state.files.push(file);
    file = null;
    hunk = null;
    headerOld = null;
    headerNew = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      // Fallback path from the `diff --git a/x b/y` line, used only if the ---/+++ and
      // rename headers below say nothing (they are unambiguous; this line is not, since a
      // path may itself contain " b/"). Last occurrence wins, which is right far more
      // often than the first.
      const rest = line.slice("diff --git ".length);
      const split = rest.lastIndexOf(" b/");
      file = {
        path: split === -1 ? rest : unquotePath(rest.slice(split + 3)),
        oldPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        modeChange: null,
        similarity: null,
        hunks: [],
        truncated: false,
      };
      continue;
    }
    if (file === null) continue;

    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match !== null) {
        oldLine = Number.parseInt(match[1]!, 10);
        newLine = Number.parseInt(match[3]!, 10);
        hunk = {
          header: line,
          oldStart: oldLine,
          oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
          newStart: newLine,
          newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
          lines: [],
        };
        file.hunks.push(hunk);
      }
      continue;
    }

    if (hunk === null) {
      // Still in the extended-header block for this file.
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        headerOld = unquotePath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        headerNew = unquotePath(line.slice("rename to ".length));
      } else if (line.startsWith("copy from ")) {
        file.status = "copied";
        headerOld = unquotePath(line.slice("copy from ".length));
      } else if (line.startsWith("copy to ")) {
        headerNew = unquotePath(line.slice("copy to ".length));
      } else if (line.startsWith("similarity index ")) {
        const pct = Number.parseInt(line.slice("similarity index ".length), 10);
        file.similarity = Number.isNaN(pct) ? null : pct;
      } else if (line.startsWith("old mode ")) {
        file.modeChange = { from: line.slice("old mode ".length).trim(), to: "" };
      } else if (line.startsWith("new mode ") && file.modeChange !== null) {
        file.modeChange.to = line.slice("new mode ".length).trim();
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.binary = true;
      } else if (line.startsWith("--- ")) {
        const path = stripPrefix(line.slice(4));
        if (path !== null && headerOld === null) headerOld = path;
      } else if (line.startsWith("+++ ")) {
        const path = stripPrefix(line.slice(4));
        if (path !== null) headerNew = path;
      }
      continue;
    }

    // Inside a hunk body.
    if (line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last !== undefined) last.noNewline = true;
      continue;
    }
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      // Every hunk-body line git emits carries a space/+/- marker — an EMPTY context line
      // is " ", not "". So a truly empty line here is not diff content: it is the trailing
      // newline of the patch (we read the output unstripped). Counting it as context
      // would append a phantom line to every file's last hunk.
      continue;
    }

    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    if (kind === "add") file.additions += 1;
    if (kind === "del") file.deletions += 1;

    // Counts above are always tallied; only STORAGE is capped (judgment call #3).
    const fileLines = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    if (state.storedLines >= MAX_TOTAL_LINES || fileLines >= MAX_LINES_PER_FILE) {
      file.truncated = true;
      state.truncated = true;
    } else {
      hunk.lines.push({
        kind,
        oldLine: kind === "add" ? null : oldLine,
        newLine: kind === "del" ? null : newLine,
        text: line.slice(1),
      });
      state.storedLines += 1;
    }
    if (kind !== "add") oldLine += 1;
    if (kind !== "del") newLine += 1;
  }
  finishFile();
  return state;
}

/**
 * Read one commit's diff. `target` is any rev git accepts (SHA, short SHA, branch); an
 * unresolvable target throws (GitError) — the caller maps that to a 404 with the reason.
 */
export async function readCommitDiff(
  target: string,
  options: ReadCommitDiffOptions = {},
): Promise<ReviewDiffData> {
  const ctx: GitContext = options.cwd !== undefined ? { cwd: options.cwd } : {};
  const unified = options.contextLines ?? 3;

  const meta = await runGit(["log", "-1", "--format=%H%x1f%h%x1f%P%x1f%s", target], ctx);
  const [sha, shortSha, parentList, ...rest] = meta.stdout.split(FIELD_SEP);
  if (sha === undefined || sha.length === 0 || shortSha === undefined) {
    throw new Error(`cannot resolve commit: ${target}`);
  }
  const parents = (parentList ?? "").split(" ").filter((p) => p.length > 0);
  const isMerge = parents.length > 1;
  const warnings: string[] = [];

  // Judgment call #2: a merge is diffed against parent 1 and labeled, never shown empty.
  const args = ["-c", "core.quotePath=false"];
  if (isMerge) {
    args.push("diff", `--unified=${unified}`, "-M", "--no-color", "--no-ext-diff", parents[0]!, sha);
    warnings.push(
      `Merge commit — showing what it brought in, compared with ${parents[0]!.slice(0, 7)}.`,
    );
  } else {
    args.push(
      "show",
      "--format=",
      `--unified=${unified}`,
      "-M",
      "--root",
      "--no-color",
      "--no-ext-diff",
      sha,
    );
  }
  const patch = await runGit(args, { ...ctx, stripFinalNewline: false });
  const parsed = parsePatch(patch.stdout);

  if (parsed.truncated) {
    warnings.push(
      "Very large commit — some file diffs are shortened. The change counts are complete.",
    );
  }

  return {
    sha,
    shortSha,
    subject: rest.join(FIELD_SEP),
    parents,
    against: parents[0] ?? null,
    isMerge,
    files: parsed.files,
    totals: {
      files: parsed.files.length,
      additions: parsed.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: parsed.files.reduce((sum, f) => sum + f.deletions, 0),
    },
    truncated: parsed.truncated,
    warnings,
  };
}

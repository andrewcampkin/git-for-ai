// `git for-ai log --intent`.
//
// `git log` annotated with the effective one-line intent summary per commit, matching the
// example output in architecture/CLI_REFERENCE.md / ARCHITECTURE.md §9.1:
//
//   b7c3e2a  9f2c1a7b  Switch session store to signed-cookie tokens        [agent, conf 0.82]
//   3d1f0a2  3d1f0a2b  Add rate limiting to /login                         [agent, conf 0.74]
//   a0f1c2d  —         Initial auth scaffolding                            [no intent: pre-git-for-ai]
//
// Honest degradation is a hard requirement (ARCHITECTURE.md's stated goals): a commit with
// no ledger entry NEVER gets a fabricated summary. Its row shows the commit's own subject
// line — plain git metadata, explicitly labelled `[no intent: pre-git-for-ai]` — and an
// em-dash where the change-id would go if it has no identity either.
//
// Identity-resolution side effects (a deliberate judgment call, documented here):
// `resolveChangeId` is self-healing — its R2/R3 branches write trailer-recovered identity
// back into the change-map, which is exactly the "recovery is triggered by ANY read"
// behavior §7.5 wants, so this command DOES invoke it for every commit that shows evidence
// of identity (a change-map row or a Change-Id trailer). But its R4/R5 branches would
// *mint* map rows (inferred continuations / orphan ids) for commits that have no identity
// at all — running that over an entire pre-git-for-ai history on every `log` invocation
// would flood the change-map with orphan rows (and R4's parent-inference would chain down
// a linear history, folding unrelated commits into one change). So commits with neither a
// map row nor a trailer are rendered with an em-dash and resolveChangeId is not called.

import type { LedgerEntry } from "@git-for-ai/schemas";
import {
  runGit,
  readCommitMessage,
  parseChangeIdTrailer,
  findEntryByCommitSha,
  resolveChangeId,
  readLedgerEntries,
  resolveEffectiveEntry,
  LedgerNoteFormatError,
  type GitContext,
} from "@git-for-ai/core";

/** Options for {@link runLog}, mirroring the flags in CLI_REFERENCE.md's `log --intent`. */
export interface LogIntentOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /**
   * Revision to walk history from. Defaults to `HEAD` (current branch history). When the
   * default is used against a repo with no commits yet, the result is empty rather than
   * an error; an explicitly-passed unresolvable rev still errors.
   */
  rev?: string;
  /** `<path>` — scope the walk to commits touching a file or directory. */
  path?: string;
  /** `-n <N>` — limit to the N most recent commits. */
  maxCount?: number;
  /** `--since <date>` — passed through to `git log --since`. */
  since?: string;
  /** `--until <date>` — passed through to `git log --until`. */
  until?: string;
  /** `--change` — show the full change-id in place of the abbreviated commit SHA. */
  change?: boolean;
}

/** One annotated commit row, in the structured form (pre-rendering). */
export interface LogIntentLine {
  /** Full 40-hex commit SHA. */
  sha: string;
  /** Abbreviated SHA as git chose to abbreviate it (`%h`). */
  shortSha: string;
  /** Resolved change-id (32 hex), or null when the commit has no identity. */
  changeId: string | null;
  /**
   * The one-line summary shown for the commit: the effective ledger entry's `summary`
   * when one exists, otherwise the commit's own subject line (git metadata, never a
   * fabricated intent — the annotation labels which one it is).
   */
  summary: string;
  /** Bracketed annotation text, e.g. `agent, conf 0.82` or `no intent: pre-git-for-ai`. */
  annotation: string;
  /** True when a real ledger entry backs `summary`; false for the degraded git-metadata row. */
  hasIntent: boolean;
}

/** Result of {@link runLog}: the rendered console output plus the structured rows behind it. */
export interface LogIntentResult {
  /** Structured per-commit rows, newest first (for `--json` and testing). */
  lines: LogIntentLine[];
  /** The rendered, column-aligned console output (no trailing newline). Empty for no commits. */
  output: string;
}

/** Placeholder shown in the change-id column for commits with no identity. */
const NO_CHANGE_ID = "—"; // em-dash, per the CLI_REFERENCE.md example

/** Degraded-case annotation for a commit with no ledger entry (CLI_REFERENCE.md example). */
const NO_INTENT_ANNOTATION = "no intent: pre-git-for-ai";

/** Annotation when a ledger note exists but is unusable — degrade honestly, never guess. */
const UNREADABLE_ANNOTATION = "no intent: ledger note unreadable";

/** Summaries longer than this are truncated (with an ellipsis) to keep columns readable. */
const SUMMARY_COLUMN_CAP = 72;

/** Build a GitContext without materializing undefined keys (exactOptionalPropertyTypes). */
function toContext(options: LogIntentOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

interface WalkedCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

/** Field separator for the `git log` format string — never appears in a subject line. */
const FIELD_SEP = "\u001f";

/** Walk the requested commit range via real `git log`, newest first. */
async function walkCommits(options: LogIntentOptions, ctx: GitContext): Promise<WalkedCommit[]> {
  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  // An unborn branch (fresh `git init`, no commits) is an empty log, not an error — but
  // only for the *default* rev; an explicitly-requested rev that doesn't resolve should
  // surface git's own error below.
  if (options.rev === undefined) {
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
      ...ctx,
      allowFailure: true,
    });
    if (head.exitCode !== 0) {
      return [];
    }
  }

  const args = ["log", `--format=%H%x1f%h%x1f%s`];
  if (options.maxCount !== undefined) {
    args.push("-n", String(options.maxCount));
  }
  if (options.since !== undefined) {
    args.push(`--since=${options.since}`);
  }
  if (options.until !== undefined) {
    args.push(`--until=${options.until}`);
  }
  args.push(options.rev ?? "HEAD");
  if (options.path !== undefined) {
    args.push("--", options.path);
  }

  const result = await runGit(args, ctx);
  if (result.stdout.length === 0) {
    return [];
  }

  return result.stdout.split("\n").flatMap((line) => {
    const [sha, shortSha, ...rest] = line.split(FIELD_SEP);
    if (sha === undefined || sha.length === 0 || shortSha === undefined) {
      return [];
    }
    return [{ sha, shortSha, subject: rest.join(FIELD_SEP) }];
  });
}

/**
 * Resolve a walked commit's change-id, if it has any evidence of identity.
 *
 * Returns null for commits with neither a change-map row nor a Change-Id trailer —
 * deliberately NOT calling resolveChangeId for those, so a `log` over pre-git-for-ai
 * history never mints orphan/inferred map rows as a side effect (see module header).
 */
async function resolveIdentityIfPresent(sha: string, ctx: GitContext): Promise<string | null> {
  const mapped = await findEntryByCommitSha(sha, ctx);
  if (mapped === null) {
    const message = await readCommitMessage(sha, ctx);
    if (parseChangeIdTrailer(message) === null) {
      return null;
    }
  }
  // Map row (R1) or trailer (R2/R3 lazy healing): the full resolver is authoritative,
  // follows folded_into redirects, and writes back any trailer-recovered identity.
  const resolution = await resolveChangeId(sha, ctx);
  return resolution.changeId;
}

/**
 * Read the ledger entries recorded on a commit. An unreadable-but-present note is
 * reported (never silently treated as absent, and never guessed at) via `unreadable`.
 */
async function collectEntries(
  sha: string,
  ctx: GitContext,
): Promise<{ entries: LedgerEntry[]; unreadable: boolean }> {
  try {
    const entries = await readLedgerEntries(sha, ctx);
    return { entries: entries ?? [], unreadable: false };
  } catch (error) {
    if (error instanceof LedgerNoteFormatError) {
      return { entries: [], unreadable: true };
    }
    throw error;
  }
}

/** `agent, conf 0.82`-style annotation for a real ledger entry. */
function intentAnnotation(entry: LedgerEntry): string {
  const confidence = entry.reasoning?.confidence;
  return confidence === undefined
    ? entry.author.type
    : `${entry.author.type}, conf ${confidence.toFixed(2)}`;
}

/** Truncate a summary to the column cap, marking the cut with an ellipsis. */
function clampSummary(summary: string): string {
  return summary.length > SUMMARY_COLUMN_CAP
    ? `${summary.slice(0, SUMMARY_COLUMN_CAP - 1)}…`
    : summary;
}

/** Render the column-aligned console output from the structured rows. */
function render(lines: LogIntentLine[], showChangeIdInsteadOfSha: boolean): string {
  if (lines.length === 0) {
    return "";
  }

  const rows = lines.map((line) => {
    const summary = clampSummary(line.summary);
    const cols = showChangeIdInsteadOfSha
      ? [line.changeId ?? NO_CHANGE_ID]
      : [line.shortSha, line.changeId === null ? NO_CHANGE_ID : line.changeId.slice(0, 8)];
    return { cols: [...cols, summary], annotation: `[${line.annotation}]` };
  });

  const columnCount = rows[0]!.cols.length;
  const widths = Array.from({ length: columnCount }, (_, i) =>
    Math.max(...rows.map((row) => row.cols[i]!.length)),
  );

  return rows
    .map((row) =>
      [...row.cols.map((col, i) => col.padEnd(widths[i]!)), row.annotation].join("  "),
    )
    .join("\n");
}

/**
 * `git for-ai log --intent`: walk the requested commit range and annotate each commit
 * with its resolved change-id and effective one-line intent summary, degrading honestly
 * (commit subject + `[no intent: pre-git-for-ai]`) for commits with no captured intent.
 *
 * Returns both the rendered console output (`output`) and the structured rows behind it
 * (`lines`, for `--json`). A future bin.ts wires this as:
 *
 *   const { output } = await runLog({ ...flags });
 *   if (output.length > 0) console.log(output);
 */
export async function runLog(options: LogIntentOptions = {}): Promise<LogIntentResult> {
  const ctx = toContext(options);
  const commits = await walkCommits(options, ctx);

  const lines: LogIntentLine[] = [];
  for (const commit of commits) {
    const changeId = await resolveIdentityIfPresent(commit.sha, ctx);
    const { entries, unreadable } = await collectEntries(commit.sha, ctx);
    const effective = entries.length > 0 ? resolveEffectiveEntry(entries) : null;

    if (effective !== null) {
      lines.push({
        sha: commit.sha,
        shortSha: commit.shortSha,
        // The resolver's answer wins (it follows folded_into redirects); the entry's own
        // change_id covers the corner where a note exists but the map row was lost.
        changeId: changeId ?? effective.change_id,
        summary: effective.summary,
        annotation: intentAnnotation(effective),
        hasIntent: true,
      });
    } else {
      // Hard requirement: no ledger entry means NO fabricated summary. Show git's own
      // subject line, labelled as exactly that.
      lines.push({
        sha: commit.sha,
        shortSha: commit.shortSha,
        changeId,
        summary: commit.subject,
        annotation: unreadable ? UNREADABLE_ANNOTATION : NO_INTENT_ANNOTATION,
        hasIntent: false,
      });
    }
  }

  return { lines, output: render(lines, options.change === true) };
}

// `git for-ai report` — the first human-visible surface (architecture/PLAN_2026-07-18.md
// §2.2 item 2): a generated digest of agent activity over a commit range, as a single
// self-contained HTML page (default) or plain Markdown. Its job is the "prove it" pixel —
// the claim (summary/intent) rendered next to its evidence (tested commands, session
// capture, confidence/risk flags) — so a human can review what their agents did and why.
//
// Read-path discipline (the same deliberate judgment call documented in ./log.ts and
// ./show.ts): a report is a READ and must never write identity as a side effect.
// `resolveChangeId`'s R4/R5 branches mint inferred/orphan change-map rows, so commits with
// neither a change-map row nor a Change-Id trailer are rendered without identity and the
// resolver is never invoked for them.
//
// Honest degradation is a hard requirement (ARCHITECTURE.md's stated goals) and here it is
// also the product: a report that quietly fabricated intent would destroy the very trust
// the surface exists to build. Every absent piece of data is explicitly labeled:
//   - a commit with no ledger entry shows its own git subject, marked "no captured intent";
//   - an unreadable ledger note becomes a visible warning, never silence;
//   - a session_ref that cannot be resolved renders "session trace unavailable" + reason;
//   - absent reasoning fields render "not captured", never a guess.
// Superseded ledger entries are collapsed but present (DATA_MODEL.md §2.4: retained,
// never deleted).

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { LedgerEntry, Provenance, SessionRecord } from "@git-for-ai/schemas";
import {
  runGit,
  readCommitMessage,
  parseChangeIdTrailer,
  resolveChangeId,
  readChangeMapSnapshot,
  readLedgerEntries,
  readLedgerNotesForCommits,
  resolveEffectiveEntry,
  readSessionRecord,
  readSessionRecords,
  LedgerNoteFormatError,
  canonicalJsonStringify,
  type ChangeMapSnapshot,
  type GitContext,
} from "@git-for-ai/core";

// ---------------------------------------------------------------------------------------
// Options and structured result types
// ---------------------------------------------------------------------------------------

/** Options for {@link runReport} (`git for-ai report`). */
export interface ReportOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--since <date>` — passed through to `git log --since`. */
  since?: string;
  /** `--until <date>` — passed through to `git log --until`. */
  until?: string;
  /** `-n <N>` — limit to the N most recent commits. */
  maxCount?: number;
  /**
   * Revision to walk (any `git log` rev: a branch name, tag, SHA). Default HEAD.
   * Same contract as ./log.ts: an unborn HEAD is an empty report, but an explicitly
   * requested rev that does not resolve is an error (never silently an empty report).
   */
  rev?: string;
  /** Output format. Default `html` (self-contained page); `md` is the same content plainly. */
  format?: "md" | "html";
  /** `--out <path>` — also write the rendered report to this file (relative to cwd). */
  out?: string;
}

/** Attribution badge for a timeline row / change section, derived from ledger data only. */
export interface ReportBadge {
  /** `none` = no ledger entry backs this row (the honest-degradation case). */
  kind: "agent" | "human" | "mixed" | "none";
  tool?: string;
  model?: string;
  /** Rendered label, e.g. `agent · claude-code · claude-opus-4-8` or `no captured intent`. */
  label: string;
}

/** Reasoning flags surfaced on a row when present (DATA_MODEL.md §2.5). Never fabricated. */
export interface ReportFlags {
  confidence?: number;
  scopeRisk?: "low" | "medium" | "high";
  reversibility?: "easy" | "moderate" | "hard";
}

/** One timeline entry (newest first). Summary source is always explicit. */
export interface ReportTimelineRow {
  /** Full 40-hex commit SHA. */
  sha: string;
  /** Abbreviated SHA as git chose to abbreviate it (`%h`). */
  shortSha: string;
  /** The commit's own subject line (git metadata, always real). */
  subject: string;
  /** Git author name/email/date — plain git metadata, shown as exactly that. */
  authorName: string;
  authorEmail: string;
  /** RFC 3339 author date (`%aI`). */
  authorDate: string;
  /** Resolved change-id, or null when the commit has no identity (non-minting read). */
  changeId: string | null;
  /** Effective ledger summary when one exists, else the commit's own subject line. */
  summary: string;
  /** True when a real ledger entry backs `summary`. */
  hasIntent: boolean;
  /** Where `summary` came from — the honesty label the renderers display. */
  summarySource: "ledger" | "git-subject" | "git-subject-note-unreadable";
  badge: ReportBadge;
  flags: ReportFlags;
  provenance?: Provenance;
}

/** One ledger entry row within a change section. */
export interface ReportLedgerRow {
  entry: LedgerEntry;
  /** True for the single effective entry (DATA_MODEL.md §2.4); false = superseded. */
  effective: boolean;
}

/** Session lookup outcome for a change's effective entry (never guessed, never faked). */
export interface ReportSessionInfo {
  ref: string | null;
  /** `none` = no ref recorded; `unavailable` = ref present but unresolvable. */
  status: "none" | "available" | "unavailable";
  /** Why the session trace is unavailable (present iff status is `unavailable`). */
  reason?: string;
  agentTool?: string;
  agentModel?: string;
  agentVersion?: string;
  spanCount?: number;
  capturedAt?: string;
  /** The session record's own compressed summary, when it carries one. */
  summary?: string;
}

/** A commit reference inside a change section (in-range members, newest first). */
export interface ReportChangeCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorDate: string;
}

/** Per-change detail section (linked from the timeline). */
export interface ReportChangeSection {
  changeId: string;
  /** In-range commits belonging to this change, newest first. */
  commits: ReportChangeCommit[];
  /** Every ledger entry found for the change, oldest first, effective one marked. */
  entries: ReportLedgerRow[];
  /** The effective entry, or null when the change has identity but no captured intent. */
  effective: LedgerEntry | null;
  /** Count of superseded (collapsed-but-present) entries. */
  supersededCount: number;
  session: ReportSessionInfo;
}

/** Header totals. "Agent vs human" counts classify commits by their effective entry. */
export interface ReportTotals {
  commits: number;
  changes: number;
  agentCommits: number;
  humanCommits: number;
  mixedCommits: number;
  /** Commits with no ledger entry at all — shown, labeled, never inflated away. */
  noIntentCommits: number;
  sessionsCaptured: number;
  modelsSeen: string[];
}

/** The structured result behind the rendered report (what the tests exercise). */
export interface ReportData {
  repoName: string;
  /** When this report was generated (RFC 3339 UTC). */
  generatedAt: string;
  range: {
    /** The `--since` / `--until` filters as given, or null. */
    since: string | null;
    until: string | null;
    /** The rev walked, when one was explicitly requested; null means the default HEAD. */
    rev: string | null;
    /** Author dates of the newest/oldest commits actually in the report, or null if none. */
    newestCommitDate: string | null;
    oldestCommitDate: string | null;
  };
  totals: ReportTotals;
  /** Newest-first commit rows. */
  timeline: ReportTimelineRow[];
  /** Change sections, ordered by each change's newest in-range commit. */
  changes: ReportChangeSection[];
  /** Explicit degradation notices (e.g. unreadable ledger notes) — never silent. */
  warnings: string[];
}

/** Result of {@link runReport}: structured data, rendered output, and the written path. */
export interface ReportResult {
  data: ReportData;
  /** The rendered report (HTML page or Markdown document). */
  output: string;
  /** Absolute path the report was written to (present iff `out` was given). */
  path?: string;
}

// ---------------------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------------------

/** Build a GitContext without materializing undefined keys (exactOptionalPropertyTypes). */
function toContext(options: ReportOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

/** Field separator for `git log` format strings — never appears in a subject line. */
const FIELD_SEP = "\u001f";

interface WalkedCommit {
  sha: string;
  shortSha: string;
  authorDate: string;
  authorName: string;
  authorEmail: string;
  subject: string;
}

/** Walk the requested commit range via real `git log`, newest first (same as ./log.ts). */
async function walkCommits(options: ReportOptions, ctx: GitContext): Promise<WalkedCommit[]> {
  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  // An unborn branch (fresh `git init`, no commits) is an empty report, not an error — but
  // that leniency is for the DEFAULT rev only; an explicitly-requested rev that doesn't
  // resolve must fail loudly rather than render as "nothing happened here" (./log.ts §same).
  if (options.rev === undefined) {
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
      ...ctx,
      allowFailure: true,
    });
    if (head.exitCode !== 0) {
      return [];
    }
  }

  const args = ["log", `--format=%H%x1f%h%x1f%aI%x1f%aN%x1f%aE%x1f%s`];
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

  const result = await runGit(args, ctx);
  if (result.stdout.length === 0) {
    return [];
  }

  return result.stdout.split("\n").flatMap((line) => {
    const [sha, shortSha, authorDate, authorName, authorEmail, ...rest] = line.split(FIELD_SEP);
    if (sha === undefined || sha.length === 0 || shortSha === undefined) {
      return [];
    }
    return [
      {
        sha,
        shortSha,
        authorDate: authorDate ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        subject: rest.join(FIELD_SEP),
      },
    ];
  });
}

/** Repo display name: basename of the worktree toplevel, falling back to the git dir. */
async function readRepoName(ctx: GitContext): Promise<string> {
  const top = await runGit(["rev-parse", "--show-toplevel"], { ...ctx, allowFailure: true });
  if (top.exitCode === 0 && top.stdout.length > 0) {
    return basename(top.stdout);
  }
  const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], {
    ...ctx,
    allowFailure: true,
  });
  if (gitDir.exitCode === 0 && gitDir.stdout.length > 0) {
    return basename(gitDir.stdout).replace(/\.git$/, "");
  }
  return "repository";
}

interface ResolvedIdentity {
  changeId: string;
  history: string[];
  head: string;
}

/**
 * Resolve a walked commit's change-id, if it has any evidence of identity — the exact
 * non-minting pattern from ./log.ts / ./show.ts: commits with neither a change-map row nor
 * a Change-Id trailer return null WITHOUT calling resolveChangeId, whose R4/R5 branches
 * would mint inferred/orphan map rows as a side effect of a read.
 *
 * Performance shape (this used to dominate the whole command): the common case — the
 * commit HAS a change-map row — is answered entirely from `snapshot`, an in-memory view of
 * the map read once per report. Only the rare trailer-recovery case falls through to
 * `resolveChangeId`, which is a WRITE (lazy healing) and therefore also invalidates the
 * snapshot; the caller refreshes it when we say so.
 */
async function resolveIdentityIfPresent(
  sha: string,
  ctx: GitContext,
  snapshot: ChangeMapSnapshot,
): Promise<{ identity: ResolvedIdentity | null; healed: boolean }> {
  const mapped = snapshot.entryForCommit(sha);
  if (mapped !== null) {
    // R1, from memory: the map is authoritative, and folds are followed in the snapshot.
    const surviving = snapshot.surviving(mapped);
    return {
      identity: {
        changeId: surviving.change_id,
        history: surviving.history,
        head: surviving.head,
      },
      healed: false,
    };
  }

  const message = await readCommitMessage(sha, ctx);
  if (parseChangeIdTrailer(message) === null) {
    return { identity: null, healed: false };
  }
  // Trailer without a map row (R2/R3): the full resolver is authoritative and writes back
  // the recovered identity.
  const resolution = await resolveChangeId(sha, ctx);
  return {
    identity: {
      changeId: resolution.changeId,
      history: resolution.entry.history,
      head: resolution.entry.head,
    },
    healed: true,
  };
}

interface NoteRead {
  entries: LedgerEntry[];
  unreadable: boolean;
}

/**
 * Read the ledger entries on a commit, cached per SHA. An unreadable-but-present note is
 * reported (never silently treated as absent, never guessed at) via `unreadable`.
 */
async function readNotesCached(
  sha: string,
  ctx: GitContext,
  cache: Map<string, NoteRead>,
): Promise<NoteRead> {
  const hit = cache.get(sha);
  if (hit !== undefined) {
    return hit;
  }
  let read: NoteRead;
  try {
    const entries = await readLedgerEntries(sha, ctx);
    read = { entries: entries ?? [], unreadable: false };
  } catch (error) {
    if (error instanceof LedgerNoteFormatError) {
      read = { entries: [], unreadable: true };
    } else {
      throw error;
    }
  }
  cache.set(sha, read);
  return read;
}

/**
 * Fill the note cache for many commits in one batched read (two git invocations for the
 * whole history instead of one `notes show` per commit). Commits with no note are cached
 * as "no entries" so the fallback single read is never taken for them either.
 */
async function primeNoteCache(
  shas: string[],
  ctx: GitContext,
  cache: Map<string, NoteRead>,
): Promise<void> {
  const missing = [...new Set(shas)].filter((sha) => !cache.has(sha));
  if (missing.length === 0) {
    return;
  }
  const notes = await readLedgerNotesForCommits(missing, ctx);
  for (const sha of missing) {
    const result = notes.get(sha);
    if (result === undefined) {
      cache.set(sha, { entries: [], unreadable: false });
    } else if (result instanceof LedgerNoteFormatError) {
      cache.set(sha, { entries: [], unreadable: true });
    } else {
      cache.set(sha, { entries: result.note.entries, unreadable: false });
    }
  }
}

/** Derive the attribution badge from a ledger entry (or its honest absence). */
function toBadge(entry: LedgerEntry | null, noteUnreadable: boolean): ReportBadge {
  if (entry === null) {
    return {
      kind: "none",
      label: noteUnreadable ? "note unreadable" : "no reasoning recorded",
    };
  }
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

/** Extract the displayable reasoning flags from a ledger entry, only when present. */
function toFlags(entry: LedgerEntry | null): ReportFlags {
  const reasoning = entry?.reasoning;
  return {
    ...(reasoning?.confidence !== undefined ? { confidence: reasoning.confidence } : {}),
    ...(reasoning?.scope_risk !== undefined ? { scopeRisk: reasoning.scope_risk } : {}),
    ...(reasoning?.reversibility !== undefined
      ? { reversibility: reasoning.reversibility }
      : {}),
  };
}

/**
 * Session lookup for a change's effective entry. Read-only via core's `readSessionRecord`;
 * every failure mode becomes an explicit `unavailable` reason, never a throw and never a
 * fabricated "captured" claim.
 */
async function readSessionInfo(
  ref: string | null | undefined,
  ctx: GitContext,
  prefetched?: Map<string, SessionRecord>,
): Promise<ReportSessionInfo> {
  if (ref === undefined || ref === null) {
    return { ref: null, status: "none" };
  }
  try {
    // The batch read above already has every resolvable record; anything absent from it is
    // genuinely missing, so no per-record git call is needed to find that out.
    const record = prefetched !== undefined ? (prefetched.get(ref) ?? null) : await readSessionRecord(ref, ctx);
    if (record === null) {
      return {
        ref,
        status: "unavailable",
        reason: "no session object for this ref under refs/git-for-ai/sessions",
      };
    }
    return {
      ref,
      status: "available",
      agentTool: record.agent.tool,
      agentModel: record.agent.model,
      agentVersion: record.agent.version,
      spanCount: record.spans.length,
      capturedAt: record.captured_at,
      ...(record.summary !== undefined ? { summary: record.summary } : {}),
    };
  } catch (error) {
    return {
      ref,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Assemble the full structured report (the renderers are pure functions over this). */
async function assembleReport(options: ReportOptions, ctx: GitContext): Promise<ReportData> {
  const commits = await walkCommits(options, ctx);
  const repoName = await readRepoName(ctx);

  const noteCache = new Map<string, NoteRead>();
  const warnings: string[] = [];
  const warnedUnreadable = new Set<string>();

  const noteWarn = (sha: string): void => {
    if (!warnedUnreadable.has(sha)) {
      warnedUnreadable.add(sha);
      warnings.push(
        `ledger note on commit ${sha} is unreadable — its intent is not included in this report`,
      );
    }
  };

  interface ChangeGroup {
    changeId: string;
    history: string[];
    head: string | null;
    commits: WalkedCommit[];
  }
  const groups = new Map<string, ChangeGroup>();
  const timeline: ReportTimelineRow[] = [];

  // Two bulk reads up front replace two git subprocesses PER COMMIT. Before this, a report
  // over 41 commits spent ~2 minutes in process spawns alone.
  let snapshot = await readChangeMapSnapshot(ctx);
  await primeNoteCache(
    commits.map((commit) => commit.sha),
    ctx,
    noteCache,
  );

  for (const commit of commits) {
    const resolved = await resolveIdentityIfPresent(commit.sha, ctx, snapshot);
    const identity = resolved.identity;
    if (resolved.healed) {
      // Trailer recovery wrote to the map; the snapshot is now one revision behind.
      snapshot = await readChangeMapSnapshot(ctx);
    }
    const note = await readNotesCached(commit.sha, ctx, noteCache);
    if (note.unreadable) {
      noteWarn(commit.sha);
    }
    const effective = note.entries.length > 0 ? resolveEffectiveEntry(note.entries) : null;

    // The resolver's answer wins; the entry's own change_id covers the corner where a
    // note exists but the map row was lost (same fallback as ./log.ts).
    const changeId = identity?.changeId ?? effective?.change_id ?? null;

    timeline.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authorDate: commit.authorDate,
      changeId,
      // Hard requirement: no ledger entry means NO fabricated summary — the commit's own
      // subject line is shown, and summarySource labels it as exactly that.
      summary: effective !== null ? effective.summary : commit.subject,
      hasIntent: effective !== null,
      summarySource:
        effective !== null
          ? "ledger"
          : note.unreadable
            ? "git-subject-note-unreadable"
            : "git-subject",
      badge: toBadge(effective, note.unreadable),
      flags: toFlags(effective),
      ...(effective !== null ? { provenance: effective.provenance } : {}),
    });

    if (changeId !== null) {
      const group = groups.get(changeId) ?? {
        changeId,
        history: identity?.history ?? [],
        head: identity?.head ?? null,
        commits: [],
      };
      group.commits.push(commit);
      groups.set(changeId, group);
    }
  }

  // Per-change detail sections, in timeline order (each change's newest in-range commit).
  // The notes for every revision these sections touch are fetched in one more batch.
  await primeNoteCache(
    [...groups.values()].flatMap((group) => [
      ...group.history,
      ...(group.head !== null ? [group.head] : []),
      ...group.commits.map((commit) => commit.sha),
    ]),
    ctx,
    noteCache,
  );

  const changes: ReportChangeSection[] = [];
  const assembled: {
    group: ChangeGroup;
    entries: ReportLedgerRow[];
    effective: LedgerEntry | null;
  }[] = [];
  for (const group of groups.values()) {
    // Read the intent note on every commit this change has ever been, plus its in-range
    // members (notes stay anchored to the revision they were written against — ./show.ts).
    const noteShas = [
      ...new Set([
        ...group.history,
        ...(group.head !== null ? [group.head] : []),
        ...group.commits.map((commit) => commit.sha),
      ]),
    ];

    const seen = new Set<string>();
    const collected: LedgerEntry[] = [];
    for (const sha of noteShas) {
      const note = await readNotesCached(sha, ctx, noteCache);
      if (note.unreadable) {
        noteWarn(sha);
      }
      for (const entry of note.entries) {
        const key = canonicalJsonStringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(entry);
        }
      }
    }
    collected.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const effective = collected.length > 0 ? resolveEffectiveEntry(collected) : null;
    const entries: ReportLedgerRow[] = collected.map((entry) => ({
      entry,
      effective: entry === effective,
    }));

    assembled.push({ group, entries, effective });
  }

  // Every session these changes reference, in one batched read rather than one per change.
  const sessionRecords = await readSessionRecords(
    assembled
      .map((item) => item.effective?.session_ref)
      .filter((ref): ref is string => ref !== undefined && ref !== null),
    ctx,
  );

  for (const { group, entries, effective } of assembled) {
    changes.push({
      changeId: group.changeId,
      commits: group.commits.map((commit) => ({
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        authorDate: commit.authorDate,
      })),
      entries,
      effective,
      supersededCount: entries.filter((row) => !row.effective).length,
      session: await readSessionInfo(effective?.session_ref, ctx, sessionRecords),
    });
  }

  // Totals — commits classified by their (per-commit) effective entry; models drawn from
  // every ledger entry and captured session actually seen. Nothing is inferred.
  const models = new Set<string>();
  for (const change of changes) {
    for (const row of change.entries) {
      if (row.entry.author.model !== undefined) {
        models.add(row.entry.author.model);
      }
    }
    if (change.session.status === "available" && change.session.agentModel !== undefined) {
      models.add(change.session.agentModel);
    }
  }
  const sessionsCaptured = new Set(
    changes
      .filter((change) => change.session.status === "available")
      .map((change) => change.session.ref),
  ).size;

  const byKind = (kind: ReportBadge["kind"]): number =>
    timeline.filter((row) => row.badge.kind === kind).length;

  return {
    repoName,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    range: {
      since: options.since ?? null,
      until: options.until ?? null,
      rev: options.rev ?? null,
      newestCommitDate: timeline[0]?.authorDate ?? null,
      oldestCommitDate: timeline[timeline.length - 1]?.authorDate ?? null,
    },
    totals: {
      commits: timeline.length,
      changes: changes.length,
      agentCommits: byKind("agent"),
      humanCommits: byKind("human"),
      mixedCommits: byKind("mixed"),
      noIntentCommits: byKind("none"),
      sessionsCaptured,
      modelsSeen: [...models].sort(),
    },
    timeline,
    changes,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------------------

/** `2026-07-18 09:22` from an RFC 3339 timestamp; degraded input passes through as-is. */
function fmtWhen(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    : iso;
}

/** Human label for a summary's provenance (the honest-degradation tag). */
function sourceTag(row: ReportTimelineRow): string | null {
  switch (row.summarySource) {
    case "ledger":
      return null;
    case "git-subject":
      return "no reasoning recorded — showing the commit message";
    case "git-subject-note-unreadable":
      return "note unreadable — showing the commit message";
  }
}

/** `conf 0.82 · risk medium · undo easy` (only the flags that are actually present). */
function flagParts(flags: ReportFlags): string[] {
  const parts: string[] = [];
  if (flags.confidence !== undefined) {
    parts.push(`conf ${flags.confidence.toFixed(2)}`);
  }
  if (flags.scopeRisk !== undefined) {
    parts.push(`risk ${flags.scopeRisk}`);
  }
  if (flags.reversibility !== undefined) {
    parts.push(`undo ${flags.reversibility}`);
  }
  return parts;
}

/** One-line session summary: `claude-code 2.x (model) · 348 spans · captured <when>`. */
function sessionLine(session: ReportSessionInfo): string {
  switch (session.status) {
    case "none":
      return "no session captured";
    case "unavailable":
      return `session trace unavailable — ${session.reason ?? "unknown reason"}`;
    case "available": {
      const agent = [session.agentTool, session.agentVersion]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const model = session.agentModel !== undefined ? ` (${session.agentModel})` : "";
      const spans = `${session.spanCount ?? 0} span${session.spanCount === 1 ? "" : "s"}`;
      const captured =
        session.capturedAt !== undefined ? ` · captured ${fmtWhen(session.capturedAt)}` : "";
      return `${agent}${model} · ${spans}${captured}`;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------------------

function renderMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const { totals } = data;

  lines.push(`# Agent activity report — ${data.repoName}`);
  lines.push("");
  lines.push(`Generated ${fmtWhen(data.generatedAt)} (UTC) by \`git for-ai report\`.`);
  const rangeBits: string[] = [];
  if (data.range.rev !== null) {
    rangeBits.push(`rev ${data.range.rev}`);
  }
  if (data.range.since !== null) {
    rangeBits.push(`since ${data.range.since}`);
  }
  if (data.range.until !== null) {
    rangeBits.push(`until ${data.range.until}`);
  }
  if (data.range.oldestCommitDate !== null && data.range.newestCommitDate !== null) {
    rangeBits.push(
      `commits span ${fmtWhen(data.range.oldestCommitDate)} → ${fmtWhen(data.range.newestCommitDate)}`,
    );
  }
  if (rangeBits.length > 0) {
    lines.push(`Range: ${rangeBits.join(" · ")}.`);
  }
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Commits: ${totals.commits}`);
  lines.push(`- Changes: ${totals.changes}`);
  lines.push(
    `- Attribution: ${totals.agentCommits} agent · ${totals.humanCommits} human · ` +
      `${totals.mixedCommits} mixed · ${totals.noIntentCommits} without recorded reasoning`,
  );
  lines.push(`- Sessions captured: ${totals.sessionsCaptured}`);
  lines.push(
    `- Models seen: ${totals.modelsSeen.length > 0 ? totals.modelsSeen.join(", ") : "none recorded"}`,
  );
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  if (data.timeline.length === 0) {
    lines.push("_No commits in range._");
  }
  for (const row of data.timeline) {
    const tag = sourceTag(row);
    const flags = flagParts(row.flags);
    const bits = [
      `\`${row.shortSha}\``,
      fmtWhen(row.authorDate),
      tag === null ? `**${row.summary}**` : row.summary,
      `[${row.badge.label}]`,
      ...(row.provenance !== undefined ? [row.provenance] : []),
      ...(flags.length > 0 ? [flags.join(" · ")] : []),
      ...(row.changeId !== null ? [`change c/${row.changeId.slice(0, 8)}`] : []),
    ];
    lines.push(`- ${bits.join(" · ")}`);
    if (tag !== null) {
      lines.push(`  - _${tag}_`);
    }
  }
  lines.push("");

  lines.push("## Changes in detail");
  lines.push("");
  if (data.changes.length === 0) {
    lines.push("_No changes with identity in range._");
  }
  for (const change of data.changes) {
    lines.push(`### Change c/${change.changeId}`);
    lines.push("");
    const effective = change.effective;
    if (effective === null) {
      lines.push("_No reasoning recorded for this change yet._");
    } else {
      lines.push(`**${effective.summary}**`);
      lines.push("");
      const badge = toBadge(effective, false);
      lines.push(`- Author: ${badge.label} (${effective.provenance})`);
      const flags = flagParts(toFlags(effective));
      if (flags.length > 0) {
        lines.push(`- Flags: ${flags.join(" · ")}`);
      }
      lines.push(
        `- Intent: ${effective.reasoning?.intent !== undefined ? effective.reasoning.intent : "_not captured_"}`,
      );
      const constraints = effective.reasoning?.constraints ?? [];
      if (constraints.length > 0) {
        lines.push("- Constraints:");
        for (const constraint of constraints) {
          lines.push(`  - ${constraint}`);
        }
      }
      const rejected = effective.reasoning?.rejected ?? [];
      if (rejected.length > 0) {
        lines.push("- Rejected alternatives:");
        for (const alt of rejected) {
          lines.push(`  - ${alt.option} — ${alt.why}`);
        }
      }
      const tested = effective.reasoning?.tested ?? [];
      if (tested.length > 0) {
        lines.push("- Tested:");
        for (const test of tested) {
          lines.push(`  - \`${test}\``);
        }
      } else {
        lines.push("- Tested: _no verification evidence captured_");
      }
      if (effective.scope.length > 0) {
        lines.push("- Scope:");
        for (const item of effective.scope) {
          lines.push(
            `  - \`${item.path}${item.range ? `:${item.range[0]}-${item.range[1]}` : ""}\``,
          );
        }
      }
    }
    lines.push(`- Session: ${sessionLine(change.session)}`);
    if (change.commits.length > 0) {
      lines.push("- Commits in range:");
      for (const commit of change.commits) {
        lines.push(`  - \`${commit.shortSha}\` ${fmtWhen(commit.authorDate)} — ${commit.subject}`);
      }
    }
    if (change.supersededCount > 0) {
      lines.push(
        `- Superseded entries (${change.supersededCount}, retained per the append-only ledger):`,
      );
      for (const row of change.entries) {
        if (!row.effective) {
          lines.push(
            `  - ${fmtWhen(row.entry.created_at)} · ${row.entry.summary} · ` +
              `[${toBadge(row.entry, false).label}]`,
          );
        }
      }
    }
    lines.push("");
  }

  if (data.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of data.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_Missing data above is labeled, never inferred or fabricated — a commit without a " +
      "ledger entry shows its own git subject, marked as such._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// HTML renderer — fully self-contained (inline CSS, no external requests, no frameworks)
// ---------------------------------------------------------------------------------------

/** Escape a string for safe interpolation into HTML text/attribute positions. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f5f8;
  --surface: #ffffff;
  --surface-2: #eceef3;
  --text: #1b2430;
  --muted: #5d6675;
  --line: #dde1e9;
  --accent: #4657c9;
  --accent-soft: #e6e9fb;
  --ok: #196f45;
  --ok-soft: #ddf1e6;
  --warn: #8a5a00;
  --warn-soft: #fdeec9;
  --bad: #a83229;
  --bad-soft: #fae1de;
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1017;
    --surface: #151a23;
    --surface-2: #1d2430;
    --text: #e5e8ee;
    --muted: #96a0b1;
    --line: #29303d;
    --accent: #8b9af5;
    --accent-soft: #232a4d;
    --ok: #57c98b;
    --ok-soft: #14301f;
    --warn: #e2b34c;
    --warn-soft: #33270d;
    --bad: #ef8a80;
    --bad-soft: #3a1714;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .sha { font-family: var(--mono); font-size: 0.86em; }

.masthead { margin-bottom: 2rem; }
.eyebrow {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 0.35rem;
}
h1 { margin: 0 0 0.35rem; font-size: 1.9rem; letter-spacing: -0.02em; }
.range { color: var(--muted); margin: 0 0 1.4rem; font-size: 0.92rem; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0.75rem; }
.stat {
  background: var(--surface); border: 1px solid var(--line); border-radius: 0.75rem;
  padding: 0.85rem 1rem;
}
.stat .num { font-size: 1.55rem; font-weight: 700; letter-spacing: -0.02em; }
.stat .lbl { color: var(--muted); font-size: 0.78rem; margin-top: 0.1rem; }
.stat .sub { color: var(--muted); font-size: 0.75rem; margin-top: 0.3rem; }

h2 {
  font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--muted); margin: 2.4rem 0 1rem; padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--line);
}

.row {
  background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 0.6rem; padding: 0.7rem 1rem; margin-bottom: 0.6rem;
}
.row.no-intent { border-left: 3px dashed var(--line); }
.row-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
  font-size: 0.8rem; color: var(--muted); margin-bottom: 0.3rem;
}
.row-head .sha { color: var(--text); background: var(--surface-2); border-radius: 0.35rem; padding: 0.1rem 0.45rem; }
a.sha:hover { text-decoration: none; outline: 1px solid var(--accent); }
.row .summary { margin: 0; font-size: 0.98rem; font-weight: 600; }
.row.no-intent .summary { font-weight: 400; color: var(--text); }
.degraded-tag {
  display: inline-block; margin-left: 0.5rem; font-size: 0.75rem; font-weight: 400;
  color: var(--warn); background: var(--warn-soft); border-radius: 999px; padding: 0.05rem 0.55rem;
}

.pill {
  display: inline-block; border-radius: 999px; padding: 0.08rem 0.6rem;
  font-size: 0.74rem; font-weight: 600; white-space: nowrap;
}
.pill-agent { background: var(--accent-soft); color: var(--accent); }
.pill-human { background: var(--ok-soft); color: var(--ok); }
.pill-mixed { background: var(--warn-soft); color: var(--warn); }
.pill-none { background: transparent; color: var(--muted); border: 1px dashed var(--line); font-weight: 400; }
.pill-prov { background: var(--surface-2); color: var(--muted); font-weight: 500; }
.pill-prov.prov-inferred { background: var(--warn-soft); color: var(--warn); }
.pill-conf { background: var(--surface-2); color: var(--text); font-weight: 600; }
.pill-risk-low { background: var(--ok-soft); color: var(--ok); }
.pill-risk-medium { background: var(--warn-soft); color: var(--warn); }
.pill-risk-high { background: var(--bad-soft); color: var(--bad); }
.pill-undo { background: var(--surface-2); color: var(--muted); }

.change {
  background: var(--surface); border: 1px solid var(--line); border-radius: 0.75rem;
  padding: 1.1rem 1.25rem; margin-bottom: 1rem;
}
.change h3 { margin: 0 0 0.2rem; font-size: 1rem; }
.change h3 code { background: var(--surface-2); border-radius: 0.35rem; padding: 0.1rem 0.5rem; }
.change .change-summary { margin: 0.35rem 0 0.75rem; font-size: 1.05rem; font-weight: 650; }
.change .meta { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.9rem; }

.facts { display: grid; grid-template-columns: 1fr; gap: 0.55rem; margin: 0; }
.facts > div {
  display: grid; grid-template-columns: 9.5rem 1fr; gap: 0.75rem;
  padding: 0.45rem 0; border-top: 1px solid var(--line);
}
.facts dt {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); padding-top: 0.15rem;
}
.facts dd { margin: 0; font-size: 0.92rem; overflow-wrap: anywhere; }
.facts ul { margin: 0; padding-left: 1.1rem; }
.facts li { margin: 0.1rem 0; }
.absent { color: var(--muted); font-style: italic; }
.commit-line { color: var(--muted); font-size: 0.86rem; }
.commit-line .sha { color: var(--text); }

details.superseded { margin-top: 0.9rem; border-top: 1px solid var(--line); padding-top: 0.6rem; }
details.superseded summary {
  cursor: pointer; color: var(--muted); font-size: 0.85rem; user-select: none;
}
details.superseded summary:hover { color: var(--text); }
.superseded-entry {
  margin: 0.6rem 0 0; padding: 0.55rem 0.8rem; border-left: 2px solid var(--line);
  background: var(--surface-2); border-radius: 0 0.4rem 0.4rem 0; font-size: 0.88rem;
  color: var(--muted);
}
.superseded-entry .s-summary { color: var(--text); }

.warnings {
  background: var(--warn-soft); border: 1px solid var(--warn); border-radius: 0.6rem;
  padding: 0.8rem 1rem 0.8rem 1.1rem; margin-bottom: 0.6rem;
}
.warnings ul { margin: 0.3rem 0 0; padding-left: 1.1rem; }
.warnings li { color: var(--warn); font-size: 0.9rem; }
.warnings .w-title { font-weight: 700; color: var(--warn); font-size: 0.85rem; }

footer {
  margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 0.8rem;
}
.empty { color: var(--muted); font-style: italic; }
`;

function htmlBadgePill(badge: ReportBadge): string {
  return `<span class="pill pill-${badge.kind}">${esc(badge.label)}</span>`;
}

function htmlProvenancePill(provenance: Provenance): string {
  return `<span class="pill pill-prov prov-${esc(provenance)}">${esc(provenance)}</span>`;
}

function htmlFlagPills(flags: ReportFlags): string {
  const pills: string[] = [];
  if (flags.confidence !== undefined) {
    pills.push(`<span class="pill pill-conf">conf ${flags.confidence.toFixed(2)}</span>`);
  }
  if (flags.scopeRisk !== undefined) {
    pills.push(
      `<span class="pill pill-risk-${flags.scopeRisk}">risk ${esc(flags.scopeRisk)}</span>`,
    );
  }
  if (flags.reversibility !== undefined) {
    pills.push(`<span class="pill pill-undo">undo ${esc(flags.reversibility)}</span>`);
  }
  return pills.join("");
}

function htmlTimelineRow(row: ReportTimelineRow, linkable: Set<string>): string {
  const tag = sourceTag(row);
  const shaCell =
    row.changeId !== null && linkable.has(row.changeId)
      ? `<a class="sha" href="#change-${esc(row.changeId)}" title="${esc(row.sha)}">${esc(row.shortSha)}</a>`
      : `<span class="sha" title="${esc(row.sha)}">${esc(row.shortSha)}</span>`;
  const head = [
    shaCell,
    `<time datetime="${esc(row.authorDate)}">${esc(fmtWhen(row.authorDate))}</time>`,
    htmlBadgePill(row.badge),
    ...(row.provenance !== undefined ? [htmlProvenancePill(row.provenance)] : []),
    htmlFlagPills(row.flags),
  ]
    .filter((part) => part.length > 0)
    .join("\n      ");
  const summary =
    tag === null
      ? `<p class="summary">${esc(row.summary)}</p>`
      : `<p class="summary">${esc(row.summary)}<span class="degraded-tag">${esc(tag)}</span></p>`;
  return `  <article class="row${row.hasIntent ? "" : " no-intent"}">
    <div class="row-head">
      ${head}
    </div>
    ${summary}
  </article>`;
}

function htmlFact(label: string, body: string): string {
  return `      <div><dt>${esc(label)}</dt><dd>${body}</dd></div>`;
}

function htmlList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function htmlChangeSection(change: ReportChangeSection): string {
  const effective = change.effective;
  const parts: string[] = [];
  const shortId = change.changeId.slice(0, 8);

  parts.push(`  <section class="change" id="change-${esc(change.changeId)}">`);
  parts.push(
    `    <h3><code title="${esc(change.changeId)}">c/${esc(shortId)}</code></h3>`,
  );

  if (effective === null) {
    parts.push(
      `    <p class="change-summary absent">No reasoning recorded for this change yet.</p>`,
    );
  } else {
    parts.push(`    <p class="change-summary">${esc(effective.summary)}</p>`);
    const meta = [
      htmlBadgePill(toBadge(effective, false)),
      htmlProvenancePill(effective.provenance),
      htmlFlagPills(toFlags(effective)),
    ]
      .filter((part) => part.length > 0)
      .join("");
    parts.push(`    <div class="meta">${meta}</div>`);
  }

  parts.push(`    <dl class="facts">`);
  const absent = (label: string): string =>
    htmlFact(label, `<span class="absent">not captured</span>`);

  if (effective !== null) {
    const reasoning = effective.reasoning;
    parts.push(
      reasoning?.intent !== undefined
        ? htmlFact("Intent", esc(reasoning.intent))
        : absent("Intent"),
    );
    const constraints = reasoning?.constraints ?? [];
    if (constraints.length > 0) {
      parts.push(htmlFact("Constraints", htmlList(constraints.map((item) => esc(item)))));
    }
    const rejected = reasoning?.rejected ?? [];
    if (rejected.length > 0) {
      parts.push(
        htmlFact(
          "Rejected",
          htmlList(rejected.map((alt) => `<strong>${esc(alt.option)}</strong> — ${esc(alt.why)}`)),
        ),
      );
    }
    const tested = reasoning?.tested ?? [];
    parts.push(
      tested.length > 0
        ? htmlFact("Tested", htmlList(tested.map((test) => `<code>${esc(test)}</code>`)))
        : htmlFact("Tested", `<span class="absent">no verification evidence captured</span>`),
    );
    if (effective.scope.length > 0) {
      parts.push(
        htmlFact(
          "Scope",
          htmlList(
            effective.scope.map(
              (item) =>
                `<code>${esc(item.path)}${item.range ? `:${item.range[0]}–${item.range[1]}` : ""}</code>`,
            ),
          ),
        ),
      );
    }
  }

  const session = change.session;
  const sessionBody =
    session.status === "available"
      ? esc(sessionLine(session)) +
        (session.summary !== undefined
          ? `<div class="commit-line">${esc(session.summary)}</div>`
          : "")
      : `<span class="absent">${esc(sessionLine(session))}</span>`;
  parts.push(htmlFact("Session", sessionBody));

  if (change.commits.length > 0) {
    parts.push(
      htmlFact(
        "Commits",
        htmlList(
          change.commits.map(
            (commit) =>
              `<span class="commit-line"><span class="sha" title="${esc(commit.sha)}">${esc(
                commit.shortSha,
              )}</span> ${esc(fmtWhen(commit.authorDate))} — ${esc(commit.subject)}</span>`,
          ),
        ),
      ),
    );
  }
  parts.push(`    </dl>`);

  if (change.supersededCount > 0) {
    parts.push(`    <details class="superseded">`);
    parts.push(
      `      <summary>${change.supersededCount} superseded ` +
        `entr${change.supersededCount === 1 ? "y" : "ies"} (retained — the ledger is append-only)</summary>`,
    );
    for (const row of change.entries) {
      if (!row.effective) {
        parts.push(
          `      <div class="superseded-entry"><span class="s-summary">${esc(
            row.entry.summary,
          )}</span><br>${esc(fmtWhen(row.entry.created_at))} · ${esc(
            toBadge(row.entry, false).label,
          )} · ${esc(row.entry.provenance)}</div>`,
        );
      }
    }
    parts.push(`    </details>`);
  }

  parts.push(`  </section>`);
  return parts.join("\n");
}

function renderHtml(data: ReportData): string {
  const { totals } = data;
  const linkable = new Set(data.changes.map((change) => change.changeId));

  const rangeBits: string[] = [];
  if (data.range.rev !== null) {
    rangeBits.push(`rev ${esc(data.range.rev)}`);
  }
  if (data.range.since !== null) {
    rangeBits.push(`since ${esc(data.range.since)}`);
  }
  if (data.range.until !== null) {
    rangeBits.push(`until ${esc(data.range.until)}`);
  }
  if (data.range.oldestCommitDate !== null && data.range.newestCommitDate !== null) {
    rangeBits.push(
      `commits span ${esc(fmtWhen(data.range.oldestCommitDate))} → ${esc(fmtWhen(data.range.newestCommitDate))}`,
    );
  }
  const rangeLine =
    rangeBits.length > 0 ? rangeBits.join(" · ") : "full history of the current branch";

  const attribution =
    `${totals.agentCommits} agent · ${totals.humanCommits} human` +
    (totals.mixedCommits > 0 ? ` · ${totals.mixedCommits} mixed` : "") +
    ` · ${totals.noIntentCommits} no intent`;

  const stats = [
    `<div class="stat"><div class="num">${totals.commits}</div><div class="lbl">commits</div></div>`,
    `<div class="stat"><div class="num">${totals.changes}</div><div class="lbl">changes</div></div>`,
    `<div class="stat"><div class="num">${totals.agentCommits}</div><div class="lbl">agent-attributed</div><div class="sub">${esc(attribution)}</div></div>`,
    `<div class="stat"><div class="num">${totals.sessionsCaptured}</div><div class="lbl">sessions captured</div></div>`,
    `<div class="stat"><div class="num">${totals.modelsSeen.length}</div><div class="lbl">models seen</div><div class="sub">${
      totals.modelsSeen.length > 0 ? esc(totals.modelsSeen.join(", ")) : "none recorded"
    }</div></div>`,
  ].join("\n      ");

  const timeline =
    data.timeline.length > 0
      ? data.timeline.map((row) => htmlTimelineRow(row, linkable)).join("\n")
      : `  <p class="empty">No commits in range.</p>`;

  const changes =
    data.changes.length > 0
      ? data.changes.map((change) => htmlChangeSection(change)).join("\n")
      : `  <p class="empty">No changes with identity in range.</p>`;

  const warnings =
    data.warnings.length > 0
      ? `<section class="warnings" id="warnings">
    <div class="w-title">Warnings</div>
    <ul>${data.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
  </section>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent activity report — ${esc(data.repoName)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div class="eyebrow">git-for-ai · agent activity report</div>
    <h1>${esc(data.repoName)}</h1>
    <p class="range">Generated ${esc(fmtWhen(data.generatedAt))} UTC · ${rangeLine}</p>
    <div class="stats">
      ${stats}
    </div>
  </header>
  ${warnings}
  <h2 id="timeline">Timeline</h2>
${timeline}
  <h2 id="changes">Changes in detail</h2>
${changes}
  <footer>
    Generated by <code>git for-ai report</code>. Missing data is labeled, never inferred or
    fabricated: commits without a ledger entry show their own git subject, marked
    "no captured intent"; unresolvable session traces are reported as unavailable.
  </footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * `git for-ai report [--since <date>] [--until <date>] [-n <N>] [--md|--html] [--out <path>]`:
 * assemble the agent-activity digest for the current branch and render it. A future bin.ts
 * wires this as:
 *
 *   const { output, path } = await runReport({ ...flags });
 *   if (path !== undefined) console.log(`report written to ${path}`);
 *   else console.log(output);
 */
export async function runReport(options: ReportOptions = {}): Promise<ReportResult> {
  const ctx = toContext(options);
  const data = await assembleReport(options, ctx);
  const format = options.format ?? "html";
  const output = format === "md" ? renderMarkdown(data) : renderHtml(data);

  if (options.out === undefined) {
    return { data, output };
  }

  const baseDir = options.cwd ?? process.cwd();
  const outPath = isAbsolute(options.out) ? options.out : resolve(baseDir, options.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, output, "utf8");
  return { data, output, path: outPath };
}

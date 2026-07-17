// `git for-ai show <commit|c/change-id>` — Milestone 8 (architecture/CLI_PLAN.md).
//
// The debugging tool that exercises the full read path: dump the commit, its resolved
// change-id, the change-map entry's key facts, every ledger entry for the change (with
// the effective one marked, per DATA_MODEL.md §2.4 — superseded entries are retained and
// viewable), and the linked session record when one exists. `--json` renders the same
// structured result as JSON; `--session` includes the full span trace in the human dump.
//
// Honest degradation is a hard requirement (ARCHITECTURE.md's stated goals), so every
// absent piece of data gets an explicit label instead of silence or fabrication:
//   - a commit with no identity evidence renders "no identity", and — following the same
//     deliberate judgment call documented in ./log.ts — resolveChangeId is NOT called for
//     it, so `show` never mints orphan/inferred change-map rows as a side effect of a read;
//   - a change with no ledger note renders "no captured intent";
//   - a ledger note that exists but is unusable (LedgerNoteFormatError) is surfaced as an
//     explicit warning, never crashed on and never treated as absent;
//   - a `session_ref` that cannot be resolved (missing sessions ref, missing blob, invalid
//     JSON, schema mismatch) renders "session trace unavailable" with the reason.
//
// Session storage note: Milestone 7 (session capture) may or may not have landed when this
// runs, so the session read here is deliberately self-contained and read-only. It reads the
// layout pinned by DATA_MODEL.md §3 / ARCHITECTURE.md §8.1 directly through the M2 git
// primitives: `refs/git-for-ai/sessions` points at a tree of content-addressed blobs
// sharded by first hash byte (`<aa>/<full-hash>`), and "resolution walks the sessions tree
// to find the matching blob". Everything read is validated against sessionRecordSchema.

import {
  sessionRecordSchema,
  type ChangeMapEntry,
  type LedgerEntry,
  type SessionRecord,
  type Span,
} from "@git-for-ai/schemas";
import {
  runGit,
  readCommitMessage,
  catFile,
  lsTree,
  parseChangeIdTrailer,
  findEntryByCommitSha,
  readChangeMapEntry,
  readAllChangeMapEntries,
  resolveChangeId,
  readLedgerEntries,
  resolveEffectiveEntry,
  LedgerNoteFormatError,
  canonicalJsonStringify,
  type GitContext,
} from "@git-for-ai/core";

/** Options for {@link runShow}, mirroring CLI_REFERENCE.md's `show` flags. */
export interface ShowOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--session` — include the full span trace in the rendered output. */
  session?: boolean;
  /** `--json` — render the structured result as JSON instead of the human dump. */
  json?: boolean;
}

/** The commit the target resolved to (git metadata, always real). */
export interface ShowCommitInfo {
  /** Full 40-hex commit SHA. */
  sha: string;
  /** Abbreviated SHA as git chose to abbreviate it (`%h`). */
  shortSha: string;
  /** The commit's own subject line. */
  subject: string;
}

/** One ledger entry row: the entry, where its note lives, and whether it is effective. */
export interface ShowLedgerRow {
  entry: LedgerEntry;
  /** The commit whose intent note carried this entry. */
  noteCommit: string;
  /** True for the single effective entry (DATA_MODEL.md §2.4); false = superseded. */
  effective: boolean;
}

/** Session lookup outcome for the effective entry's `session_ref`. */
export interface ShowSessionInfo {
  /** The effective entry's `session_ref`, or null when none is recorded. */
  ref: string | null;
  /** `none` = no ref recorded; `unavailable` = ref present but unresolvable. */
  status: "none" | "available" | "unavailable";
  /** Why the session trace is unavailable (present iff status is `unavailable`). */
  reason?: string;
  /** The validated session record (present iff status is `available`). */
  record?: SessionRecord;
}

/** The structured result behind the rendered output (this is what `--json` serializes). */
export interface ShowData {
  /** The target exactly as the user gave it. */
  target: string;
  /**
   * The commit shown. Null only for a `c/<change-id>` target whose head commit object is
   * not present in this repository (e.g. a synced change-map without the commits).
   */
  commit: ShowCommitInfo | null;
  /** Resolved change-id, or null when the commit has no identity evidence. */
  changeId: string | null;
  /** When the target mapped to a squash-absorbed change: the absorbed id redirected from. */
  redirectedFrom?: string;
  /** The change-map entry for `changeId` (post-redirect), or null with no identity. */
  changeMap: ChangeMapEntry | null;
  /** Every ledger entry found for the change, oldest first, with the effective one marked. */
  ledger: ShowLedgerRow[];
  session: ShowSessionInfo;
  /** Explicit degradation notices (e.g. an unreadable ledger note) — never silent. */
  warnings: string[];
}

/** Result of {@link runShow}: the structured data plus the rendered console output. */
export interface ShowResult {
  data: ShowData;
  /** Rendered output (human dump, or `JSON.stringify(data, null, 2)` with `--json`). */
  output: string;
}

/** The ref the content-addressed session traces live under (ARCHITECTURE.md §8.1). */
const SESSIONS_REF = "refs/git-for-ai/sessions";

/** Rendered when a `session_ref` exists but the trace cannot be read (CLI_PLAN.md M8). */
const SESSION_UNAVAILABLE = "session trace unavailable";

/** Build a GitContext without materializing undefined keys (exactOptionalPropertyTypes). */
function toContext(options: ShowOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

/** Field separator for `git log` format strings — never appears in a subject line. */
const FIELD_SEP = "\u001f";

/** Read a commit's short SHA + subject, or null when `sha` is not a commit present here. */
async function readCommitInfo(sha: string, ctx: GitContext): Promise<ShowCommitInfo | null> {
  const result = await runGit(["log", "-1", "--format=%H%x1f%h%x1f%s", sha], {
    ...ctx,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const [fullSha, shortSha, ...rest] = result.stdout.split(FIELD_SEP);
  if (fullSha === undefined || shortSha === undefined) {
    return null;
  }
  return { sha: fullSha, shortSha, subject: rest.join(FIELD_SEP) };
}

/**
 * Follow `folded_into` redirects to the surviving change-map entry (cycle- and
 * dangling-safe), mirroring the resolver's §7.4 "queries for an absorbed change-id
 * transparently redirect" behavior for `c/<change-id>` targets.
 */
async function followFolds(entry: ChangeMapEntry, ctx: GitContext): Promise<ChangeMapEntry> {
  let current = entry;
  const seen = new Set<string>([entry.change_id]);
  while (current.folded_into !== undefined && !seen.has(current.folded_into)) {
    const next = await readChangeMapEntry(current.folded_into, ctx);
    if (next === null) {
      break;
    }
    seen.add(next.change_id);
    current = next;
  }
  return current;
}

/** Resolve a `c/<change-id>` target (full id, or an unambiguous prefix) to its map entry. */
async function resolveChangeIdTarget(target: string, ctx: GitContext): Promise<ChangeMapEntry> {
  const raw = target.slice(2).toLowerCase();
  if (!/^[0-9a-f]{4,32}$/.test(raw)) {
    throw new Error(
      `'${target}' is not a valid change reference — expected c/<change-id> ` +
        `(4 to 32 lowercase hex characters after the c/ prefix)`,
    );
  }

  if (raw.length === 32) {
    const entry = await readChangeMapEntry(raw, ctx);
    if (entry === null) {
      throw new Error(`change c/${raw} not found in the change-map`);
    }
    return entry;
  }

  const matches = (await readAllChangeMapEntries(ctx)).filter((entry) =>
    entry.change_id.startsWith(raw),
  );
  if (matches.length === 0) {
    throw new Error(`change c/${raw} not found in the change-map`);
  }
  if (matches.length > 1) {
    throw new Error(
      `change reference c/${raw} is ambiguous — matches: ${matches
        .map((entry) => `c/${entry.change_id}`)
        .join(", ")}`,
    );
  }
  return matches[0]!;
}

/**
 * Resolve a walked commit's change-id, if it has any evidence of identity — the same
 * non-minting pattern as ./log.ts: commits with neither a change-map row nor a Change-Id
 * trailer return null WITHOUT calling resolveChangeId, whose R4/R5 branches would mint
 * inferred/orphan map rows as a side effect of a read.
 */
async function resolveIdentityIfPresent(
  sha: string,
  ctx: GitContext,
): Promise<{ changeId: string; entry: ChangeMapEntry; redirectedFrom?: string } | null> {
  const mapped = await findEntryByCommitSha(sha, ctx);
  if (mapped === null) {
    const message = await readCommitMessage(sha, ctx);
    if (parseChangeIdTrailer(message) === null) {
      return null;
    }
  }
  // Map row (R1) or trailer (R2/R3 lazy healing): the full resolver is authoritative,
  // follows folded_into redirects, and writes back trailer-recovered identity.
  const resolution = await resolveChangeId(sha, ctx);
  return {
    changeId: resolution.changeId,
    entry: resolution.entry,
    ...(resolution.absorbedChangeId !== undefined
      ? { redirectedFrom: resolution.absorbedChangeId }
      : {}),
  };
}

/**
 * Collect every ledger entry recorded for the change, reading the intent note on each
 * commit the change has ever been (`history` + `head` + the target commit itself — notes
 * stay anchored to the revision they were written against). Unreadable notes become
 * explicit warnings, never crashes and never silent absence. Entries are deduped by
 * canonical serialization and returned oldest first, with the effective one marked.
 */
async function collectLedgerRows(
  shas: string[],
  ctx: GitContext,
  warnings: string[],
): Promise<ShowLedgerRow[]> {
  const seen = new Set<string>();
  const rows: Array<{ entry: LedgerEntry; noteCommit: string }> = [];

  for (const sha of shas) {
    let entries: LedgerEntry[] | null;
    try {
      entries = await readLedgerEntries(sha, ctx);
    } catch (error) {
      if (error instanceof LedgerNoteFormatError) {
        warnings.push(`ledger note on commit ${sha} is unreadable: ${error.message}`);
        continue;
      }
      throw error;
    }
    for (const entry of entries ?? []) {
      const key = canonicalJsonStringify(entry);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({ entry, noteCommit: sha });
      }
    }
  }

  if (rows.length === 0) {
    return [];
  }

  // Oldest first for display (append order); the effective entry is order-independent.
  rows.sort((a, b) => Date.parse(a.entry.created_at) - Date.parse(b.entry.created_at));
  const effective = resolveEffectiveEntry(rows.map((row) => row.entry));
  return rows.map((row) => ({ ...row, effective: row.entry === effective }));
}

/**
 * Read a session record from the sessions ref — read-only, self-contained (see module
 * header: deliberately NOT coupled to core's in-progress sessions module). Never throws
 * for an unresolvable ref: every failure mode returns an explicit `unavailable` reason.
 */
async function readSessionRecord(sessionRef: string, ctx: GitContext): Promise<ShowSessionInfo> {
  const hash = sessionRef.startsWith("sha256:") ? sessionRef.slice("sha256:".length) : null;
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) {
    return {
      ref: sessionRef,
      status: "unavailable",
      reason: `session_ref is not a valid sha256:<64hex> pointer`,
    };
  }

  // Resolve the sessions ref to its tree (works whether the ref points at a commit or
  // directly at a tree). A missing ref is the "M7 hasn't run / never synced" case.
  const tree = await runGit(["rev-parse", "--verify", "--quiet", `${SESSIONS_REF}^{tree}`], {
    ...ctx,
    allowFailure: true,
  });
  if (tree.exitCode !== 0 || tree.stdout.length === 0) {
    return {
      ref: sessionRef,
      status: "unavailable",
      reason: `sessions ref (${SESSIONS_REF}) does not exist in this repository`,
    };
  }

  // Walk the sharded tree for the content-addressed blob (ARCHITECTURE.md §8.1:
  // "resolution walks the sessions tree to find the matching blob"). Canonical layout is
  // `<aa>/<full-hash>` (DATA_MODEL.md §3); tolerate a `.json` suffix or a shard-stripped
  // filename so a compliant-but-slightly-different writer still resolves.
  const shard = hash.slice(0, 2);
  const candidates = new Set([
    `${shard}/${hash}`,
    `${shard}/${hash}.json`,
    `${shard}/${hash.slice(2)}`,
    `${shard}/${hash.slice(2)}.json`,
  ]);
  const entries = await lsTree(tree.stdout, { ...ctx, recursive: true });
  const match = entries.find((entry) => entry.type === "blob" && candidates.has(entry.path));
  if (match === undefined) {
    return {
      ref: sessionRef,
      status: "unavailable",
      reason: `no session object for ${sessionRef} under ${SESSIONS_REF}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await catFile(match.sha, ctx));
  } catch {
    return {
      ref: sessionRef,
      status: "unavailable",
      reason: `session object ${match.sha} is not valid JSON`,
    };
  }
  const record = sessionRecordSchema.safeParse(parsed);
  if (!record.success) {
    return {
      ref: sessionRef,
      status: "unavailable",
      reason: `session object ${match.sha} does not match the session record schema`,
    };
  }
  return { ref: sessionRef, status: "available", record: record.data };
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

const short = (sha: string): string => sha.slice(0, 7);

function renderChangeMap(entry: ChangeMapEntry, lines: string[]): void {
  lines.push("change-map");
  lines.push(`  head         ${entry.head}`);
  lines.push(
    `  history      ${entry.history.map(short).join(" -> ")}  (${entry.history.length} ` +
      `commit${entry.history.length === 1 ? "" : "s"})`,
  );
  lines.push(`  origin       ${entry.origin}`);
  lines.push(`  trailer      ${entry.trailer_seen ? "seen" : "not seen"}`);
  if (entry.folded_into !== undefined) {
    lines.push(`  folded into  c/${entry.folded_into}`);
  }
  if (entry.absorbed !== undefined && entry.absorbed.length > 0) {
    lines.push(`  absorbed     ${entry.absorbed.map((id) => `c/${id}`).join(", ")}`);
  }
  if (entry.divergent_heads !== undefined && entry.divergent_heads.length > 0) {
    lines.push(`  divergent    ${entry.divergent_heads.join(", ")}`);
  }
  lines.push(`  updated      ${entry.updated_at}`);
}

function renderLedgerRow(row: ShowLedgerRow, index: number, lines: string[]): void {
  const { entry } = row;
  const marker = row.effective ? "*" : " ";
  const author = [entry.author.type, entry.author.tool, entry.author.model]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const confidence = entry.reasoning?.confidence;
  lines.push(
    `  ${marker} entry ${index + 1}  ${entry.created_at}  [${author}]  ${entry.provenance}` +
      (confidence === undefined ? "" : `  conf ${confidence.toFixed(2)}`) +
      (row.effective ? "  (effective)" : "  (superseded)"),
  );
  lines.push(`      summary    ${entry.summary}`);
  for (const item of entry.scope) {
    lines.push(`      scope      ${item.path}${item.range ? `:${item.range[0]}-${item.range[1]}` : ""}`);
  }
  const reasoning = entry.reasoning;
  if (reasoning?.intent !== undefined) {
    lines.push(`      intent     ${reasoning.intent}`);
  }
  for (const rejected of reasoning?.rejected ?? []) {
    lines.push(`      rejected   ${rejected.option} — ${rejected.why}`);
  }
  for (const tested of reasoning?.tested ?? []) {
    lines.push(`      tested     ${tested}`);
  }
  if (entry.session_ref !== undefined && entry.session_ref !== null) {
    lines.push(`      session    ${entry.session_ref}`);
  }
  if (entry.redaction_note !== undefined) {
    lines.push(`      redaction  ${entry.redaction_note}`);
  }
  if (entry.folded_into !== undefined) {
    lines.push(`      folded into c/${entry.folded_into}`);
  }
}

function renderSpan(span: Span, lines: string[]): void {
  const meta = [span.kind, span.name, span.start].filter(
    (part): part is string => part !== undefined,
  );
  lines.push(`    ${span.span_id}  ${meta.join("  ")}`);
  if (span.attributes !== undefined && Object.keys(span.attributes).length > 0) {
    lines.push(`        attributes: ${JSON.stringify(span.attributes)}`);
  }
  if (span.body !== undefined && Object.keys(span.body).length > 0) {
    lines.push(`        body: ${JSON.stringify(span.body)}`);
  }
}

function renderSession(session: ShowSessionInfo, includeSpans: boolean, lines: string[]): void {
  if (session.status === "none") {
    lines.push("session      none recorded");
    return;
  }
  lines.push(`session      ${session.ref}`);
  if (session.status === "unavailable") {
    lines.push(`  ${SESSION_UNAVAILABLE} (${session.reason})`);
    return;
  }
  const record = session.record!;
  lines.push(`  agent      ${record.agent.tool} ${record.agent.version} (${record.agent.model})`);
  lines.push(`  captured   ${record.captured_at}`);
  lines.push(`  session id ${record.session_id}`);
  lines.push(`  commits    ${short(record.commit_range.since)}..${short(record.commit_range.until)}`);
  lines.push(
    `  redaction  ${record.redaction.applied ? "applied" : "not applied"}` +
      ` (${record.redaction.redacted_count} redacted)`,
  );
  if (record.summary !== undefined) {
    lines.push(`  summary    ${record.summary}`);
  }
  if (includeSpans) {
    lines.push(`  spans      ${record.spans.length}`);
    for (const span of record.spans) {
      renderSpan(span, lines);
    }
  } else {
    lines.push(
      `  spans      ${record.spans.length}  (run with --session to include the span trace)`,
    );
  }
}

/** Render the human-readable dump from the structured data. */
function render(data: ShowData, includeSpans: boolean): string {
  const lines: string[] = [];

  if (data.commit !== null) {
    lines.push(`commit       ${data.commit.sha} (${data.commit.shortSha})`);
    lines.push(`subject      ${data.commit.subject}`);
  } else {
    lines.push(`commit       — (not present in this repository)`);
  }

  if (data.changeId !== null) {
    lines.push(`change       ${data.changeId}`);
    if (data.redirectedFrom !== undefined) {
      lines.push(`             (redirected from absorbed change c/${data.redirectedFrom})`);
    }
  } else {
    lines.push(`change       — (no identity: no change-map entry and no Change-Id trailer)`);
  }

  if (data.changeMap !== null) {
    renderChangeMap(data.changeMap, lines);
  }

  if (data.ledger.length > 0) {
    lines.push(
      `ledger       ${data.ledger.length} ` +
        `entr${data.ledger.length === 1 ? "y" : "ies"} (* = effective)`,
    );
    data.ledger.forEach((row, index) => renderLedgerRow(row, index, lines));
  } else {
    lines.push(`ledger       no captured intent`);
  }

  renderSession(data.session, includeSpans, lines);

  if (data.warnings.length > 0) {
    lines.push("warnings");
    for (const warning of data.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * `git for-ai show <commit|c/change-id>`: dump the ledger entry (and session record, if
 * present) for a change, in human-readable or `--json` form. A future bin.ts wires this as:
 *
 *   const { output } = await runShow(target, { ...flags });
 *   console.log(output);
 */
export async function runShow(target: string, options: ShowOptions = {}): Promise<ShowResult> {
  const ctx = toContext(options);
  const warnings: string[] = [];

  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  let commit: ShowCommitInfo | null;
  let changeId: string | null;
  let changeMap: ChangeMapEntry | null;
  let redirectedFrom: string | undefined;

  if (/^c\//i.test(target)) {
    // `c/<change-id>` target: look it up in the change-map directly, following
    // folded_into redirects to the surviving change (§7.4).
    const direct = await resolveChangeIdTarget(target, ctx);
    const surviving = await followFolds(direct, ctx);
    changeId = surviving.change_id;
    changeMap = surviving;
    redirectedFrom = surviving.change_id === direct.change_id ? undefined : direct.change_id;
    commit = await readCommitInfo(surviving.head, ctx);
    if (commit === null) {
      warnings.push(
        `head commit ${surviving.head} for change c/${changeId} is not present in this repository`,
      );
    }
  } else {
    // Commit-ish target: rev-parse it, then resolve identity the non-minting way.
    const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${target}^{commit}`], {
      ...ctx,
      allowFailure: true,
    });
    if (resolved.exitCode !== 0 || resolved.stdout.length === 0) {
      throw new Error(`cannot resolve '${target}' to a commit`);
    }
    commit = await readCommitInfo(resolved.stdout, ctx);
    if (commit === null) {
      throw new Error(`cannot resolve '${target}' to a commit`);
    }

    const identity = await resolveIdentityIfPresent(commit.sha, ctx);
    changeId = identity?.changeId ?? null;
    changeMap = identity?.entry ?? null;
    redirectedFrom = identity?.redirectedFrom;
  }

  // Ledger: read the intent note on every commit this change has ever been, plus the
  // target commit itself (covers a note present on a commit whose map row was lost).
  const noteShas = [
    ...new Set([
      ...(changeMap !== null ? [...changeMap.history, changeMap.head] : []),
      ...(commit !== null ? [commit.sha] : []),
    ]),
  ];
  const ledger = await collectLedgerRows(noteShas, ctx, warnings);
  const effective = ledger.find((row) => row.effective)?.entry ?? null;

  // Session: only ever attempted from a real ledger entry's session_ref — never guessed.
  const sessionRef = effective?.session_ref ?? null;
  const session: ShowSessionInfo =
    sessionRef === null ? { ref: null, status: "none" } : await readSessionRecord(sessionRef, ctx);

  const data: ShowData = {
    target,
    commit,
    changeId,
    ...(redirectedFrom !== undefined ? { redirectedFrom } : {}),
    changeMap,
    ledger,
    session,
    warnings,
  };

  const output =
    options.json === true ? JSON.stringify(data, null, 2) : render(data, options.session === true);
  return { data, output };
}

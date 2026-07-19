// `git for-ai export --format agent-trace|pr-comment [--out <path>] [<target>]` —
// CLI_REFERENCE `export` + ARCHITECTURE.md §3.1 (Agent Trace interop) + the
// PLAN_2026-07-18.md §2.2-item-3 cheap PR surface (`export --format pr-comment` piped to
// `gh pr comment`).
//
// Read-path discipline (same deliberate judgment call as log/show/report/doctor): export
// is a READ and never mints identity — the resolver is never invoked; change identity
// comes from the entries themselves and (when present) the change-map row.
//
// ── Judgment calls (where the docs are loose, decided + documented here) ──
//
// 1. Agent Trace shape. The spec (agent-trace.dev, v0.1.0) defines: a top-level record
//    with `version`, `id` (UUID), `timestamp`, `vcs {type, revision}`, `tool {name,
//    version}`, `files [{path, conversations [{contributor {type, model_id}, ranges
//    [{start_line, end_line, content_hash}], related}]}]`, and a vendor `metadata` slot.
//    Mapping choices:
//      - one trace record per change, from its EFFECTIVE ledger entry (the same
//        superseded-entries-would-pollute rationale as reindex judgment call #1);
//      - `id` is the change-id formatted as a UUID (32 hex → 8-4-4-4-12): stable across
//        exports, meaningful to re-importers;
//      - `contributor.type`: agent→`ai`, human→`human`, mixed→`mixed`;
//      - `contributor.model_id` follows the models.dev `provider/model` convention —
//        `claude-*` models get the `anthropic/` prefix, anything already containing `/`
//        passes through, anything else is emitted as-is (honest, not guessed);
//      - `ranges[].content_hash` is `git-blob:<sha>` — our scope items pin a git blob,
//        not a murmur3 line hash; a prefixed hash keeps the field truthful;
//      - `related` carries the session pointer as `{type: "session", url:
//        "git-for-ai:session/sha256:<hash>"}` (a URI-shaped local pointer; Agent Trace
//        has no session concept — ARCHITECTURE §3.1 calls this export lossy one-way);
//      - everything Agent Trace cannot carry (change_id, summary, full reasoning,
//        provenance) rides in `metadata.git_for_ai`, the spec's vendor slot.
//    Output is a JSON ARRAY of trace records (pretty-printed) — a single readable
//    document for tooling; `--out` writes it to a file.
// 2. `pr-comment` needs ONE change: the optional `<target>` (commit-ish or
//    c/<change-id>) defaults to HEAD. A commit with no captured intent still produces a
//    comment — labeled "no captured intent", exit 2 (degraded-but-answered) — because
//    posting honest absence beats posting nothing silently.
// 3. `agent-trace` with a `<target>` narrows the export to that one change; without it,
//    every change that has a ledger entry is exported.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ChangeMapEntry, LedgerEntry, Reasoning } from "@git-for-ai/schemas";
import {
  runGit,
  readCommitMessage,
  parseChangeIdTrailer,
  findEntryByCommitSha,
  readChangeMapEntry,
  readLedgerNoteWithFormat,
  readSessionRecord,
  resolveEffectiveEntry,
  LedgerNoteFormatError,
  INTENT_NOTES_REF,
  type GitContext,
} from "@git-for-ai/core";

// ─── Public types ────────────────────────────────────────────────────────────

export type ExportFormat = "agent-trace" | "pr-comment";

export interface ExportOptions {
  /** Repository to export from (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** Output format. Default `agent-trace`. */
  format?: ExportFormat;
  /** Optional target (commit-ish or c/<change-id>); required semantics per format above. */
  target?: string;
  /** `--out <path>` — write the rendered output to this file. */
  out?: string;
}

/** One Agent Trace record (judgment call #1). Kept structural, not schema-validated —
 * the wire format is external and passthrough-shaped. */
export interface AgentTraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs: { type: "git"; revision: string };
  tool: { name: string };
  files: Array<{
    path: string;
    conversations: Array<{
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash: string }>;
      related?: Array<{ type: string; url: string }>;
    }>;
  }>;
  metadata: {
    git_for_ai: {
      change_id: string;
      summary: string;
      provenance: string;
      reasoning?: Reasoning;
      session_ref?: string | null;
    };
  };
}

export interface ExportResult {
  format: ExportFormat;
  /** agent-trace: the exported records. */
  records?: AgentTraceRecord[];
  /** The rendered output (JSON array or markdown). */
  output: string;
  /** Absolute path written (present iff `out` was given). */
  path?: string;
  /** 0 clean; 2 degraded (pr-comment for a commit with no captured intent). */
  exitCode: 0 | 2;
  warnings: string[];
}

// ─── Shared collection (non-minting) ─────────────────────────────────────────

const AGENT_TRACE_VERSION = "0.1.0";

function toContext(options: ExportOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

/** 32-hex change-id → UUID text form (stable, reversible). */
function changeIdToUuid(changeId: string): string {
  return (
    `${changeId.slice(0, 8)}-${changeId.slice(8, 12)}-${changeId.slice(12, 16)}-` +
    `${changeId.slice(16, 20)}-${changeId.slice(20, 32)}`
  );
}

/** models.dev-style provider/model id (judgment call #1). */
function toModelId(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  if (model.includes("/")) return model;
  if (model.startsWith("claude")) return `anthropic/${model}`;
  return model;
}

const CONTRIBUTOR_TYPE: Record<string, string> = { agent: "ai", human: "human", mixed: "mixed" };

/** All ledger entries in the repo, grouped by change-id (notes enumerated directly). */
async function collectEntriesByChange(
  ctx: GitContext,
  warnings: string[],
): Promise<Map<string, LedgerEntry[]>> {
  const list = await runGit(["notes", `--ref=${INTENT_NOTES_REF}`, "list"], {
    ...ctx,
    allowFailure: true,
  });
  const notedShas =
    list.exitCode === 0 && list.stdout.length > 0
      ? list.stdout.split("\n").flatMap((line) => {
          const sha = line.split(" ")[1];
          return sha === undefined ? [] : [sha];
        })
      : [];

  const byChange = new Map<string, LedgerEntry[]>();
  for (const sha of notedShas) {
    try {
      const read = await readLedgerNoteWithFormat(sha, ctx);
      if (read === null) continue;
      for (const entry of read.note.entries) {
        const bucket = byChange.get(entry.change_id) ?? [];
        bucket.push(entry);
        byChange.set(entry.change_id, bucket);
      }
    } catch (error) {
      if (error instanceof LedgerNoteFormatError) {
        warnings.push(`ledger note on commit ${sha} is unreadable — excluded from the export`);
      } else {
        throw error;
      }
    }
  }
  return byChange;
}

/** Build one Agent Trace record from a change's effective entry (judgment call #1). */
function toTraceRecord(entry: LedgerEntry): AgentTraceRecord {
  const contributor: { type: string; model_id?: string } = {
    type: CONTRIBUTOR_TYPE[entry.author.type] ?? "unknown",
    ...(toModelId(entry.author.model) !== undefined
      ? { model_id: toModelId(entry.author.model)! }
      : {}),
  };
  const related =
    entry.session_ref !== undefined && entry.session_ref !== null
      ? [{ type: "session", url: `git-for-ai:session/${entry.session_ref}` }]
      : undefined;

  // Group scope items by path — Agent Trace nests ranges under one file object.
  const byPath = new Map<string, LedgerEntry["scope"]>();
  for (const item of entry.scope) {
    const bucket = byPath.get(item.path) ?? [];
    bucket.push(item);
    byPath.set(item.path, bucket);
  }

  return {
    version: AGENT_TRACE_VERSION,
    id: changeIdToUuid(entry.change_id),
    timestamp: entry.created_at,
    vcs: { type: "git", revision: entry.revision },
    tool: { name: entry.author.tool ?? "git-for-ai" },
    files: [...byPath.entries()].map(([path, items]) => ({
      path,
      conversations: [
        {
          contributor,
          ranges: items
            .filter((item) => item.range !== undefined)
            .map((item) => ({
              start_line: item.range![0],
              end_line: item.range![1],
              content_hash: `git-blob:${item.blob}`,
            })),
          ...(related !== undefined ? { related } : {}),
        },
      ],
    })),
    metadata: {
      git_for_ai: {
        change_id: entry.change_id,
        summary: entry.summary,
        provenance: entry.provenance,
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        ...(entry.session_ref !== undefined ? { session_ref: entry.session_ref } : {}),
      },
    },
  };
}

// ─── Target resolution (non-minting, shared with pr-comment) ─────────────────

interface ResolvedTarget {
  /** The commit the target resolved to (null for a c/<id> whose head is absent). */
  sha: string | null;
  shortSha: string | null;
  subject: string | null;
  changeId: string | null;
  mapEntry: ChangeMapEntry | null;
}

async function resolveTarget(target: string, ctx: GitContext): Promise<ResolvedTarget> {
  if (/^c\//i.test(target)) {
    const raw = target.slice(2).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(raw)) {
      throw new Error(`'${target}' is not a full c/<change-id> (32 hex chars required here)`);
    }
    const mapEntry = await readChangeMapEntry(raw, ctx);
    const head = mapEntry?.head ?? null;
    let shortSha: string | null = null;
    let subject: string | null = null;
    if (head !== null) {
      const info = await runGit(["log", "-1", "--format=%h%x1f%s", head], {
        ...ctx,
        allowFailure: true,
      });
      if (info.exitCode === 0) {
        const [short, ...rest] = info.stdout.split("");
        shortSha = short ?? null;
        subject = rest.join("");
      }
    }
    return { sha: head, shortSha, subject, changeId: raw, mapEntry };
  }

  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${target}^{commit}`], {
    ...ctx,
    allowFailure: true,
  });
  if (resolved.exitCode !== 0 || resolved.stdout.length === 0) {
    throw new Error(`cannot resolve '${target}' to a commit`);
  }
  const sha = resolved.stdout;
  const info = await runGit(["log", "-1", "--format=%h%x1f%s", sha], ctx);
  const [shortSha, ...rest] = info.stdout.split("");

  // Identity WITHOUT minting: map row, else trailer, else the note's own change_id.
  let changeId: string | null = null;
  let mapEntry: ChangeMapEntry | null = await findEntryByCommitSha(sha, ctx);
  if (mapEntry !== null) {
    changeId = mapEntry.change_id;
  } else {
    changeId = parseChangeIdTrailer(await readCommitMessage(sha, ctx));
    if (changeId !== null) {
      mapEntry = await readChangeMapEntry(changeId, ctx);
    }
  }
  return { sha, shortSha: shortSha ?? null, subject: rest.join(""), changeId, mapEntry };
}

/** Every entry for a resolved target: notes on the target commit + the change's history. */
async function collectTargetEntries(
  resolved: ResolvedTarget,
  ctx: GitContext,
  warnings: string[],
): Promise<LedgerEntry[]> {
  const shas = new Set<string>();
  if (resolved.sha !== null) shas.add(resolved.sha);
  if (resolved.mapEntry !== null) {
    shas.add(resolved.mapEntry.head);
    for (const sha of resolved.mapEntry.history) shas.add(sha);
  }
  const entries: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (const sha of shas) {
    try {
      const read = await readLedgerNoteWithFormat(sha, ctx);
      for (const entry of read?.note.entries ?? []) {
        if (resolved.changeId !== null && entry.change_id !== resolved.changeId) continue;
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
      }
    } catch (error) {
      if (error instanceof LedgerNoteFormatError) {
        warnings.push(`ledger note on commit ${sha} is unreadable — excluded`);
      } else {
        throw error;
      }
    }
  }
  return entries;
}

// ─── pr-comment rendering ────────────────────────────────────────────────────

function flagLine(reasoning: Reasoning | undefined): string | null {
  if (reasoning === undefined) return null;
  const parts: string[] = [];
  if (reasoning.confidence !== undefined) parts.push(`confidence ${reasoning.confidence.toFixed(2)}`);
  if (reasoning.scope_risk !== undefined) parts.push(`risk ${reasoning.scope_risk}`);
  if (reasoning.reversibility !== undefined) parts.push(`undo ${reasoning.reversibility}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function renderPrComment(
  resolved: ResolvedTarget,
  entries: LedgerEntry[],
  ctx: GitContext,
): Promise<{ markdown: string; degraded: boolean }> {
  const lines: string[] = [];
  const commitLabel =
    resolved.shortSha !== null ? `\`${resolved.shortSha}\`` : "(commit not present locally)";
  const changeLabel = resolved.changeId !== null ? ` (change \`c/${resolved.changeId.slice(0, 8)}\`)` : "";

  if (entries.length === 0) {
    // Judgment call #2: honest absence, exit 2.
    lines.push(`### Agent change record — ${commitLabel}${changeLabel}`);
    lines.push("");
    lines.push(
      resolved.subject !== null ? `**${resolved.subject}** *(commit subject)*` : "*(no commit)*",
    );
    lines.push("");
    lines.push(
      "_No captured intent exists for this change — the line above is git metadata, not a_ " +
        "_ledger entry. (pre-git-for-ai history, or capture was not running.)_",
    );
    lines.push("");
    lines.push("<sub>Generated by `git for-ai export --format pr-comment`.</sub>");
    return { markdown: lines.join("\n"), degraded: true };
  }

  const effective = resolveEffectiveEntry(entries);
  const superseded = entries.length - 1;

  lines.push(`### Agent change record — ${commitLabel}${changeLabel}`);
  lines.push("");
  lines.push(`**${effective.summary}**`);
  lines.push("");
  const author = [effective.author.type, effective.author.tool, effective.author.model]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  lines.push(`- **Author:** ${author} (${effective.provenance})`);
  const reasoning = effective.reasoning;
  lines.push(
    `- **Intent:** ${reasoning?.intent !== undefined ? reasoning.intent : "_not captured_"}`,
  );
  for (const constraint of reasoning?.constraints ?? []) {
    lines.push(`- **Constraint:** ${constraint}`);
  }
  const rejected = reasoning?.rejected ?? [];
  if (rejected.length > 0) {
    lines.push("- **Rejected alternatives:**");
    for (const alt of rejected) {
      lines.push(`  - ${alt.option} — ${alt.why}`);
    }
  }
  const tested = reasoning?.tested ?? [];
  if (tested.length > 0) {
    lines.push("- **Tested:**");
    for (const test of tested) {
      lines.push(`  - \`${test}\``);
    }
  } else {
    lines.push("- **Tested:** _no verification evidence captured_");
  }
  const flags = flagLine(reasoning);
  if (flags !== null) {
    lines.push(`- **Flags:** ${flags}`);
  }
  if (effective.scope.length > 0) {
    lines.push(
      `- **Scope:** ${effective.scope
        .map((item) => `\`${item.path}${item.range ? `:${item.range[0]}-${item.range[1]}` : ""}\``)
        .join(", ")}`,
    );
  }

  // Session evidence — resolved read-only; failure is labeled, never faked.
  if (effective.session_ref !== undefined && effective.session_ref !== null) {
    try {
      const record = await readSessionRecord(effective.session_ref, ctx);
      lines.push(
        record !== null
          ? `- **Session:** ${record.agent.tool} ${record.agent.version} (${record.agent.model}) · ` +
              `${record.spans.length} span${record.spans.length === 1 ? "" : "s"} captured`
          : `- **Session:** recorded (\`${effective.session_ref.slice(0, 14)}…\`) but the trace is not stored locally`,
      );
    } catch {
      lines.push(`- **Session:** recorded but unreadable (\`${effective.session_ref.slice(0, 14)}…\`)`);
    }
  } else {
    lines.push("- **Session:** none captured");
  }

  if (superseded > 0) {
    lines.push(
      `- **History:** ${superseded} superseded entr${superseded === 1 ? "y" : "ies"} retained ` +
        `(\`git for-ai show ${resolved.shortSha ?? resolved.sha ?? ""} --history\`)`,
    );
  }
  lines.push("");
  lines.push(
    "<sub>Generated by `git for-ai export --format pr-comment`. Missing fields were not " +
      "captured — never inferred.</sub>",
  );
  return { markdown: lines.join("\n"), degraded: false };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** `git for-ai export --format agent-trace|pr-comment [--out <path>] [<target>]`. */
export async function runExport(options: ExportOptions = {}): Promise<ExportResult> {
  const ctx = toContext(options);
  const format = options.format ?? "agent-trace";
  const warnings: string[] = [];

  // Fail loudly when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  let output: string;
  let records: AgentTraceRecord[] | undefined;
  let exitCode: 0 | 2 = 0;

  if (format === "agent-trace") {
    let byChange: Map<string, LedgerEntry[]>;
    if (options.target !== undefined) {
      const resolved = await resolveTarget(options.target, ctx);
      const entries = await collectTargetEntries(resolved, ctx, warnings);
      byChange = new Map();
      for (const entry of entries) {
        const bucket = byChange.get(entry.change_id) ?? [];
        bucket.push(entry);
        byChange.set(entry.change_id, bucket);
      }
    } else {
      byChange = await collectEntriesByChange(ctx, warnings);
    }

    // Skip changes absorbed by a squash — the survivor's ledger covers them (same rule
    // as reindex judgment call #1).
    records = [];
    for (const [changeId, entries] of [...byChange.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const effective = resolveEffectiveEntry(entries);
      if (effective.folded_into !== undefined) continue;
      const mapEntry = await readChangeMapEntry(changeId, ctx);
      if (mapEntry?.folded_into !== undefined) continue;
      records.push(toTraceRecord(effective));
    }
    output = `${JSON.stringify(records, null, 2)}`;
  } else if (format === "pr-comment") {
    const resolved = await resolveTarget(options.target ?? "HEAD", ctx);
    const entries = await collectTargetEntries(resolved, ctx, warnings);
    const rendered = await renderPrComment(resolved, entries, ctx);
    output = rendered.markdown;
    exitCode = rendered.degraded ? 2 : 0;
  } else {
    throw new Error(`unknown export format '${String(format)}' — expected agent-trace or pr-comment`);
  }

  let path: string | undefined;
  if (options.out !== undefined) {
    const baseDir = options.cwd ?? process.cwd();
    path = isAbsolute(options.out) ? options.out : resolve(baseDir, options.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${output}\n`, "utf8");
  }

  return {
    format,
    ...(records !== undefined ? { records } : {}),
    output,
    ...(path !== undefined ? { path } : {}),
    exitCode,
    warnings,
  };
}

// `git for-ai blame --why <file>:<line>` — Milestone 12 (architecture/CLI_PLAN.md),
// over M11's `explainLine`. Spec: CLI_REFERENCE.md's `blame --why` section and
// ARCHITECTURE.md §9.1: resolve the line to its owning change, render the recorded
// intent (WHY / CONSIDERED & REJECTED / SESSION / LATER TOUCHED BY), and degrade
// honestly — "no captured intent" plus what git actually knows — with exit code 2.
//
// ── Judgment calls ──
// 1. The §9.1 blame output is a DETERMINISTIC template over the ledger entry (engine.ts
//    judgment #2) — no API call by default. `--explain` opts into synthesis (Anthropic
//    API, key-gated exactly like `ask`); without a key it degrades to an honest note.
// 2. The index is OPTIONAL: identity/ledger/session all live in git refs, so blame
//    answers without one (engine.ts judgment #1). A missing/stale/mismatched index
//    degrades to a warning — supplementary retrieval context is skipped, never fatal.
//    Retrieved context sources are rendered only under --explain (where citations need
//    the numbered list) and in --json; the default §9.1 output doesn't list sources.
// 3. `<file>:<line>` is split at the LAST colon (Windows `C:\...` paths survive), the
//    path is normalized to a repo-relative POSIX path, and the engine runs from the
//    repo toplevel — so editor-copied absolute paths and cwd-relative paths both work.
// 4. WHY renders `summary — intent` when an intent was recorded: the summary says what
//    changed, the intent says what it was for — together they are §9.1's why-sentence,
//    assembled without generation.
// 5. `--depth <N>` caps the LATER TOUCHED BY list (default: all), with an explicit
//    `(+N more)` marker — truncation is visible, never silent.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  explainLine,
  runGit,
  SYNTHESIS_KEY_ENV,
  type BlamePosition,
  type BlameWhyResult,
  type Embedder,
  type SynthesisOptions,
} from "@git-for-ai/core";

import { openQueryDeps, type QueryDeps } from "./queryDeps.js";
import { sourceRefLine, synthesisSkipLine, wrapText } from "./ask.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Options for {@link runBlame}, mirroring CLI_REFERENCE.md's `blame --why` flags. */
export interface BlameCliOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--depth <N>` — cap the LATER TOUCHED BY chain (default: unlimited). */
  depth?: number;
  /** `--session` — include a session trace excerpt in the output. */
  session?: boolean;
  /** `--explain` — opt into a synthesized prose explanation (API, key-gated). */
  explain?: boolean;
  /** `--k <N>` — supplementary retrieval breadth (default 8; needs an index). */
  k?: number;
  /** Injectable embedder (tests). */
  embedder?: Embedder;
  /** Synthesis overrides (tests inject apiKey + fetchImpl). */
  synthesis?: SynthesisOptions;
}

/** Git's own metadata for the blamed commit (the degraded case's honest floor). */
export interface BlameCommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Author date, YYYY-MM-DD. */
  date: string;
}

/** The structured result behind the rendered output (what `--json` serializes). */
export interface BlameCliData extends BlameWhyResult {
  commitInfo: BlameCommitInfo | null;
}

export interface BlameCliResult {
  data: BlameCliData;
  output: string;
  /** 0 = intent found; 2 = degraded (uncommitted line, or no captured intent). */
  exitCode: 0 | 2;
}

// ─── <file>:<line> parsing (judgment call #3) ────────────────────────────────

/** Split `<file>:<line>` at the last colon. Throws a usage error on malformed input. */
export function parseFileLine(target: string): { path: string; line: number } {
  const colon = target.lastIndexOf(":");
  const path = colon > 0 ? target.slice(0, colon) : "";
  const lineText = colon > 0 ? target.slice(colon + 1) : "";
  if (path.length === 0 || !/^\d+$/.test(lineText) || Number.parseInt(lineText, 10) < 1) {
    throw new Error(
      `expected <file>:<line> (e.g. src/auth/session.ts:73), got '${target}'`,
    );
  }
  return { path, line: Number.parseInt(lineText, 10) };
}

const short = (sha: string): string => sha.slice(0, 8);
const dateOf = (iso: string): string => iso.slice(0, 10);

/** Field separator for `git log` format strings — never appears in a subject line. */
const FIELD_SEP = "";

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderIntentCase(data: BlameCliData, lines: string[], depth: number | undefined): void {
  const entry = data.entry!;
  const headerDetail =
    entry.reasoning?.confidence !== undefined
      ? `(${entry.provenance}, confidence ${entry.reasoning.confidence.toFixed(2)})`
      : `(${entry.provenance})`;
  lines.push(
    `${data.position.path}:${data.position.line}  change ${short(data.changeId ?? entry.change_id)}  ${headerDetail}`,
  );

  // Judgment call #4: summary — intent, assembled, not generated.
  const why =
    entry.reasoning?.intent !== undefined
      ? `${entry.summary} — ${entry.reasoning.intent}`
      : entry.summary;
  lines.push(...wrapText(why, "WHY: ", "     "));

  const rejected = entry.reasoning?.rejected ?? [];
  if (rejected.length > 0) {
    const text = rejected.map((r) => `${r.option} — ${r.why}`).join("; ");
    lines.push(...wrapText(text, "CONSIDERED & REJECTED: ", "     "));
  }

  const changeRef = `c/${short(data.changeId ?? entry.change_id)}`;
  if (data.sessionRecord !== null) {
    lines.push(
      `SESSION: ${data.sessionRecord.agent.tool}, ${dateOf(data.sessionRecord.captured_at)}  ` +
        `(git for-ai show ${changeRef} --session)`,
    );
  } else if (entry.session_ref !== undefined && entry.session_ref !== null) {
    lines.push(`SESSION: ${entry.session_ref} (trace unavailable — see warnings)`);
  }

  if (data.laterTouchedBy.length > 0) {
    const capped =
      depth !== undefined ? data.laterTouchedBy.slice(0, depth) : data.laterTouchedBy;
    const hidden = data.laterTouchedBy.length - capped.length;
    capped.forEach((related, index) => {
      const prefix = index === 0 ? "LATER TOUCHED BY: " : "                  ";
      lines.push(
        `${prefix}c/${short(related.changeId)} (${dateOf(related.createdAt)}, "${related.summary}")` +
          (index === capped.length - 1 && hidden === 0
            ? " — this line's rationale may have evolved."
            : ""),
      );
    });
    if (hidden > 0) {
      lines.push(`                  (+${hidden} more — raise --depth to include)`);
    }
  }
}

function renderDegradedCase(data: BlameCliData, lines: string[]): void {
  const position = `${data.position.path}:${data.position.line}`;
  if (data.commit === null) {
    lines.push(`${position}  (uncommitted — this line is not attributed to any commit yet)`);
    lines.push("No commit owns this line; commit it first to give it durable identity.");
    lines.push("Answer confidence: none.");
    return;
  }
  const info = data.commitInfo;
  const header =
    data.changeId !== null
      ? `change ${short(data.changeId)}  (change known, no captured intent)`
      : `commit ${info?.shortSha ?? short(data.commit)}  (no captured intent — pre-git-for-ai history)`;
  lines.push(`${position}  ${header}`);
  lines.push("No ledger entry or session exists for this line. Here is what git knows:");
  if (info !== null) {
    lines.push(`  commit ${info.shortSha}  "${info.subject}"  by ${info.author}  ${info.date}`);
  } else {
    lines.push(`  commit ${short(data.commit)}  (commit object not readable)`);
  }
  lines.push("Answer confidence: none — this is git metadata only, not synthesized intent.");
}

function renderSessionExcerpt(data: BlameCliData, lines: string[]): void {
  if (data.sessionRecord === null) {
    return;
  }
  const record = data.sessionRecord;
  const shown = record.spans.slice(0, 10);
  lines.push(
    `SESSION TRACE (${record.spans.length} span${record.spans.length === 1 ? "" : "s"}` +
      `${shown.length < record.spans.length ? `, first ${shown.length}` : ""}):`,
  );
  for (const span of shown) {
    const meta = [span.kind, span.name].filter((part): part is string => part !== undefined);
    lines.push(`  ${span.span_id}  ${meta.join("  ")}`);
  }
  if (shown.length < record.spans.length) {
    lines.push(`  … (git for-ai show c/${short(data.changeId ?? "")} --session for the full trace)`);
  }
}

function renderExplain(data: BlameCliData, lines: string[]): void {
  if (data.synthesis.synthesized && data.synthesis.answer !== null) {
    lines.push(...wrapText(data.synthesis.answer, "SYNTHESIZED: ", "     "));
    if (data.sources.length > 0) {
      lines.push("  Context sources:");
      data.sources.forEach((source, index) => {
        lines.push(`    ${sourceRefLine(source, index + 1)}`);
      });
    }
  } else if (data.synthesis.skippedReason !== "not-requested") {
    if (data.synthesis.skippedReason === "no-api-key") {
      lines.push(
        `SYNTHESIZED: unavailable — no API key configured (set ${SYNTHESIS_KEY_ENV}).`,
      );
    } else {
      lines.push(`SYNTHESIZED: unavailable — ${synthesisSkipLine(data.synthesis, false)}`);
    }
  }
}

function render(data: BlameCliData, options: BlameCliOptions): string {
  const lines: string[] = [];
  if (data.entry !== null) {
    renderIntentCase(data, lines, options.depth);
  } else {
    renderDegradedCase(data, lines);
  }
  if (options.session === true) {
    renderSessionExcerpt(data, lines);
  }
  if (options.explain === true) {
    renderExplain(data, lines);
  }
  for (const warning of data.warnings) {
    lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * `git for-ai blame --why <file>:<line>`: line → commit → change → recorded intent.
 * Pure logic, no console I/O — bin.ts prints `result.output` and sets the exit code.
 */
export async function runBlame(
  target: string,
  options: BlameCliOptions = {},
): Promise<BlameCliResult> {
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 1)) {
    throw new Error(`invalid --depth ${options.depth} (expected a positive integer)`);
  }
  if (options.k !== undefined && (!Number.isInteger(options.k) || options.k < 1)) {
    throw new Error(`invalid --k ${options.k} (expected a positive integer)`);
  }
  const parsed = parseFileLine(target);

  // Resolve the repo toplevel; fail loudly when cwd is not a repository at all.
  const cwd = options.cwd ?? process.cwd();
  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (toplevel.exitCode !== 0) {
    throw new Error(`not a git repository (or any parent up to mount point): ${cwd}`);
  }
  const repoRoot = toplevel.stdout;
  const ctx = { cwd: repoRoot };

  // Normalize to a repo-relative POSIX path (judgment call #3): absolute paths and
  // cwd-relative paths both map onto the path git (and the index) knows the file by.
  // Both sides are canonicalized (realpath) because on Windows the process cwd can be
  // an 8.3 short path (HURRIC~1) while git reports the long form — a textual
  // `relative()` across the two would wrongly claim the file is outside the repo.
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path); // nonexistent path — git blame will say so, loudly
    }
  };
  const normalizedInput = parsed.path.replaceAll("\\", "/");
  const absolute = isAbsolute(normalizedInput)
    ? canonical(normalizedInput)
    : resolve(canonical(cwd), normalizedInput);
  let repoRelative = relative(canonical(repoRoot), absolute).replaceAll("\\", "/");
  if (repoRelative.startsWith("../") || repoRelative === "..") {
    throw new Error(`${parsed.path} is outside the repository at ${repoRoot}`);
  }
  if (repoRelative.length === 0) {
    repoRelative = normalizedInput;
  }
  const position: BlamePosition = { path: repoRelative, line: parsed.line };

  // The index is optional (judgment call #2): open it if it is ready, degrade otherwise.
  let deps: QueryDeps | null = null;
  const indexWarnings: string[] = [];
  try {
    deps = await openQueryDeps({
      cwd: repoRoot,
      ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
    });
    indexWarnings.push(...deps.warnings);
  } catch (error) {
    indexWarnings.push(
      `supplementary context skipped — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const result = await explainLine(
      {
        ctx,
        ...(deps !== null ? { store: deps.store, embedder: deps.embedder } : {}),
      },
      position,
      {
        ...(options.k !== undefined ? { k: options.k } : {}),
        ...(options.explain === true ? { synthesize: true } : {}),
        ...(options.synthesis !== undefined ? { synthesis: options.synthesis } : {}),
      },
    );

    // Git's own metadata for the blamed commit — the degraded case's honest floor.
    let commitInfo: BlameCommitInfo | null = null;
    if (result.commit !== null) {
      const info = await runGit(
        ["log", "-1", `--format=%H%x1f%h%x1f%s%x1f%an%x1f%as`, result.commit],
        { ...ctx, allowFailure: true },
      );
      if (info.exitCode === 0 && info.stdout.length > 0) {
        const [sha, shortSha, subject, author, date] = info.stdout.split(FIELD_SEP);
        if (sha !== undefined && shortSha !== undefined) {
          commitInfo = {
            sha,
            shortSha,
            subject: subject ?? "",
            author: author ?? "",
            date: date ?? "",
          };
        }
      }
    }

    const data: BlameCliData = {
      ...result,
      commitInfo,
      warnings: [...indexWarnings, ...result.warnings],
    };
    return {
      data,
      output: render(data, options),
      exitCode: data.entry !== null ? 0 : 2,
    };
  } finally {
    deps?.close();
  }
}

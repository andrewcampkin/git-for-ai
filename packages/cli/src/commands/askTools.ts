// The toolbox `ask` hands to its own answering model — architecture/ASK_TOOLS.md §4.
//
// The point (owner, 2026-07-25): "the ask functionality should be able to use the git
// for-ai features itself, that is partly the point. i dont think we should be preemptively
// guessing what the ask needs to shove it into context right?" So instead of a keyword
// classifier that pre-fetches whatever WE guessed the question needed, the model is given
// the same reads `git for-ai mcp` already exposes to other agents, and decides for itself.
//
// Every tool wraps the IDENTICAL pure function its CLI command wraps (runShow, runLog,
// runBlame, readCommitDiff) — the same discipline mcp.ts and the desktop action endpoints
// follow, so degradation messages, the non-minting read guarantee, and honest labeling are
// all inherited rather than re-implemented. Core defines the SynthesisTool interface and
// owns the loop; these implementations live here because core never imports the CLI
// (hard rule 6).
//
// ── Judgment calls ──
// 1. Descriptions are prescriptive about WHEN to call, not just what exists. The failure
//    being fixed is a model that refused rather than looked; an under-triggered tool
//    reproduces it exactly. Each description names the question shape it answers.
// 2. Output is the command's OWN rendered text, not JSON. It is what the CLI already
//    prints, already carries the honest "no captured intent" labels, and costs fewer
//    tokens than the structured form. `commit_diff` is the exception — readCommitDiff is
//    a data-only reader (the review UI renders it), so the patch text is rebuilt here.
// 3. Every tool output is capped (MAX_TOOL_OUTPUT_CHARS) with an explicit truncation
//    notice. A 20k-line diff would otherwise blow the context window on one call, and
//    silently dropping the tail would be exactly the fabrication risk we design against.
// 4. Reads only — no `annotate`, no writes of any kind. `ask` is a read (§5.3), and every
//    wrapped command is already on a non-minting read path.
// 5. The caller's already-loaded embedder is threaded into `blame_why`, which opens the
//    query index for supplementary context. Without it a nested runBlame would load a
//    SECOND embedding model inside a process that already has one — the RAM rule (hard
//    rule 7) makes that unacceptable on the owner's machine.

import type { Embedder, SynthesisTool } from "@git-for-ai/core";

import { runShow } from "./show.js";
import { runLog } from "./log.js";
import { runBlame } from "./blame.js";
import { readCommitDiff, type ReviewDiffData } from "./reviewGit.js";

/** Per-call output cap (judgment call #3). Generous for a commit, bounded against a monster. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** Options for {@link createAskTools}. */
export interface AskToolsOptions {
  /** Repository the tools read. Defaults to the current process cwd. */
  cwd?: string;
  /** The caller's query embedder, reused by `blame_why` (judgment call #5). */
  embedder?: Embedder;
  /** Output cap override (tests). */
  maxChars?: number;
}

/** Clip long output, saying so — never silently. */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return (
    `${text.slice(0, maxChars)}\n` +
    `… output truncated at ${maxChars} characters (${text.length} total). ` +
    "Ask for a narrower target (a single file or commit) to see the rest."
  );
}

// ─── Input coercion ──────────────────────────────────────────────────────────
//
// Tool arguments come from a model, so they are validated like any other untrusted
// input. A throw here is reported back as a tool error (core's loop), which is the
// feedback the model needs to retry with the right shape.

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`'${field}' is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`'${field}' must be a non-empty string when provided`);
  }
  return value.trim();
}

function optionalInt(
  input: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`'${field}' must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// ─── commit_diff rendering (judgment call #2) ────────────────────────────────

/** Render readCommitDiff's structured patch as the unified diff a model reads best. */
export function renderCommitDiff(diff: ReviewDiffData): string {
  const lines: string[] = [
    `commit ${diff.sha}`,
    `subject: ${diff.subject}`,
    diff.against !== null
      ? `diffed against ${diff.against}${diff.isMerge ? " (first parent — merge commit)" : ""}`
      : "diffed against the empty tree (root commit)",
    `${diff.totals.files} file(s) changed, +${diff.totals.additions} -${diff.totals.deletions}`,
  ];
  for (const warning of diff.warnings) {
    lines.push(`note: ${warning}`);
  }

  for (const file of diff.files) {
    lines.push("");
    const rename = file.oldPath !== null ? ` (was ${file.oldPath})` : "";
    lines.push(`--- ${file.path}${rename} [${file.status}] +${file.additions} -${file.deletions}`);
    if (file.binary) {
      lines.push("    (binary file — no text patch)");
      continue;
    }
    for (const hunk of file.hunks) {
      lines.push(hunk.header);
      for (const line of hunk.lines) {
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        lines.push(`${marker}${line.text}`);
      }
    }
    if (file.truncated) {
      lines.push("    … this file's patch was truncated (the +/- counts above are complete)");
    }
  }
  return lines.join("\n");
}

// ─── The toolbox ─────────────────────────────────────────────────────────────

/**
 * The four repository reads `ask` offers its answering model (ASK_TOOLS.md §4 v1).
 * Deliberately NOT included: a `search_repository` tool re-entering `askQuestion` (that
 * is circular — revisit once the loop is proven), and anything that writes.
 */
export function createAskTools(options: AskToolsOptions = {}): SynthesisTool[] {
  const cwd = options.cwd !== undefined ? { cwd: options.cwd } : {};
  const embedder = options.embedder !== undefined ? { embedder: options.embedder } : {};
  const maxChars = options.maxChars ?? MAX_TOOL_OUTPUT_CHARS;
  const capped = (text: string): string => clip(text, maxChars);

  return [
    {
      name: "commit_diff",
      description:
        "Read the actual code changes in one commit: every file it touched, with the " +
        "patch. Call this whenever the question is about what a commit did, what changed " +
        "recently, or which files a change touched — the recorded summaries say WHY a " +
        "change was made, not WHAT it modified, so this is the only way to answer that. " +
        "Accepts anything git accepts: HEAD, a full or short SHA, a branch name.",
      inputSchema: {
        type: "object",
        properties: {
          sha: {
            type: "string",
            description: "Commit to read (e.g. 'HEAD', 'HEAD~1', 'd487e6a', a branch name)",
          },
          context: {
            type: "integer",
            description: "Lines of context around each change (default 3, max 20)",
          },
        },
        required: ["sha"],
      },
      async run(input) {
        const sha = requireString(input, "sha");
        const contextLines = optionalInt(input, "context", 0, 20);
        const diff = await readCommitDiff(sha, {
          ...cwd,
          ...(contextLines !== undefined ? { contextLines } : {}),
        });
        return capped(renderCommitDiff(diff));
      },
    },
    {
      name: "show_change",
      description:
        "Read everything recorded about one change: the commit, its change-id, the " +
        "captured intent (summary, reasoning, what was considered and rejected), and the " +
        "agent session behind it. Call this when the question names a specific commit or " +
        "change and you need the reasoning rather than the code — or to expand a source " +
        "whose summary line is too thin to answer from.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "A commit-ish (SHA, HEAD, branch) or 'c/<change-id>'",
          },
          history: {
            type: "boolean",
            description: "Include superseded ledger entries, not just the effective one",
          },
        },
        required: ["target"],
      },
      async run(input) {
        const target = requireString(input, "target");
        const result = await runShow(target, {
          ...cwd,
          ...(input["history"] === true ? { history: true } : {}),
        });
        return capped(result.output);
      },
    },
    {
      name: "log_intent",
      description:
        "List recent commits with their captured intent, newest first — the branch's " +
        "history at a glance. Call this for questions about what has been happening " +
        "lately, when a change landed, or to find the commit to look at before calling " +
        "commit_diff or show_change. Optionally scope to one file or directory.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "integer", description: "How many commits to list (default 10, max 50)" },
          rev: { type: "string", description: "Revision to walk from (default HEAD)" },
          path: { type: "string", description: "Only commits touching this file or directory" },
        },
      },
      async run(input) {
        const n = optionalInt(input, "n", 1, 50) ?? 10;
        const rev = optionalString(input, "rev");
        const path = optionalString(input, "path");
        const result = await runLog({
          ...cwd,
          maxCount: n,
          ...(rev !== undefined ? { rev } : {}),
          ...(path !== undefined ? { path } : {}),
        });
        return capped(result.output.length > 0 ? result.output : "(no commits matched)");
      },
    },
    {
      name: "blame_why",
      description:
        "Explain why one specific line of code looks the way it does: the change that " +
        "introduced it, the reasoning captured at the time, and later changes to the same " +
        "file. Call this when the question is about a particular line or a specific piece " +
        "of code rather than about a commit.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Repository-relative path, e.g. src/auth/session.ts" },
          line: { type: "integer", description: "1-based line number" },
        },
        required: ["file", "line"],
      },
      async run(input) {
        const file = requireString(input, "file");
        const line = optionalInt(input, "line", 1, Number.MAX_SAFE_INTEGER);
        if (line === undefined) {
          throw new Error("'line' is required and must be a positive integer");
        }
        // No `explain` — blame's own synthesis would nest an API call inside this one.
        const result = await runBlame(`${file}:${line}`, { ...cwd, ...embedder });
        return capped(result.output);
      },
    },
  ];
}

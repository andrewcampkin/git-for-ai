// `git for-ai mcp` — the stdio MCP server (architecture/PLAN_2026-07-18.md §2.3): the
// intent layer exposed as native tools for MCP-capable agents (Claude Code first).
// Thin by design — every tool wraps the SAME pure run* function its CLI command wraps
// (runAsk/runBlame/runShow/runLog/runAnnotate/runDoctor), so behavior, degradation
// messages, key handling (GIT_FOR_AI_ANTHROPIC_KEY preferred, then ANTHROPIC_API_KEY —
// core's SYNTHESIS_KEY_ENV), and the established non-minting read discipline are all
// inherited, never re-implemented.
//
// ── Judgment calls ──
// 1. Errors are MCP TOOL errors (`isError: true` + the message), never crashes and never
//    protocol errors: the actionable CLI messages ("run `git for-ai init`" → "run
//    `git for-ai reindex`" → "run `git for-ai reindex --full`") flow through verbatim,
//    which is exactly what an agent needs to self-heal the environment.
// 2. Tool results are the structured JSON the CLI's `--json` flag serializes (AskResult,
//    BlameWhyResult+commitInfo, ShowData, log lines, DoctorData) — machine consumers get
//    the machine shape; the human rendering stays a CLI concern.
// 3. stdout is the protocol channel: nothing here (or in the wrapped pure functions,
//    which do no console I/O by contract) may write to stdout. The transport owns it.
// 4. `annotate` is the ONE write tool and says so in its description + annotations
//    (append-only ledger note — nothing is ever overwritten or deleted, so
//    destructiveHint is false but readOnlyHint is too).
// 5. Read tools carry readOnlyHint: true. Caveat inherited from log/show: resolving a
//    commit that carries identity evidence may lazily heal trailer-recovered identity
//    back into the change-map (ARCHITECTURE §7.5 "recovery is triggered by any read");
//    commits with no evidence are never minted identity — the same non-minting read
//    paths the CLI uses.
// 6. Test seam: GIT_FOR_AI_MCP_TEST_EMBEDDER=bag-of-words makes the spawned server use
//    the deterministic BagOfWordsEmbedder from @git-for-ai/core/testing (dynamically
//    imported — production never loads it), because the in-process `embedder` injection
//    the CLI tests use cannot cross a process boundary. The real model is never loaded
//    in tests (project resource discipline).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Embedder, SynthesisOptions } from "@git-for-ai/core";

import { runAsk } from "./ask.js";
import { runBlame } from "./blame.js";
import { runShow } from "./show.js";
import { runLog } from "./log.js";
import { runAnnotate } from "./annotate.js";
import { runDoctor } from "./doctor.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Options for {@link createMcpServer} / {@link runMcpServer}. */
export interface McpCliOptions {
  /** Repository to serve (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** Injectable embedder (tests — the real model is never loaded in tests). */
  embedder?: Embedder;
  /** Synthesis overrides (tests inject apiKey + fetchImpl; production leaves unset). */
  synthesis?: SynthesisOptions;
}

/**
 * Test-only env seam for the SPAWNED server: `bag-of-words` selects the deterministic
 * fake embedder (judgment call #6). Unset (production): the configured real embedder.
 */
export const TEST_EMBEDDER_ENV = "GIT_FOR_AI_MCP_TEST_EMBEDDER";

/** Server identity: name matches the binary; version matches the package. */
export const MCP_SERVER_INFO = { name: "git-for-ai", version: "0.0.0" } as const;

const SERVER_INSTRUCTIONS =
  "Tools over a git repository's captured intent layer (git-for-ai): ask questions over " +
  "recorded intent (ask), explain why a line exists (blame_why), dump a change's ledger " +
  "entry and session (show), list commits with intent summaries (log_intent), audit the " +
  "setup (doctor), and deliberately record intent for a change (annotate — the one tool " +
  "that writes). Retrieval is fully local; `ask`/`blame_why` synthesis calls the " +
  "Anthropic API only when GIT_FOR_AI_ANTHROPIC_KEY (preferred) or ANTHROPIC_API_KEY is " +
  "set, and degrades to ranked raw sources otherwise.";

// ─── Result / error helpers ──────────────────────────────────────────────────

/** Serialize a structured result as the tool's JSON text content. */
function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Run a tool handler, mapping any thrown error to an MCP tool error (judgment call #1).
 * The wrapped run* functions throw actionable messages; those flow through verbatim.
 */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

// ─── Server construction ─────────────────────────────────────────────────────

/**
 * Build the MCP server with the six intent-layer tools registered. Exported separately
 * from {@link runMcpServer} so tests can drive the exact production server over an
 * in-memory transport with an injected embedder / mocked-fetch synthesis.
 */
export function createMcpServer(options: McpCliOptions = {}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  const cwd = options.cwd !== undefined ? { cwd: options.cwd } : {};
  const embedder = options.embedder !== undefined ? { embedder: options.embedder } : {};
  const synthesis = options.synthesis !== undefined ? { synthesis: options.synthesis } : {};

  server.registerTool(
    "ask",
    {
      title: "Ask the repository's intent layer",
      description:
        "Ask a free-form question about this repository's changes, answered from captured " +
        "intent (ledger entries, agent session summaries, code chunks) via local hybrid " +
        "keyword+vector retrieval. Returns the AskResult JSON: ranked `sources` with the " +
        "records behind them, and `synthesis` (a cited prose answer when an Anthropic key " +
        "is configured — GIT_FOR_AI_ANTHROPIC_KEY preferred — otherwise an honest " +
        "skippedReason with the ranked sources standing on their own). When synthesis is " +
        "enabled it may also read this repository directly (commit diffs, changes, log, " +
        "blame) to answer; `synthesis.toolCalls` records exactly what it read. Requires " +
        "the local index (`git for-ai reindex`).",
      inputSchema: {
        question: z.string().describe("Free-form question about this repository's changes"),
        k: z.number().int().min(1).optional().describe("Retrieval breadth (default 8)"),
        sources_only: z
          .boolean()
          .optional()
          .describe("Skip synthesis (never calls the API); return only the ranked sources"),
        since: z.string().optional().describe("Only sources recorded after this date (e.g. 2026-07-01)"),
        until: z.string().optional().describe("Only sources recorded before this date"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await runAsk(args.question, {
          ...cwd,
          ...embedder,
          ...synthesis,
          ...(args.k !== undefined ? { k: args.k } : {}),
          ...(args.sources_only === true ? { sourcesOnly: true } : {}),
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.until !== undefined ? { until: args.until } : {}),
        });
        return jsonResult(result.data);
      }),
  );

  server.registerTool(
    "blame_why",
    {
      title: "Explain why a line looks the way it does",
      description:
        "Resolve a file:line to its owning change and return the BlameWhyResult JSON: the " +
        "recorded intent (`entry` — summary, intent, rejected alternatives, confidence), " +
        "the linked session record, later changes that touched the line, and git's own " +
        "commit metadata as the honest floor when no intent was captured (entry: null). " +
        "Deterministic by default; set `explain: true` to opt into a synthesized prose " +
        "explanation (Anthropic API, key-gated exactly like `ask`). Works without an " +
        "index; a missing index degrades to a warning.",
      inputSchema: {
        file: z.string().describe("File path (repo-relative or absolute), e.g. src/auth/session.ts"),
        line: z.number().int().min(1).describe("1-based line number"),
        depth: z.number().int().min(1).optional().describe("Cap the later-touched-by chain at N changes"),
        session: z.boolean().optional().describe("Include a session trace excerpt"),
        explain: z
          .boolean()
          .optional()
          .describe("Opt into a synthesized prose explanation (needs an Anthropic key)"),
        k: z.number().int().min(1).optional().describe("Supplementary retrieval breadth (default 8)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await runBlame(`${args.file}:${args.line}`, {
          ...cwd,
          ...embedder,
          ...synthesis,
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.session === true ? { session: true } : {}),
          ...(args.explain === true ? { explain: true } : {}),
          ...(args.k !== undefined ? { k: args.k } : {}),
        });
        return jsonResult(result.data);
      }),
  );

  server.registerTool(
    "show",
    {
      title: "Show a change's ledger entry and session",
      description:
        "Dump the ShowData JSON for a commit-ish (SHA, HEAD, branch) or c/<change-id> " +
        "target: the resolved commit, change identity, change-map entry, every ledger " +
        "entry (the effective one marked; superseded entries retained), and the linked " +
        "session record. Every absent piece of data is explicitly labelled, never " +
        "silently omitted. Set `session: true` to note the full span trace is wanted " +
        "(the JSON always carries all spans); `history` mirrors the CLI flag.",
      inputSchema: {
        target: z.string().describe("Commit-ish (SHA, HEAD, branch) or c/<change-id>"),
        session: z.boolean().optional().describe("Mirror of the CLI --session flag"),
        history: z.boolean().optional().describe("Mirror of the CLI --history flag (superseded entries)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await runShow(args.target, {
          ...cwd,
          ...(args.session === true ? { session: true } : {}),
          ...(args.history === true ? { history: true } : {}),
        });
        return jsonResult(result.data);
      }),
  );

  server.registerTool(
    "log_intent",
    {
      title: "List commits with their intent summaries",
      description:
        "git log annotated with the effective one-line intent summary per commit. Returns " +
        "structured rows (sha, changeId, summary, annotation, hasIntent), newest first. " +
        "Commits with no captured intent show their own subject line, explicitly labelled " +
        "— never a fabricated summary.",
      inputSchema: {
        path: z.string().optional().describe("Scope to commits touching a file or directory"),
        max_count: z.number().int().min(1).optional().describe("Limit to the N most recent commits"),
        since: z.string().optional().describe("Only commits after this date"),
        until: z.string().optional().describe("Only commits before this date"),
        rev: z.string().optional().describe("Revision to walk from (default HEAD)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await runLog({
          ...cwd,
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.max_count !== undefined ? { maxCount: args.max_count } : {}),
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.until !== undefined ? { until: args.until } : {}),
          ...(args.rev !== undefined ? { rev: args.rev } : {}),
        });
        return jsonResult(result.lines);
      }),
  );

  server.registerTool(
    "annotate",
    {
      title: "Record intent for a change (WRITE)",
      description:
        "WRITE TOOL — the one tool here that modifies the repository: appends a ledger " +
        "entry to the intent note for a commit or change (append-only; nothing is ever " +
        "overwritten or deleted, and the new entry becomes the effective one). Use it to " +
        "deliberately record what a change was for: summary, intent, constraints, " +
        "rejected alternatives, confidence, scope_risk, reversibility, tested, related. " +
        "`entry` is the same partial-entry JSON contract as `git for-ai annotate " +
        "--stdin`: accepted keys are summary (required), reasoning, scope, author, " +
        "session_ref — unknown keys are rejected loudly, and the whole entry is " +
        "schema-validated before anything is written. Returns the entry exactly as " +
        "written.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("Commit-ish or c/<change-id> to annotate (default HEAD)"),
        entry: z
          .record(z.unknown())
          .describe(
            "Partial ledger entry: { summary, reasoning?, scope?, author?, session_ref? }. " +
              "reasoning may carry intent, constraints, rejected [{option, why}], " +
              "confidence (0..1), scope_risk, reversibility, directive, tested, related.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      guard(async () => {
        const result = await runAnnotate(args.target ?? "HEAD", {
          ...cwd,
          stdinJson: JSON.stringify(args.entry),
        });
        return jsonResult({
          sha: result.sha,
          changeId: result.changeId,
          entry: result.entry,
          entryCount: result.entryCount,
        });
      }),
  );

  server.registerTool(
    "doctor",
    {
      title: "Audit the git-for-ai setup",
      description:
        "Read-only health audit of this repository's git-for-ai setup: hooks, refspecs, " +
        "index schema/fingerprint, embedder reachability, identity audits (inferred/" +
        "orphan rows), ledger note format, dangling session refs, skipped captures. " +
        "Returns the structured DoctorData report; every non-ok check carries concrete " +
        "remediation steps (the command that heals it).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const result = await runDoctor({ ...cwd });
        return jsonResult(result.data);
      }),
  );

  return server;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * `git for-ai mcp`: connect the server to stdio and serve until the client hangs up.
 * bin.ts calls this and prints NOTHING — stdout belongs to the protocol (judgment #3).
 */
export async function runMcpServer(options: McpCliOptions = {}): Promise<McpServer> {
  const resolved: McpCliOptions = { ...options };
  if (resolved.embedder === undefined && process.env[TEST_EMBEDDER_ENV] === "bag-of-words") {
    // Judgment call #6: spawned-server test seam; dynamic import so production never
    // touches the testing module.
    const testing = await import("@git-for-ai/core/testing");
    resolved.embedder = new testing.BagOfWordsEmbedder();
  }
  const server = createMcpServer(resolved);
  await server.connect(new StdioServerTransport());
  return server;
}

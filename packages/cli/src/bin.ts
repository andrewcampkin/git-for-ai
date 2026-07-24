#!/usr/bin/env node
// Commander.js entry point for `git-for-ai` / `git for-ai <command>`.
//
// Each command's logic lives in its own module under ./commands/ as a pure exported
// function (no console I/O inside the logic) — this file only parses flags, calls the
// function, and renders its structured result. Commands not yet implemented (see
// architecture/CLI_PLAN.md for the milestone order) are intentionally absent rather than
// registered as stubs, so `--help` never advertises something that doesn't work.

import { Command } from "commander";

import { runInit, formatInitResult, type InitOptions } from "./commands/init.js";
import { runLog, type LogIntentOptions } from "./commands/log.js";
import { runShow, type ShowOptions } from "./commands/show.js";
import { runCaptureSession } from "./commands/capture-session.js";
import { runInternalHook, logHookFailure } from "./commands/internal-hook.js";
import { runAnnotate, type AnnotateOptions } from "./commands/annotate.js";
import { runRelink } from "./commands/relink.js";
import { runReconcile } from "./commands/reconcile.js";
import { runReindex, type ReindexOptions } from "./commands/reindex.js";
import { runReport, type ReportOptions } from "./commands/report.js";
import { runReview, type ReviewOptions } from "./commands/review.js";
import { runAsk, type AskCliOptions } from "./commands/ask.js";
import { runBlame, type BlameCliOptions } from "./commands/blame.js";
import { runConfigGet, runConfigSet, type ConfigOptions } from "./commands/config.js";
import { runSync, type SyncOptions } from "./commands/sync.js";
import { runDoctor } from "./commands/doctor.js";
import { runExport, type ExportOptions } from "./commands/export.js";
import { runMcpServer } from "./commands/mcp.js";

/** Read all of stdin (post-rewrite's old/new SHA pairs). Empty when stdin is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const program = new Command();

program
  .name("git-for-ai")
  .description("Intent-aware source control, layered on Git. Invoke as `git for-ai <command>`.")
  .version("0.0.0");

program
  .command("init")
  .description("Opt in this repository: install hooks, configure refs, create .git-for-ai/")
  .option("--repo <path>", "repository to initialize (default: current directory)")
  .option("--embedder <id>", "embedding provider to record in config.toml", "jina-v2-code")
  .option("--hooks-path <dir>", "override the hooks directory")
  .option("--no-claude-hooks", "skip .claude/settings.json (git-side hooks only)")
  .option("--force", "regenerate existing managed hook blocks")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const initOptions: InitOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.embedder !== undefined ? { embedder: opts.embedder } : {}),
      ...(opts.hooksPath !== undefined ? { hooksPath: opts.hooksPath } : {}),
      claudeHooks: opts.claudeHooks,
      force: opts.force ?? false,
    };
    const result = await runInit(initOptions);
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result, null, 2)}\n` : `${formatInitResult(result)}\n`,
    );
  });

program
  .command("log")
  .description("git log annotated with the one-line intent summary per commit")
  .argument("[path]", "scope to commits touching a file or directory")
  .option("--repo <path>", "repository to read (default: current directory)")
  .option("--intent", "annotate with intent summaries (implied; accepted for CLI_REFERENCE parity)")
  .option("-n, --max-count <N>", "limit to the N most recent commits", (v) => Number.parseInt(v, 10))
  .option("--since <date>", "only commits after this date")
  .option("--until <date>", "only commits before this date")
  .option("--change", "show the full change-id in place of the abbreviated SHA")
  .option("--rev <rev>", "revision to walk from (default: HEAD)")
  .option("--json", "machine-readable output")
  .action(async (path: string | undefined, opts) => {
    const logOptions: LogIntentOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(opts.maxCount !== undefined ? { maxCount: opts.maxCount } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
      ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
      ...(opts.change === true ? { change: true } : {}),
    };
    const result = await runLog(logOptions);
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(result.lines, null, 2)}\n`);
    } else if (result.output.length > 0) {
      process.stdout.write(`${result.output}\n`);
    }
  });

program
  .command("capture-session")
  .description("Internal, hook-invoked: capture agent session context at commit time")
  .requiredOption("--event <kind>", "hook event kind: plan | maybe-commit")
  .option("--quiet", "suppress the log line on stdout")
  .action(async (opts) => {
    // THE ONE HARD RULE (ARCHITECTURE.md §10.2): this command always exits 0 — a hook
    // must never break the user's commit. runCaptureSession never rejects by contract,
    // but guard anyway.
    try {
      const { logLine } = await runCaptureSession({ event: opts.event });
      if (opts.quiet !== true) {
        process.stdout.write(`${logLine}\n`);
      }
    } catch {
      // swallow — failures are already logged to .git-for-ai/capture.log where possible
    }
    process.exitCode = 0;
  });

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

program
  .command("relink")
  .description("Manually re-point a change to a commit, or --detach a misattributed commit")
  .argument("<args...>", "<change-id> <commit>, or --detach <commit>")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option("--detach", "remove <commit> from its claimed change and give it fresh identity")
  .option("--json", "machine-readable output")
  .action(async (args: string[], opts) => {
    const result = await runRelink(args, {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.detach === true ? { detach: true } : {}),
    });
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result, null, 2)}\n` : `${result.output}\n`,
    );
  });

program
  .command("reconcile")
  .description("Eagerly heal the change-map from Change-Id trailers (§7.5 recovery)")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option("--rebuild-map", "reconstruct the entire map from trailers (recovery path)")
  .option("--by-content", "NOT IMPLEMENTED YET: best-effort re-link via patch similarity")
  .option("--limit <N>", "commits to scan in the default mode", (v) => Number.parseInt(v, 10))
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    if (opts.byContent === true) {
      throw new Error("--by-content is not implemented yet (planned alongside doctor — see PLAN_2026-07-18.md W3)");
    }
    const result = await runReconcile({
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.rebuildMap === true ? { rebuildMap: true } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result, null, 2)}\n` : `${result.output}\n`,
    );
  });

program
  .command("annotate")
  .description("Deliberately record intent: append a full ledger entry to a commit or change")
  .argument("[target]", "commit-ish or c/<change-id> to annotate", "HEAD")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option("--stdin", "read a JSON partial entry (summary/reasoning/scope/author/session_ref) from stdin")
  .option("--summary <text>", "one-line 'what changed' (required unless provided via --stdin)")
  .option("--intent <text>", "the goal — what outcome the change is trying to achieve")
  .option("--constraint <text>", "hard requirement the change had to respect (repeatable)", collect)
  .option("--rejected <option::why>", "alternative considered and why it was rejected (repeatable)", collect)
  .option("--confidence <n>", "confidence in the approach, 0..1", (v) => Number.parseFloat(v))
  .option("--scope-risk <level>", "blast radius: low | medium | high")
  .option("--reversibility <level>", "how hard to undo: easy | moderate | hard")
  .option("--directive <text>", "the originating instruction/prompt")
  .option("--tested <text>", "how it was verified (repeatable)", collect)
  .option("--related <ref>", "related commit SHA or c/<change-id> (repeatable)", collect)
  .option("--as <type>", "author type: agent | human | mixed")
  .option("--tool <name>", "authoring tool (e.g. claude-code); implies --as agent")
  .option("--model <name>", "authoring model (e.g. claude-fable-5); implies --as agent")
  .option("--session-ref <ref>", "link an existing session record (sha256:<64hex>)")
  .option("--json", "machine-readable output")
  .action(async (target: string, opts) => {
    const annotateOptions: AnnotateOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.stdin === true ? { stdinJson: await readStdin() } : {}),
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
      ...(opts.constraint !== undefined ? { constraints: opts.constraint } : {}),
      ...(opts.rejected !== undefined ? { rejected: opts.rejected } : {}),
      ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
      ...(opts.scopeRisk !== undefined ? { scopeRisk: opts.scopeRisk } : {}),
      ...(opts.reversibility !== undefined ? { reversibility: opts.reversibility } : {}),
      ...(opts.directive !== undefined ? { directive: opts.directive } : {}),
      ...(opts.tested !== undefined ? { tested: opts.tested } : {}),
      ...(opts.related !== undefined ? { related: opts.related } : {}),
      ...(opts.as !== undefined ? { as: opts.as } : {}),
      ...(opts.tool !== undefined ? { tool: opts.tool } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.sessionRef !== undefined ? { sessionRef: opts.sessionRef } : {}),
    };
    const result = await runAnnotate(target, annotateOptions);
    process.stdout.write(
      opts.json === true
        ? `${JSON.stringify({ sha: result.sha, changeId: result.changeId, entry: result.entry, entryCount: result.entryCount }, null, 2)}\n`
        : `${result.output}\n`,
    );
  });

program
  .command("internal-hook", { hidden: true })
  .description("Internal, git-hook-invoked: identity upkeep (commit-msg, post-commit, post-rewrite)")
  .argument("<name>", "hook name: commit-msg | post-commit | post-rewrite")
  .argument("[args...]", "hook arguments forwarded by the hook script")
  .action(async (name: string, args: string[]) => {
    // Same hard rule as capture-session (ARCHITECTURE.md §10.2): a hook must never break
    // the user's git operation — always exit 0, log failures instead of surfacing them.
    try {
      const stdin = name === "post-rewrite" ? await readStdin() : "";
      await runInternalHook(name, { args, stdin });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logHookFailure(`${name}: ${message}`);
    }
    process.exitCode = 0;
  });

program
  .command("report")
  .description("Generate a human-readable digest of agent activity (HTML or Markdown)")
  .option("--repo <path>", "repository to report on (default: current directory)")
  .option("--since <date>", "only commits after this date")
  .option("--until <date>", "only commits before this date")
  .option("-n, --max-count <N>", "limit to the N most recent commits", (v) => Number.parseInt(v, 10))
  .option("--rev <rev>", "walk this revision instead of HEAD (branch, tag, or SHA)")
  .option("--md", "Markdown to stdout instead of HTML")
  .option("--out <path>", "write to this file (default: .git-for-ai/report.html for HTML)")
  .action(async (opts) => {
    const format: "md" | "html" = opts.md === true ? "md" : "html";
    // HTML defaults to a file (a browser page is the point); Markdown defaults to stdout.
    const out = opts.out ?? (format === "html" ? ".git-for-ai/report.html" : undefined);
    const reportOptions: ReportOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
      ...(opts.maxCount !== undefined ? { maxCount: opts.maxCount } : {}),
      ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
      format,
      ...(out !== undefined ? { out } : {}),
    };
    const result = await runReport(reportOptions);
    if (result.path !== undefined) {
      process.stdout.write(`✓ report written to ${result.path}\n`);
    } else {
      process.stdout.write(`${result.output}\n`);
    }
  });

program
  .command("review")
  .description("Open the local review web app (read-only, serves on 127.0.0.1 only)")
  .option("--repo <path>", "repository to review (default: current directory)")
  .option("--port <n>", "pin the port (default: a random free port)", (v) => Number.parseInt(v, 10))
  .option("--no-open", "do not open the browser automatically")
  .action(async (opts) => {
    const reviewOptions: ReviewOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      open: opts.open,
    };
    const result = await runReview(reviewOptions);
    process.stdout.write(
      `review UI serving at ${result.url} (127.0.0.1 only — Ctrl+C to stop)\n`,
    );
    if (opts.open !== false && !result.opened) {
      process.stdout.write("could not launch a browser — open the URL above manually\n");
    }
    // The listening server keeps the process alive until Ctrl+C.
  });

program
  .command("reindex")
  .description("Rebuild the local vector index from git-native truth (code + ledger + sessions)")
  .option("--repo <path>", "repository to index (default: current directory)")
  .option("--full", "drop and re-embed everything (required after a model_fingerprint change)")
  .option("--since <commit>", "incremental base override (instead of state.json's last_indexed_commit)")
  .option("--verify", "check the index against state.json without rebuilding")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const reindexOptions: ReindexOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.full === true ? { full: true } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.verify === true ? { verify: true } : {}),
      // Real-model embedding takes real time; stream batch progress to stderr so the
      // user can see the index advancing (stdout stays the clean transcript/JSON).
      onProgress: (line: string) => process.stderr.write(`[reindex] ${line}\n`),
    };
    // Silent-death guard: a native failure inside the embedding backend (seen live:
    // onnxruntime "bad allocation" under memory pressure) can strand the inference
    // promise — it never settles, the event loop drains, and Node exits 0 mid-run with
    // no error and no state.json update. `beforeExit` fires exactly then; turn that
    // silence into an honest failure. Progress up to the last batch is cached, so a
    // re-run resumes cheaply.
    let settled = false;
    process.once("beforeExit", () => {
      if (!settled) {
        process.stderr.write(
          "git-for-ai: reindex terminated before completion — the embedding backend " +
            "stopped responding (likely out-of-memory in the native runtime; close other " +
            "heavy processes). Embedded batches are cached; re-run `git for-ai reindex` " +
            "to resume from where it stopped.\n",
        );
        process.exitCode = 1;
      }
    });
    const result = await runReindex(reindexOptions);
    settled = true;
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.output}\n`,
    );
    if (result.data.verify !== undefined && !result.data.verify.current) {
      process.exitCode = 3; // environment problem, doctor-detectable (CLI_REFERENCE exit codes)
    }
  });

program
  .command("ask")
  .description("Ask a question over the repo's captured intent (local hybrid retrieval + optional synthesis)")
  .argument("<question>", "free-form question about this repository's changes")
  .option("--repo <path>", "repository to query (default: current directory)")
  .option("--k <N>", "retrieval breadth (default 8)", (v) => Number.parseInt(v, 10))
  .option("--sources-only", "skip synthesis, just show the ranked retrieval hits")
  .option("--since <date>", "only sources recorded after this date")
  .option("--until <date>", "only sources recorded before this date")
  .option("--json", "machine-readable output")
  .action(async (question: string, opts) => {
    const askOptions: AskCliOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.k !== undefined ? { k: opts.k } : {}),
      ...(opts.sourcesOnly === true ? { sourcesOnly: true } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
    };
    const result = await runAsk(question, askOptions);
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.output}\n`,
    );
    process.exitCode = result.exitCode;
  });

program
  .command("blame")
  .description("Explain why a line looks the way it does: blame → change → recorded intent")
  .argument("<file:line>", "position to explain, e.g. src/auth/session.ts:73")
  .option("--why", "synthesize the why-answer (implied; accepted for CLI_REFERENCE parity)")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option("--depth <N>", "cap the LATER TOUCHED BY chain at N changes", (v) => Number.parseInt(v, 10))
  .option("--session", "include a session trace excerpt")
  .option("--explain", "opt into a synthesized prose explanation (Anthropic API; set GIT_FOR_AI_ANTHROPIC_KEY)")
  .option("--k <N>", "supplementary retrieval breadth (default 8; needs an index)", (v) => Number.parseInt(v, 10))
  .option("--json", "machine-readable output")
  .action(async (target: string, opts) => {
    const blameOptions: BlameCliOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      ...(opts.session === true ? { session: true } : {}),
      ...(opts.explain === true ? { explain: true } : {}),
      ...(opts.k !== undefined ? { k: opts.k } : {}),
    };
    const result = await runBlame(target, blameOptions);
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.output}\n`,
    );
    process.exitCode = result.exitCode;
  });

program
  .command("export")
  .description("Export ledger entries: Agent Trace wire format, or a PR-comment markdown")
  .argument("[target]", "commit-ish or c/<change-id> (pr-comment default: HEAD; agent-trace: narrow to one change)")
  .option("--format <format>", "agent-trace | pr-comment", "agent-trace")
  .option("--out <path>", "write the output to this file instead of stdout")
  .option("--repo <path>", "repository to export from (default: current directory)")
  .action(async (target: string | undefined, opts) => {
    const exportOptions: ExportOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      format: opts.format,
      ...(target !== undefined ? { target } : {}),
      ...(opts.out !== undefined ? { out: opts.out } : {}),
    };
    const result = await runExport(exportOptions);
    for (const warning of result.warnings) {
      process.stderr.write(`git-for-ai: warning: ${warning}\n`);
    }
    if (result.path !== undefined) {
      process.stdout.write(`✓ exported to ${result.path}\n`);
    } else {
      process.stdout.write(`${result.output}\n`);
    }
    process.exitCode = result.exitCode;
  });

program
  .command("doctor")
  .description("Read-only health audit: hooks, refspecs, index, identity, ledger, captures")
  .option("--repo <path>", "repository to examine (default: current directory)")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const result = await runDoctor({
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
    });
    process.stdout.write(
      opts.json === true ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.output}\n`,
    );
    process.exitCode = result.data.exitCode;
  });

program
  .command("sync")
  .description("Explicitly push/fetch the intent refs to/from a git remote (never automatic)")
  .argument("[remote]", "remote to sync with", "origin")
  .option("--push", "push only")
  .option("--fetch", "fetch only (default: fetch then push)")
  .option("--dry-run", "report what would happen without moving any data")
  .option("--yes", "skip the pre-push confirmation (required off-TTY)")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option("--json", "machine-readable output")
  .action(async (remote: string, opts) => {
    const syncOptions: SyncOptions = {
      remote,
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.push === true ? { push: true } : {}),
      ...(opts.fetch === true ? { fetch: true } : {}),
      ...(opts.dryRun === true ? { dryRun: true } : {}),
      ...(opts.yes === true ? { yes: true } : {}),
      // The pre-push privacy gate is only offered interactively; anywhere else the
      // explicit --yes flag is required (ARCHITECTURE.md §12.1 — a conscious choice).
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true
        ? {
            confirm: async (message: string): Promise<boolean> => {
              const readline = await import("node:readline/promises");
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                const answer = await rl.question(`${message}\nContinue? [y/N] `);
                return /^y(es)?$/i.test(answer.trim());
              } finally {
                rl.close();
              }
            },
          }
        : {}),
    };
    const result = await runSync(syncOptions);
    process.stdout.write(
      opts.json === true
        ? `${JSON.stringify(
            {
              remote: result.remote,
              mode: result.mode,
              dryRun: result.dryRun,
              fetched: result.fetched,
              pushed: result.pushed,
              pushAborted: result.pushAborted,
              warnings: result.warnings,
              exitCode: result.exitCode,
            },
            null,
            2,
          )}\n`
        : `${result.output}\n`,
    );
    process.exitCode = result.exitCode;
  });

program
  .command("mcp")
  .description("Serve the intent layer as MCP tools over stdio (ask, blame_why, show, log_intent, annotate, doctor)")
  .option("--repo <path>", "repository to serve (default: current directory)")
  .action(async (opts) => {
    // stdout is the MCP protocol channel — print nothing here. The connected
    // transport keeps the process alive until the client closes stdin.
    await runMcpServer({
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
    });
  });

program
  .command("config")
  .description("Read/write .git-for-ai/config.toml (get <key> | set <key> <value>)")
  .argument("<action>", "get | set")
  .argument("<key>", "dotted key, e.g. embedder.provider or capture.enabled")
  .argument("[value]", "value to set (set only)")
  .option("--repo <path>", "repository to operate on (default: current directory)")
  .option(
    "--accept-consent",
    "grant the API-embedder consent non-interactively (required off-TTY for e.g. voyage-code-3)",
  )
  .option("--json", "machine-readable output")
  .action(async (action: string, key: string, value: string | undefined, opts) => {
    const configOptions: ConfigOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.acceptConsent === true ? { acceptConsent: true } : {}),
      // The consent prompt is only offered on a real interactive terminal; anywhere
      // else (hooks, CI, pipes) the explicit --accept-consent flag is required.
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true
        ? {
            promptConsent: async (prompt: string): Promise<string> => {
              const readline = await import("node:readline/promises");
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                return await rl.question(prompt);
              } finally {
                rl.close();
              }
            },
          }
        : {}),
    };
    if (action === "get") {
      if (value !== undefined) {
        throw new Error("config get takes no value — did you mean `config set`?");
      }
      const result = await runConfigGet(key, configOptions);
      process.stdout.write(
        opts.json === true ? `${JSON.stringify({ key: result.key, value: result.value }, null, 2)}\n` : `${result.output}\n`,
      );
    } else if (action === "set") {
      if (value === undefined) {
        throw new Error("config set requires a value: git for-ai config set <key> <value>");
      }
      const result = await runConfigSet(key, value, configOptions);
      process.stdout.write(
        opts.json === true
          ? `${JSON.stringify({ key: result.key, value: result.value, consentRecorded: result.consentRecorded }, null, 2)}\n`
          : `${result.output}\n`,
      );
    } else {
      throw new Error(`unknown config action '${action}' — expected get or set`);
    }
  });

program
  .command("show")
  .description("Dump the ledger entry (and session, if any) for a commit or c/<change-id>")
  .argument("<target>", "commit-ish (SHA, HEAD, branch) or c/<change-id>")
  .option("--repo <path>", "repository to read (default: current directory)")
  .option("--session", "include the full session span trace in the output")
  .option("--history", "include superseded (appended-over) ledger entries")
  .option("--json", "machine-readable output")
  .action(async (target: string, opts) => {
    const showOptions: ShowOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.session === true ? { session: true } : {}),
      ...(opts.history === true ? { history: true } : {}),
      ...(opts.json === true ? { json: true } : {}),
    };
    const result = await runShow(target, showOptions);
    process.stdout.write(`${result.output}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`git-for-ai: ${message}\n`);
  process.exitCode = 1;
});

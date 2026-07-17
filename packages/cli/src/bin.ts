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
  .command("show")
  .description("Dump the ledger entry (and session, if any) for a commit or c/<change-id>")
  .argument("<target>", "commit-ish (SHA, HEAD, branch) or c/<change-id>")
  .option("--repo <path>", "repository to read (default: current directory)")
  .option("--session", "include the full session span trace in the output")
  .option("--json", "machine-readable output")
  .action(async (target: string, opts) => {
    const showOptions: ShowOptions = {
      ...(opts.repo !== undefined ? { cwd: opts.repo } : {}),
      ...(opts.session === true ? { session: true } : {}),
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

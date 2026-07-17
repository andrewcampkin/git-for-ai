// The one low-level entry point to git. Every other function in this package builds on
// `runGit`, which shells out to the user's real installed `git` binary via execa —
// never an in-process git library. See architecture/ARCHITECTURE.md §4.1.

import { execa, type Options as ExecaOptions } from "execa";

/** Options accepted by {@link runGit} and threaded through every higher-level helper. */
export interface RunGitOptions {
  /** Working directory to run git in. Defaults to the current process cwd. */
  cwd?: string;
  /** Data to feed to git's stdin (e.g. for `hash-object --stdin`, `notes append -F -`). */
  input?: string | Uint8Array;
  /** Extra environment variables, merged over the inherited process env. */
  env?: Record<string, string>;
  /**
   * If true, a non-zero git exit code resolves normally (inspect `exitCode` yourself)
   * instead of throwing {@link GitError}. Default false.
   */
  allowFailure?: boolean;
  /**
   * Strip the single trailing newline git appends to most output. Default true.
   * Set to false when byte-exact output matters (e.g. `cat-file blob`, `notes show`).
   */
  stripFinalNewline?: boolean;
}

/** Result of one git invocation. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Thrown when git exits non-zero (unless `allowFailure`) or cannot be spawned at all. */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    args: readonly string[];
    exitCode: number | undefined;
    stdout: string;
    stderr: string;
    cause?: unknown;
  }) {
    const summary = params.stderr.trim() || params.stdout.trim() || "(no output)";
    super(
      `git ${params.args.join(" ")} failed` +
        (params.exitCode === undefined ? "" : ` (exit code ${params.exitCode})`) +
        `: ${summary}`,
      params.cause === undefined ? undefined : { cause: params.cause },
    );
    this.name = "GitError";
    this.args = params.args;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

/**
 * Run `git <args>` as a subprocess and return its output.
 *
 * Arguments are passed as an array (no shell), so there is no quoting hazard.
 * `GIT_TERMINAL_PROMPT=0` is always set so git can never hang waiting for interactive
 * input, and `LC_ALL=C` keeps git's diagnostic messages in English so the few places
 * that inspect stderr (e.g. {@link import("./notes.js").notesShow}) are locale-proof.
 * Neither affects git *behavior* — config, hooks, credential helpers and merge
 * strategies all remain whatever the user has installed and configured.
 */
export async function runGit(args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const execaOptions: ExecaOptions = {
    reject: false,
    stripFinalNewline: opts.stripFinalNewline ?? true,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...opts.env,
    },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  };

  let result;
  try {
    result = await execa("git", args, execaOptions);
  } catch (cause) {
    // With reject:false this should not normally throw, but guard against it anyway
    // (e.g. an execa-internal error unrelated to the subprocess's own exit code).
    throw new GitError({ args, exitCode: undefined, stdout: "", stderr: String(cause), cause });
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";

  if (result.exitCode === undefined) {
    // Spawn-level failure (e.g. `git` not found on PATH, or killed by a signal) —
    // reported on the result object rather than thrown, since we passed reject:false.
    throw new GitError({
      args,
      exitCode: undefined,
      stdout,
      stderr: stderr || result.message || "git process did not exit normally",
      cause: result,
    });
  }

  if (result.exitCode !== 0 && !opts.allowFailure) {
    throw new GitError({ args, exitCode: result.exitCode, stdout, stderr });
  }

  return { stdout, stderr, exitCode: result.exitCode };
}

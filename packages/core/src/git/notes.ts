// git notes access: the substrate for the semantic commit ledger (refs/notes/git-for-ai/intent).
// notesMerge shells out to the user's real `git notes merge`, respecting whatever notes
// merge strategy they have configured — see architecture/ARCHITECTURE.md §12.2. We never
// reimplement notes-merge logic ourselves, per the same "always shell out" principle as §4.1.

import { runGit, type RunGitOptions } from "./run.js";

/**
 * Read the note body attached to `sha` under notes ref `ref`, or `null` if there is none.
 * Git normalizes note content to always end in exactly one trailing newline (the same
 * convention as commit messages); that trailing newline is stripped here so the returned
 * string round-trips against whatever body was originally passed to {@link notesAppend}.
 */
export async function notesShow(ref: string, sha: string, opts?: RunGitOptions): Promise<string | null> {
  const result = await runGit(["notes", `--ref=${ref}`, "show", sha], {
    ...opts,
    allowFailure: true,
    stripFinalNewline: false,
  });
  if (result.exitCode === 0) {
    return result.stdout.replace(/\n+$/, "");
  }
  if (/no note found for object/i.test(result.stderr)) {
    return null;
  }
  throw new Error(`git notes show failed unexpectedly (exit ${result.exitCode}): ${result.stderr}`);
}

/**
 * Append `body` as a new paragraph to the note attached to `sha` under notes ref `ref`,
 * creating the note if none exists yet. This is a thin wrapper over
 * `git notes --ref=<ref> append -F - <sha>` (message piped via stdin so arbitrary content —
 * including embedded newlines and the JSON payloads the ledger layer writes — round-trips
 * exactly, with no shell-escaping hazard). Higher layers (the ledger module) are responsible for
 * the append-only-JSON-array structure; this function only knows how to append raw text.
 */
export async function notesAppend(ref: string, sha: string, body: string, opts?: RunGitOptions): Promise<void> {
  await runGit(["notes", `--ref=${ref}`, "append", "--allow-empty", "-F", "-", sha], {
    ...opts,
    input: body,
  });
}

/** Strategies accepted by `git notes merge -s <strategy>`. */
export type NotesMergeStrategy = "manual" | "ours" | "theirs" | "union" | "cat_sort_uniq";

export interface NotesMergeOptions extends RunGitOptions {
  /**
   * Merge strategy to pass via `-s`. Omit to use whatever the user has configured via
   * `notes.<ref>.mergeStrategy` / `notes.mergeStrategy` (architecture/ARCHITECTURE.md §12.2
   * calls for `cat_sort_uniq` on the ledger ref, but that is configured once by `git for-ai
   * init` via `git config`, not hardcoded per call here — this function just invokes
   * whatever the repo is configured to do, unless the caller explicitly overrides it).
   */
  strategy?: NotesMergeStrategy;
  /** Abort an in-progress notes merge (`git notes merge --abort`) instead of starting one. */
  abort?: boolean;
  /** Commit a previously-conflicted notes merge (`git notes merge --commit`) instead of starting one. */
  commit?: boolean;
}

/**
 * Merge notes from `sourceRef` into the notes ref `targetRef`, i.e.
 * `git notes --ref=<targetRef> merge [-s <strategy>] <sourceRef>`. This literally invokes the
 * user's real `git notes merge` — we do not reimplement any merge/union logic ourselves.
 */
export async function notesMerge(
  targetRef: string,
  sourceRef: string,
  opts: NotesMergeOptions = {},
): Promise<string> {
  const { strategy, abort, commit, ...runOpts } = opts;
  const args = ["notes", `--ref=${targetRef}`, "merge"];
  if (abort) {
    args.push("--abort");
  } else if (commit) {
    args.push("--commit");
  } else {
    if (strategy !== undefined) {
      args.push("-s", strategy);
    }
    args.push(sourceRef);
  }
  const result = await runGit(args, runOpts);
  return result.stdout;
}

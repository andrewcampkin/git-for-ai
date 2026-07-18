// `git-for-ai internal-hook <name>` — the dispatch target for the three git hooks that
// `git for-ai init` installs (see init.ts judgment call #1, where this command's shape was
// fixed before it existed). This closes the gap HANDOFF.md documented: until this module,
// real commits got no Change-Id trailer and no automatic change-map entry.
//
// Dispatch (per ARCHITECTURE.md §7.2/§7.4 and HANDOFF.md known-issue #1):
//
//   commit-msg <msgfile>   Inject a `Change-Id: I<32hex>` trailer into the commit message
//                          file BEFORE the SHA is finalized (§7.2 — a message-file rewrite,
//                          never a post-hoc amend). No-op if a trailer is already present
//                          (Gerrit coexistence, §7.6) or the message is effectively empty.
//   post-commit            `assignChangeId(HEAD)` — record the commit into the change-map.
//                          The commit-msg hook already put the trailer in the message, so
//                          this adopts that id rather than minting a second one.
//   post-rewrite <kind>    Parse `<old-sha> <new-sha>` pairs from stdin and fold the
//                          change-map via `onPostRewrite` (§7.4).
//
// Contract: like capture-session, a hook must NEVER break the user's git operation
// (ARCHITECTURE.md §10.2/§14). This module's `runInternalHook` throws on real failures so
// tests can observe them; the always-exit-0 swallowing lives in bin.ts (which logs failures
// via `logHookFailure` below — to `.git-for-ai/hooks.log` when the repo is resolvable,
// else a single stderr line). The hook script's `|| true` is the last-resort backstop.
//
// ── Judgment calls the docs left open ──
//
// 1. Trailer injection mechanism: `git interpret-trailers --in-place` (the tool git's own
//    docs recommend for commit-msg hooks, and what modern Gerrit hooks use). Verified on
//    git 2.45: it places the trailer at the end of the real message, before the comment
//    block and any `commit -v` scissors section — hand-rolled placement would have to
//    re-derive exactly that logic.
//
// 2. Empty-message guard. If the effective message (comments and scissors section
//    stripped) is empty, git aborts the commit AFTER commit-msg runs. Injecting a trailer
//    into an empty message would make it non-empty and turn an aborted commit into a real
//    commit whose entire message is the trailer — so empty messages are left untouched.
//    Comment char comes from `core.commentChar` (default `#`; the `auto` setting falls
//    back to `#`, which is what git itself picks unless a message actually uses it).
//
// 3. fixup!/squash! messages get a trailer like any other commit: the fixup commit gets
//    its own identity, and the eventual autosquash folds it via post-rewrite (§7.4) —
//    exactly the flow onPostRewrite models. Skipping them (as some Gerrit setups do) would
//    leave the pre-squash commits orphaned in the interim.

import { readFile } from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  assignChangeId,
  formatChangeIdTrailer,
  mintChangeId,
  onPostRewrite,
  parseChangeIdTrailer,
  parsePostRewriteInput,
  revParse,
  runGit,
  type GitContext,
} from "@git-for-ai/core";
import type { ChangeId } from "@git-for-ai/schemas";

// ─── Public types ────────────────────────────────────────────────────────────

export const INTERNAL_HOOK_NAMES = ["commit-msg", "post-commit", "post-rewrite"] as const;
export type InternalHookName = (typeof INTERNAL_HOOK_NAMES)[number];

export interface InternalHookOptions {
  /** Repository the hook fired in. Default: `process.cwd()` (git runs hooks at the toplevel). */
  cwd?: string;
  /** Positional hook arguments (`"$@"` from the hook script). commit-msg: [msgfile]; post-rewrite: [kind]. */
  args?: string[];
  /** Raw stdin content (post-rewrite receives its old/new SHA pairs here). */
  stdin?: string;
}

export interface CommitMsgResult {
  hook: "commit-msg";
  /**
   * injected         — trailer written into the message file
   * already-present  — message already carried a Change-Id (ours or Gerrit's, §7.6)
   * empty-message    — effective message empty; left untouched so git still aborts
   */
  action: "injected" | "already-present" | "empty-message";
  /** The id now in the message (null only for empty-message). */
  changeId: ChangeId | null;
}

export interface PostCommitResult {
  hook: "post-commit";
  action: "assigned";
  changeId: ChangeId;
  /** True when the commit-msg hook (or Gerrit) had already put the id in the message. */
  adoptedFromTrailer: boolean;
}

export interface PostRewriteResult {
  hook: "post-rewrite";
  action: "applied" | "no-pairs";
  rekeyed: number;
  folded: number;
  unknownOldShas: number;
}

export type InternalHookResult = CommitMsgResult | PostCommitResult | PostRewriteResult;

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runInternalHook(
  name: string,
  options: InternalHookOptions = {},
): Promise<InternalHookResult> {
  const cwd = options.cwd ?? process.cwd();
  const args = options.args ?? [];
  const ctx: GitContext = { cwd };

  switch (name as InternalHookName) {
    case "commit-msg": {
      const msgFile = args[0];
      if (msgFile === undefined) {
        throw new Error("commit-msg hook invoked without a message file argument");
      }
      return runCommitMsg(msgFile, cwd);
    }
    case "post-commit": {
      const head = await revParse("HEAD", ctx);
      const { changeId, adoptedFromTrailer } = await assignChangeId(head, ctx);
      return { hook: "post-commit", action: "assigned", changeId, adoptedFromTrailer };
    }
    case "post-rewrite": {
      const pairs = parsePostRewriteInput(options.stdin ?? "");
      if (pairs.length === 0) {
        return { hook: "post-rewrite", action: "no-pairs", rekeyed: 0, folded: 0, unknownOldShas: 0 };
      }
      const result = await onPostRewrite(pairs, ctx);
      return {
        hook: "post-rewrite",
        action: "applied",
        rekeyed: result.rekeyed.length,
        folded: result.folded.length,
        unknownOldShas: result.unknownOldShas.length,
      };
    }
    default:
      throw new Error(
        `unknown hook "${name}" — expected one of: ${INTERNAL_HOOK_NAMES.join(", ")}`,
      );
  }
}

// ─── commit-msg ──────────────────────────────────────────────────────────────

async function runCommitMsg(msgFile: string, cwd: string): Promise<CommitMsgResult> {
  const raw = await readFile(msgFile, "utf8");
  const commentChar = await resolveCommentChar(cwd);
  const effective = stripCommentsAndScissors(raw, commentChar);

  if (effective.trim() === "") {
    return { hook: "commit-msg", action: "empty-message", changeId: null };
  }

  const existing = parseChangeIdTrailer(effective);
  if (existing !== null) {
    return { hook: "commit-msg", action: "already-present", changeId: existing };
  }

  const changeId = mintChangeId();
  await runGit(
    ["interpret-trailers", "--in-place", "--trailer", formatChangeIdTrailer(changeId), msgFile],
    { cwd },
  );
  return { hook: "commit-msg", action: "injected", changeId };
}

async function resolveCommentChar(cwd: string): Promise<string> {
  const result = await runGit(["config", "--get", "core.commentChar"], {
    cwd,
    allowFailure: true, // exit 1 = unset
  });
  const value = result.exitCode === 0 ? result.stdout.trim() : "";
  // Judgment call #2: `auto` (and anything not a single char) falls back to `#`.
  return value.length === 1 ? value : "#";
}

/**
 * Reduce a commit message file to its effective message: drop everything from a scissors
 * line onward (`git commit -v` / `commit.cleanup=scissors`), then drop comment lines —
 * mirroring what git's own cleanup will keep.
 */
export function stripCommentsAndScissors(raw: string, commentChar: string): string {
  const scissors = `${commentChar} ------------------------ >8 ------------------------`;
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === scissors) {
      break;
    }
    if (!line.startsWith(commentChar)) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

// ─── Failure logging (used by bin.ts's always-exit-0 wrapper) ────────────────

/**
 * Record a hook failure without breaking the git operation: append one line to
 * `<repo>/.git-for-ai/hooks.log` when the repo is resolvable, else write a single line to
 * stderr. Never throws.
 */
export async function logHookFailure(message: string, cwd = process.cwd()): Promise<void> {
  const line = `${new Date().toISOString()} internal-hook: ${message}\n`;
  try {
    const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
    if (toplevel.exitCode === 0) {
      const dir = join(toplevel.stdout.trim(), ".git-for-ai");
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "hooks.log"), line, "utf8");
      return;
    }
  } catch {
    // fall through to stderr
  }
  try {
    process.stderr.write(`git-for-ai ${line}`);
  } catch {
    // a hook must never fail because logging failed
  }
}

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
//
// 4. `git merge --squash` fold (DESKTOP.md G1, added 2026-07-19). post-rewrite never fires
//    for merge --squash, so without help the squash commit mints an UNLINKED fresh change
//    while the source branch's changes end up on commits that become unreachable when the
//    branch is deleted (verified empirically — GC would leave dangling notes). The fix is
//    two-phase because <git-dir>/SQUASH_MSG exists at commit-msg time but is deleted
//    before post-commit (also verified):
//      commit-msg  — if SQUASH_MSG exists and lists a commit belonging to a known change,
//                    inject THAT change's id as the trailer (oldest squashed commit's
//                    change survives, matching onPostRewrite's first-known-wins rule) and
//                    write a pending-fold file into the git dir;
//      post-commit — consume the pending file (always deleted once seen) and, only when
//                    the committed trailer matches the recorded survivor id (a commit
//                    aborted between hooks would not), fold all squashed changes into the
//                    survivor via the ordinary onPostRewrite machinery.
//    A pre-existing trailer in the squash message wins and skips the fold entirely —
//    respecting an explicit id beats guessing, and the split-identity alternative (fold
//    absorbing into a change that isn't the committed trailer's) would be worse. The
//    squashed commits' own trailers inside SQUASH_MSG never interfere: git indents quoted
//    messages, and the trailer regex only matches at line start.

import { readFile, unlink, writeFile } from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  assignChangeId,
  findEntryByCommitSha,
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
  /**
   * Present when this commit is a `git merge --squash` (SQUASH_MSG detected) whose
   * squashed commits include a known change: the injected id IS that surviving change's
   * id, and a pending-fold file has been written for post-commit to complete (see the
   * squash-merge section of the header comment).
   */
  squash?: { survivorChangeId: ChangeId; squashedCount: number };
}

export interface PostCommitResult {
  hook: "post-commit";
  action: "assigned";
  changeId: ChangeId;
  /** True when the commit-msg hook (or Gerrit) had already put the id in the message. */
  adoptedFromTrailer: boolean;
  /**
   * Present when a pending squash-merge fold was completed: the other squashed changes
   * were absorbed into the surviving change (ARCHITECTURE §7.4 fold semantics, extended
   * to `merge --squash` which post-rewrite never observes).
   */
  squashFold?: { survivorChangeId: ChangeId; absorbed: number; unknownOldShas: number };
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
      const squashFold = await completePendingSquashFold(head, changeId, cwd, ctx);
      return {
        hook: "post-commit",
        action: "assigned",
        changeId,
        adoptedFromTrailer,
        ...(squashFold !== null ? { squashFold } : {}),
      };
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
    // A pre-existing trailer (Gerrit's, or user-pasted) always wins — including for a
    // squash-merge, where we then skip the fold rather than risk splitting the squash
    // commit's identity across two changes (documented judgment call in the header).
    return { hook: "commit-msg", action: "already-present", changeId: existing };
  }

  // Squash-merge detection (DESKTOP.md G1): during the `git merge --squash` commit,
  // <git-dir>/SQUASH_MSG exists (verified: present at commit-msg time, deleted before
  // post-commit). If any squashed commit belongs to a known change, inject THAT change's
  // id as the trailer — the squash commit then continues the surviving change exactly
  // like a rebase-squash — and leave a pending-fold file for post-commit to absorb the
  // other squashed changes.
  const squash = await detectSquashMerge(cwd, { cwd });
  if (squash !== null) {
    await runGit(
      [
        "interpret-trailers",
        "--in-place",
        "--trailer",
        formatChangeIdTrailer(squash.survivorChangeId),
        msgFile,
      ],
      { cwd },
    );
    await writePendingSquashFold(cwd, squash.survivorChangeId, squash.oldShas);
    return {
      hook: "commit-msg",
      action: "injected",
      changeId: squash.survivorChangeId,
      squash: { survivorChangeId: squash.survivorChangeId, squashedCount: squash.oldShas.length },
    };
  }

  const changeId = mintChangeId();
  await runGit(
    ["interpret-trailers", "--in-place", "--trailer", formatChangeIdTrailer(changeId), msgFile],
    { cwd },
  );
  return { hook: "commit-msg", action: "injected", changeId };
}

// ─── Squash-merge fold (DESKTOP.md G1) ───────────────────────────────────────

/** The pending-fold handoff file, in the git dir (transient, per-worktree). */
const SQUASH_PENDING_FILENAME = "git-for-ai-squash-pending.json";

interface PendingSquashFold {
  /** The surviving change's id — must match the committed trailer or the file is stale. */
  changeId: ChangeId;
  /** Squashed commit SHAs, oldest first (survivor's old head first). */
  oldShas: string[];
}

async function resolveGitDir(cwd: string, ctx: GitContext): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-dir"], ctx)).stdout.trim();
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/**
 * Detect an in-progress `merge --squash` commit and pick the surviving change: parse
 * SQUASH_MSG's `commit <sha>` lines (newest first — reversed to oldest first, so the
 * branch's FIRST change survives, mirroring onPostRewrite's first-known-wins rule), and
 * return the first squashed commit that belongs to a known change. Null when this is not
 * a squash commit or none of the squashed commits has identity (nothing to fold).
 */
async function detectSquashMerge(
  cwd: string,
  ctx: GitContext,
): Promise<{ survivorChangeId: ChangeId; oldShas: string[] } | null> {
  const gitDir = await resolveGitDir(cwd, ctx);
  const squashMsgPath = join(gitDir, "SQUASH_MSG");
  if (!existsSync(squashMsgPath)) {
    return null;
  }
  const squashMsg = await readFile(squashMsgPath, "utf8");
  const oldShas: string[] = [];
  for (const match of squashMsg.matchAll(/^commit ([0-9a-f]{40})\s*$/gim)) {
    const sha = match[1];
    if (sha !== undefined && !oldShas.includes(sha)) {
      oldShas.push(sha);
    }
  }
  oldShas.reverse(); // SQUASH_MSG lists newest first; fold semantics want oldest first
  for (const sha of oldShas) {
    const entry = await findEntryByCommitSha(sha, ctx);
    if (entry !== null && entry.folded_into === undefined) {
      return { survivorChangeId: entry.change_id, oldShas };
    }
  }
  return null;
}

async function writePendingSquashFold(
  cwd: string,
  changeId: ChangeId,
  oldShas: string[],
): Promise<void> {
  const gitDir = await resolveGitDir(cwd, { cwd });
  const pending: PendingSquashFold = { changeId, oldShas };
  await writeFile(join(gitDir, SQUASH_PENDING_FILENAME), JSON.stringify(pending), "utf8");
}

/**
 * Post-commit half of the squash fold: consume the pending file (always deleted once
 * seen, whatever happens next) and — ONLY if the committed trailer matches the recorded
 * survivor id, which a commit aborted between the two hooks would not — fold every
 * squashed change into the survivor via the ordinary §7.4 machinery.
 */
async function completePendingSquashFold(
  headSha: string,
  assignedChangeId: ChangeId,
  cwd: string,
  ctx: GitContext,
): Promise<NonNullable<PostCommitResult["squashFold"]> | null> {
  const gitDir = await resolveGitDir(cwd, ctx);
  const pendingPath = join(gitDir, SQUASH_PENDING_FILENAME);
  if (!existsSync(pendingPath)) {
    return null;
  }
  let pending: PendingSquashFold | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PendingSquashFold).changeId === "string" &&
      Array.isArray((parsed as PendingSquashFold).oldShas)
    ) {
      pending = parsed as PendingSquashFold;
    }
  } catch {
    pending = null; // unreadable = stale; fall through to deletion
  }
  await unlink(pendingPath);

  if (pending === null || pending.changeId !== assignedChangeId) {
    // Stale handoff (the squash commit was aborted after commit-msg, and this is some
    // later unrelated commit): discard silently — deleting the file is the cleanup.
    return null;
  }

  const result = await onPostRewrite(
    pending.oldShas.map((oldSha) => ({ oldSha, newSha: headSha })),
    ctx,
  );
  const fold = result.folded[0];
  return {
    survivorChangeId: fold?.survivorChangeId ?? assignedChangeId,
    absorbed: fold?.absorbedChangeIds.length ?? 0,
    unknownOldShas: result.unknownOldShas.length,
  };
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

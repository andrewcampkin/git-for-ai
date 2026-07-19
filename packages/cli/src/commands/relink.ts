// `git for-ai relink` — the manual identity escape hatch (CLI_REFERENCE `relink`;
// ARCHITECTURE.md §7.4's split case; PLAN_2026-07-18.md D2 repair).
//
// Two forms:
//   relink <change-id> <commit>   Re-point a change's head to <commit> (append to
//                                 history if absent). The CLI_REFERENCE form.
//   relink --detach <commit>      Undo a misattribution: remove <commit> from whichever
//                                 change claims it, restore that change's head to its
//                                 newest remaining commit, rewrite the ledger-note
//                                 envelope on <commit> (if any) to the commit's NEW
//                                 identity, which is minted by running the normal
//                                 resolver afterwards (R5 orphan mint, or trailer
//                                 recovery when a trailer exists) — repair reuses the
//                                 §7.3 machinery rather than inventing a parallel path.
//
// ── Judgment calls ──
// 1. relink never changes `origin` on re-point (origin records how the entry was
//    CREATED); detach's fresh identity gets whatever origin the resolver gives it.
// 2. --detach rewrites the detached commit's note envelope change_id (and each entry's
//    change_id) in place. This is the one sanctioned mutation of ledger data: the
//    append-only rule (DATA_MODEL.md §2.4) protects entries from silent edits, but a
//    misattributed envelope is exactly what relink exists to repair, and the entries'
//    content is preserved byte-for-byte otherwise.
// 3. Detaching a change's ONLY commit is refused — that would leave an empty change; the
//    caller should annotate or rebuild instead.

import { LEDGER_NOTE_JSONL_SCHEMA, type ChangeMapEntry, type LedgerNote } from "@git-for-ai/schemas";
import {
  findEntryByCommitSha,
  readChangeMapEntry,
  readLedgerNote,
  resolveChangeId,
  runGit,
  serializeLedgerNote,
  upsertChangeMapEntries,
  INTENT_NOTES_REF,
  type GitContext,
} from "@git-for-ai/core";

export interface RelinkOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--detach` mode: the single argument is the commit to detach. */
  detach?: boolean;
}

export interface RelinkResult {
  mode: "repoint" | "detach";
  sha: string;
  /** repoint: the change re-pointed. detach: the change the commit was removed from. */
  changeId: string;
  /** detach only: the commit's fresh identity after re-resolution. */
  newChangeId?: string;
  /** detach only: the old change's restored head. */
  restoredHead?: string;
  /** detach only: whether a ledger-note envelope on the commit was rewritten. */
  noteRewritten?: boolean;
  output: string;
}

function toContext(options: RelinkOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

async function resolveCommitArg(arg: string, ctx: GitContext): Promise<string> {
  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${arg}^{commit}`], {
    ...ctx,
    allowFailure: true,
  });
  if (resolved.exitCode !== 0 || resolved.stdout.length === 0) {
    throw new Error(`cannot resolve '${arg}' to a commit`);
  }
  return resolved.stdout;
}

/** Rewrite the note envelope on `sha` to carry `newChangeId` (entries preserved). */
async function rewriteNoteChangeId(
  sha: string,
  newChangeId: string,
  ctx: GitContext,
): Promise<boolean> {
  const note = await readLedgerNote(sha, ctx); // throws LedgerNoteFormatError if unusable
  if (note === null) {
    return false;
  }
  const rewritten: LedgerNote = {
    ...note,
    schema: LEDGER_NOTE_JSONL_SCHEMA,
    change_id: newChangeId,
    entries: note.entries.map((entry) => ({ ...entry, change_id: newChangeId })),
  };
  // Every write path emits the JSONL wire format (PLAN_2026-07-18.md W3) — this rewrite
  // also opportunistically migrates a legacy-envelope note.
  await runGit(["notes", `--ref=${INTENT_NOTES_REF}`, "add", "-f", "-F", "-", sha], {
    ...ctx,
    input: serializeLedgerNote(rewritten),
  });
  return true;
}

export async function runRelink(
  args: string[],
  options: RelinkOptions = {},
): Promise<RelinkResult> {
  const ctx = toContext(options);
  await runGit(["rev-parse", "--git-dir"], ctx);

  if (options.detach === true) {
    const commitArg = args[0];
    if (commitArg === undefined || args.length !== 1) {
      throw new Error("usage: git for-ai relink --detach <commit>");
    }
    const sha = await resolveCommitArg(commitArg, ctx);

    const owner = await findEntryByCommitSha(sha, ctx);
    if (owner === null) {
      throw new Error(`commit ${sha} is not claimed by any change — nothing to detach`);
    }
    const remaining = owner.history.filter((h) => h !== sha);
    if (remaining.length === 0) {
      throw new Error(
        `commit ${sha} is the only commit of change c/${owner.change_id} — refusing to ` +
          `detach it (the change would be empty); use relink <change-id> <commit> instead`,
      );
    }
    const restoredHead = owner.head === sha ? remaining[remaining.length - 1]! : owner.head;
    const repaired: ChangeMapEntry = {
      ...owner,
      head: restoredHead,
      history: remaining,
      updated_at: new Date().toISOString(),
    };
    await upsertChangeMapEntries([repaired], {
      ...ctx,
      message: `git-for-ai: relink --detach ${sha} from ${owner.change_id}`,
    });

    // Fresh identity via the normal resolver (R5 mint, or trailer recovery), THEN point
    // the commit's note envelope (if any) at that identity.
    const fresh = await resolveChangeId(sha, ctx);
    const noteRewritten = await rewriteNoteChangeId(sha, fresh.changeId, ctx);

    const output =
      `✓ detached ${sha.slice(0, 7)} from c/${owner.change_id}\n` +
      `  c/${owner.change_id} head restored to ${restoredHead.slice(0, 7)}\n` +
      `  ${sha.slice(0, 7)} re-resolved as c/${fresh.changeId} (${fresh.entry.origin})` +
      (noteRewritten ? "\n  ledger note envelope rewritten to the new change-id" : "");
    return {
      mode: "detach",
      sha,
      changeId: owner.change_id,
      newChangeId: fresh.changeId,
      restoredHead,
      noteRewritten,
      output,
    };
  }

  const [changeArg, commitArg] = args;
  if (changeArg === undefined || commitArg === undefined || args.length !== 2) {
    throw new Error("usage: git for-ai relink <change-id> <commit>  (or --detach <commit>)");
  }
  const changeId = changeArg.replace(/^c\//i, "").toLowerCase();
  const entry = await readChangeMapEntry(changeId, ctx);
  if (entry === null) {
    throw new Error(`change c/${changeId} not found in the change-map`);
  }
  const sha = await resolveCommitArg(commitArg, ctx);

  const repointed: ChangeMapEntry = {
    ...entry,
    head: sha,
    history: entry.history.includes(sha) ? entry.history : [...entry.history, sha],
    updated_at: new Date().toISOString(),
  };
  await upsertChangeMapEntries([repointed], {
    ...ctx,
    message: `git-for-ai: relink ${changeId} -> ${sha}`,
  });

  return {
    mode: "repoint",
    sha,
    changeId,
    output: `✓ c/${changeId} re-pointed: head is now ${sha.slice(0, 7)}`,
  };
}

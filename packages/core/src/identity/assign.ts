// assignChangeId — the first-commit assignment logic from ARCHITECTURE.md §7.2.
//
//   on post-commit(new_sha):
//     msg = read_commit_message(new_sha)
//     if msg has Change-Id trailer T: cid = normalize(T)     # reuse existing (Gerrit or ours)
//     else:                           cid = random_32_hex()  # fresh opaque id (§7.7)
//     change_map.upsert(change_id=cid, head=new_sha, append_history=new_sha, origin="post-commit")
//
// (§7.2's `ledger.ensure_stub` step belongs to the ledger module and is not
// performed here.)

import type { ChangeId, ChangeMapEntry } from "@git-for-ai/schemas";

import { readCommitMessage } from "../git/index.js";
import { mintChangeId, parseChangeIdTrailer } from "./changeId.js";
import {
  readChangeMapEntry,
  upsertChangeMapEntries,
  type GitContext,
} from "./changeMap.js";

export interface AssignChangeIdResult {
  changeId: ChangeId;
  /** True when the id was adopted from an existing Change-Id trailer (ours or Gerrit's, §7.6). */
  adoptedFromTrailer: boolean;
  /** The change-map entry as written. */
  entry: ChangeMapEntry;
}

/**
 * Assign a change-id to a newly-created commit (the post-commit hook path, §7.2).
 *
 * If the commit message carries a `Change-Id` trailer, that id is adopted (normalized —
 * this is also what makes us a no-op for Gerrit users' identity, §7.6); otherwise a fresh
 * random id is minted. The change-map is then upserted: a brand-new row for a first
 * commit, or head/history advancement when the id already has a row (post-commit also
 * fires on `git commit --amend`, where the trailer rides along in the amended message).
 */
export async function assignChangeId(
  newSha: string,
  opts: GitContext = {},
): Promise<AssignChangeIdResult> {
  const message = await readCommitMessage(newSha, opts);
  const trailerChangeId = parseChangeIdTrailer(message);
  const changeId = trailerChangeId ?? mintChangeId();
  const now = new Date().toISOString();

  const existing = await readChangeMapEntry(changeId, opts);
  let entry: ChangeMapEntry;
  if (existing !== null) {
    entry = {
      ...existing,
      head: newSha,
      history: existing.history.includes(newSha)
        ? existing.history
        : [...existing.history, newSha],
      trailer_seen: existing.trailer_seen || trailerChangeId !== null,
      updated_at: now,
    };
  } else {
    entry = {
      schema: "git-for-ai/change-map-entry@1",
      change_id: changeId,
      head: newSha,
      history: [newSha],
      trailer_seen: trailerChangeId !== null,
      origin: "post-commit",
      updated_at: now,
    };
  }

  await upsertChangeMapEntries([entry], {
    ...opts,
    message: `git-for-ai: assign ${changeId} -> ${newSha} (post-commit)`,
  });

  return { changeId, adoptedFromTrailer: trailerChangeId !== null, entry };
}

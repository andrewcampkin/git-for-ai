// Milestone 11 — source enrichment: join retrieval hits back to their git-native
// records (change-map entry, effective ledger entry, session record) so M12 renders
// §9.1's outputs without re-fetching anything (CLI_PLAN.md M11 / plan requirement).
//
// ── Judgment calls ──
// 1. Enrichment is READ-ONLY. It never calls resolveChangeId (which self-heals by
//    WRITING map rows) — same discipline as `log`/`show` (see annotate.ts judgment #1:
//    only write commands mint identity). Blame identity below follows the read-only
//    R1/R2 analogues: map lookup by SHA, then trailer lookup, never minting.
// 2. Ledger entries for a change are gathered across [history..., head] exactly like
//    reindex's collectLedgerItems (a rewrite can leave the note attached to a
//    superseded SHA), deduped by canonical JSON, resolved to the effective entry.
// 3. Unreadable notes (LedgerNoteFormatError) degrade to a warning + null enrichment
//    rather than failing the whole query — a query command must not die on one bad
//    note; doctor (M14) owns auditing them.
// 4. Per-call memoization: one change's records are fetched once no matter how many
//    sources reference it (ask commonly returns the ledger chunk AND its session chunk).

import type {
  ChangeMapEntry,
  LedgerEntry,
  SessionRecord,
} from "@git-for-ai/schemas";

import { readCommitMessage } from "../git/index.js";
import {
  findEntryByCommitSha,
  readChangeMapEntry,
  type GitContext,
} from "../identity/changeMap.js";
import { parseChangeIdTrailer } from "../identity/changeId.js";
import {
  LedgerNoteFormatError,
  readLedgerEntries,
} from "../ledger/intentNotes.js";
import { canonicalJsonStringify, resolveEffectiveEntry } from "../ledger/effective.js";
import { readSessionRecord } from "../sessions/store.js";

import type { EnrichedSource, RankedSource } from "./types.js";

const short = (sha: string): string => sha.slice(0, 8);

/** A change's full ledger picture, as read from git. */
export interface ChangeLedger {
  /** Every entry, oldest first, deduped across the change's commit history. */
  entries: LedgerEntry[];
  /** The effective entry (newest by created_at with the documented tiebreak), or null. */
  effective: LedgerEntry | null;
}

/**
 * Follow `folded_into` redirects to the surviving change-map entry (cycle-safe).
 * Read-only sibling of the resolver's redirect handling.
 */
export async function followFoldedInto(
  entry: ChangeMapEntry,
  ctx: GitContext = {},
): Promise<ChangeMapEntry> {
  let current = entry;
  const seen = new Set<string>([entry.change_id]);
  while (current.folded_into !== undefined && !seen.has(current.folded_into)) {
    const next = await readChangeMapEntry(current.folded_into, ctx);
    if (next === null) {
      break;
    }
    seen.add(next.change_id);
    current = next;
  }
  return current;
}

/**
 * Read every ledger entry recorded for a change across its full commit history and
 * resolve the effective one. Unreadable notes are reported through `warnings`.
 */
export async function readChangeLedger(
  mapEntry: ChangeMapEntry,
  ctx: GitContext = {},
  warnings: string[] = [],
): Promise<ChangeLedger> {
  const shas = [...new Set([...mapEntry.history, mapEntry.head])];
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const sha of shas) {
    let read: LedgerEntry[] | null;
    try {
      read = await readLedgerEntries(sha, { ...ctx });
    } catch (error) {
      if (error instanceof LedgerNoteFormatError) {
        warnings.push(`ledger note on commit ${short(sha)} is unreadable: ${error.message}`);
        continue;
      }
      throw error;
    }
    for (const entry of read ?? []) {
      const canonical = canonicalJsonStringify(entry);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        entries.push(entry);
      }
    }
  }
  return { entries, effective: entries.length > 0 ? resolveEffectiveEntry(entries) : null };
}

/**
 * Read-only commit → change identity resolution (the R1/R2 read analogues; never
 * writes). Returns null when the commit has no discoverable identity — the honest
 * "no captured intent / pre-git-for-ai" signal.
 */
export async function resolveChangeIdReadOnly(
  sha: string,
  ctx: GitContext = {},
): Promise<{ changeId: string; entry: ChangeMapEntry | null; via: "map" | "trailer" } | null> {
  const direct = await findEntryByCommitSha(sha, ctx);
  if (direct !== null) {
    const resolved = await followFoldedInto(direct, ctx);
    return { changeId: resolved.change_id, entry: resolved, via: "map" };
  }
  const trailerId = parseChangeIdTrailer(await readCommitMessage(sha, ctx));
  if (trailerId !== null) {
    const mapped = await readChangeMapEntry(trailerId, ctx);
    const resolved = mapped !== null ? await followFoldedInto(mapped, ctx) : null;
    return {
      changeId: resolved?.change_id ?? trailerId,
      entry: resolved,
      via: "trailer",
    };
  }
  return null;
}

/**
 * Enrich ranked sources with their full git records. Memoized per change-id and per
 * session-ref within one call. Non-fatal read problems land in `warnings`.
 */
export async function enrichSources(
  sources: RankedSource[],
  ctx: GitContext = {},
  warnings: string[] = [],
): Promise<EnrichedSource[]> {
  const changeCache = new Map<
    string,
    { mapEntry: ChangeMapEntry | null; ledger: ChangeLedger }
  >();
  const sessionCache = new Map<string, SessionRecord | null>();

  const changeFor = async (
    changeId: string,
  ): Promise<{ mapEntry: ChangeMapEntry | null; ledger: ChangeLedger }> => {
    const cached = changeCache.get(changeId);
    if (cached !== undefined) {
      return cached;
    }
    const raw = await readChangeMapEntry(changeId, ctx);
    const mapEntry = raw !== null ? await followFoldedInto(raw, ctx) : null;
    const ledger: ChangeLedger =
      mapEntry !== null
        ? await readChangeLedger(mapEntry, ctx, warnings)
        : { entries: [], effective: null };
    const result = { mapEntry, ledger };
    changeCache.set(changeId, result);
    return result;
  };

  const sessionFor = async (sessionRef: string): Promise<SessionRecord | null> => {
    const cached = sessionCache.get(sessionRef);
    if (cached !== undefined) {
      return cached;
    }
    let record: SessionRecord | null = null;
    try {
      record = await readSessionRecord(sessionRef, ctx);
    } catch (error) {
      warnings.push(
        `session ${sessionRef} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sessionCache.set(sessionRef, record);
    return record;
  };

  const enriched: EnrichedSource[] = [];
  for (const source of sources) {
    let changeMapEntry: ChangeMapEntry | null = null;
    let ledgerEntry: LedgerEntry | null = null;
    let sessionRecord: SessionRecord | null = null;

    if (source.chunk.changeId !== null) {
      const { mapEntry, ledger } = await changeFor(source.chunk.changeId);
      changeMapEntry = mapEntry;
      ledgerEntry = ledger.effective;
    }
    const sessionRef =
      source.chunk.sessionRef ??
      (ledgerEntry?.session_ref !== undefined && ledgerEntry?.session_ref !== null
        ? ledgerEntry.session_ref
        : null);
    if (sessionRef !== null) {
      sessionRecord = await sessionFor(sessionRef);
    }

    enriched.push({ ...source, changeMapEntry, ledgerEntry, sessionRecord });
  }
  return enriched;
}

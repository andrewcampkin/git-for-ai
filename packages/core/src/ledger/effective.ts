// Effective-entry resolution — architecture/DATA_MODEL.md §2.4.
//
// A note's `entries` array is an append-only log; the "effective" entry (what a reader
// treats as THE intent for a change) is the one with the newest `created_at`.
// DATA_MODEL.md §2.4 pins the tiebreak *inputs* for equal timestamps —
// `(author.human, revision, sha256(entry))` compared lexicographically — but not the
// direction, so the direction is pinned here: **the greatest tuple wins**, matching the
// "latest/newest wins" flavor of the primary `created_at` key. Every machine comparing the
// same entries picks the same winner, regardless of array order.
//
// `sha256(entry)` is computed over the entry's canonical serialization — UTF-8 JSON with
// keys sorted lexicographically at every level and no insignificant whitespace — the same
// canonicalization rule DATA_MODEL.md §3.1 uses for session content-addressing.

import { createHash } from "node:crypto";

import type { LedgerEntry } from "@git-for-ai/schemas";

/** Recursively sort object keys (dropping `undefined` values, as JSON.stringify would). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        out[key] = canonicalize(source[key]);
      }
    }
    return out;
  }
  return value;
}

/** Canonical JSON serialization: keys sorted at every level, no insignificant whitespace. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Hex sha256 of an entry's canonical serialization (the last tiebreak component). */
function entryDigest(entry: LedgerEntry): string {
  return createHash("sha256").update(canonicalJsonStringify(entry), "utf8").digest("hex");
}

/**
 * Epoch milliseconds for a `created_at` timestamp. Validated entries always parse
 * (timestampSchema enforces RFC 3339); an unparseable value in an unvalidated entry is
 * treated as the epoch (i.e. it loses to any real timestamp) rather than poisoning the
 * comparison with NaN.
 */
function createdAtMs(entry: LedgerEntry): number {
  const ms = Date.parse(entry.created_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The §2.4 tiebreak tuple: (author.human, revision, sha256(entry)), absent human = "". */
function tiebreakKey(entry: LedgerEntry): [string, string, string] {
  return [entry.author.human ?? "", entry.revision, entryDigest(entry)];
}

/** true when `candidate` beats `incumbent` under newest-created_at + greatest-tiebreak-tuple. */
function beats(candidate: LedgerEntry, incumbent: LedgerEntry): boolean {
  const candidateMs = createdAtMs(candidate);
  const incumbentMs = createdAtMs(incumbent);
  if (candidateMs !== incumbentMs) {
    return candidateMs > incumbentMs;
  }
  const candidateKey = tiebreakKey(candidate);
  const incumbentKey = tiebreakKey(incumbent);
  for (let i = 0; i < candidateKey.length; i++) {
    if (candidateKey[i] !== incumbentKey[i]) {
      return candidateKey[i]! > incumbentKey[i]!;
    }
  }
  return false; // fully identical keys — keep the incumbent (stable).
}

/**
 * Resolve the single "effective" entry from a change's append-only entry log
 * (DATA_MODEL.md §2.4): newest `created_at` wins; equal timestamps are broken by the
 * `(author.human, revision, sha256(entry))` tuple, greatest lexicographic tuple winning.
 *
 * Pure and deterministic: the result never depends on the order of `entries`.
 * Throws on an empty array — a valid ledger note always has at least one entry, so an
 * empty input is a caller bug, not a "no intent" case (that case is `readLedgerEntries`
 * returning `null`).
 */
export function resolveEffectiveEntry(entries: readonly LedgerEntry[]): LedgerEntry {
  if (entries.length === 0) {
    throw new Error(
      "resolveEffectiveEntry requires at least one entry; " +
        "'no captured intent' is readLedgerEntries returning null, never an empty array",
    );
  }

  let effective = entries[0]!;
  for (let i = 1; i < entries.length; i++) {
    if (beats(entries[i]!, effective)) {
      effective = entries[i]!;
    }
  }
  return effective;
}

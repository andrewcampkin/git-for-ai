// Change-id primitives — architecture/DATA_MODEL.md §1 and ARCHITECTURE.md §7.6–7.7.
//
// A change-id is an opaque, cryptographically-random 128-bit identifier rendered as
// 32 lowercase hex characters. It is minted at random (never content-derived — Gerrit's
// collision lesson, ARCHITECTURE.md §7.7) and rendered in commit messages as a
// Gerrit-visual-parity trailer: `Change-Id: I<32hex>` (the `I` is not part of the id).

import { randomBytes } from "node:crypto";

import { changeIdSchema, type ChangeId } from "@git-for-ai/schemas";

/**
 * Mint a fresh random change-id: 128 bits of crypto randomness as 32 lowercase hex
 * (ARCHITECTURE.md §7.7 — random, never content-derived, so identical-content commits
 * correctly get distinct identities).
 */
export function mintChangeId(): ChangeId {
  return randomBytes(16).toString("hex");
}

/**
 * Normalize a raw trailer value to canonical 32-lowercase-hex form (ARCHITECTURE.md §7.6):
 * lowercase, strip the leading `I`. Accepts our own `I<32hex>` form directly. Gerrit's
 * legacy ids are `I` + 40 hex (SHA-1-length); those are adopted by taking the first
 * 32 hex chars — deterministic, and still the full 128 bits of the canonical form.
 * Returns null when the value is not a recognizable change-id (treated as "no trailer").
 */
export function normalizeChangeId(raw: string): ChangeId | null {
  let value = raw.trim().toLowerCase();
  // Hex never contains 'i', so a leading 'i' can only be the trailer prefix.
  if (value.startsWith("i")) {
    value = value.slice(1);
  }
  const direct = changeIdSchema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  if (/^[0-9a-f]{40}$/.test(value)) {
    return changeIdSchema.parse(value.slice(0, 32));
  }
  return null;
}

// Trailer lines are matched anywhere in the message body (multiline). DATA_MODEL.md §6
// freezes the format at `Change-Id: I<32hex>`; parsing is deliberately a little laxer
// (any single token) with normalizeChangeId as the validating gate, so Gerrit-style
// 40-hex ids are recognized too (§7.6).
const CHANGE_ID_TRAILER_RE = /^Change-Id:[ \t]*(\S+)[ \t]*$/gim;

/**
 * Extract the change-id from a commit message's `Change-Id:` trailer, or null if the
 * message carries none (or carries an unparseable value). When a message somehow carries
 * more than one trailer (the copy-paste failure mode Gerrit documents), the last one wins —
 * the footer-most trailer is the one git's own trailer tooling treats as effective.
 */
export function parseChangeIdTrailer(message: string): ChangeId | null {
  let lastRaw: string | null = null;
  for (const match of message.matchAll(CHANGE_ID_TRAILER_RE)) {
    lastRaw = match[1] ?? null;
  }
  return lastRaw === null ? null : normalizeChangeId(lastRaw);
}

/** Render a change-id in trailer form: `Change-Id: I<32hex>` (DATA_MODEL.md §1). */
export function formatChangeIdTrailer(changeId: ChangeId): string {
  return `Change-Id: I${changeIdSchema.parse(changeId)}`;
}

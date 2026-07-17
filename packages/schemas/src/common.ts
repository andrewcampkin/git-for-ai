// Shared primitives used across every record type.
// Spec: architecture/DATA_MODEL.md header + §1 (change-id).
//
// All timestamps are RFC 3339 UTC (`Z`). All hashes are lowercase hex.

import { z } from "zod";

/** Lowercase hex string of an exact length. */
const hex = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), {
    message: `expected ${length} lowercase hex characters`,
  });

/**
 * Change-id: opaque 128-bit identifier, encoded as 32 lowercase hex characters
 * (DATA_MODEL.md §1). The `I` trailer prefix is NOT part of the canonical id.
 */
export const changeIdSchema = hex(32);
export type ChangeId = z.infer<typeof changeIdSchema>;

/** Full 40-hex git object SHA (commit, blob, or tree). */
export const gitShaSchema = hex(40);
export type GitSha = z.infer<typeof gitShaSchema>;

/**
 * RFC 3339 UTC timestamp with a `Z` suffix, e.g. `2026-07-17T09:22:41Z`.
 * zod's `.datetime()` rejects numeric offsets by default, which is exactly the
 * "all timestamps are RFC 3339 UTC (`Z`)" rule from the DATA_MODEL.md header.
 */
export const timestampSchema = z
  .string()
  .datetime({ message: "expected RFC 3339 UTC timestamp with Z suffix" });
export type Timestamp = z.infer<typeof timestampSchema>;

/**
 * Session pointer: `sha256:` + hex sha256 of the canonical serialization of a
 * session record (DATA_MODEL.md §3.1).
 */
export const sessionRefSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, {
    message: "expected sha256:<64 lowercase hex characters>",
  });
export type SessionRef = z.infer<typeof sessionRefSchema>;

/**
 * A `reasoning.related` item: either a commit SHA (git-style abbreviations of
 * at least 4 hex chars are accepted, full SHAs are 40) or a `c/`-prefixed
 * 32-hex change-id (DATA_MODEL.md §1 "c/ reference form").
 */
export const relatedRefSchema = z
  .string()
  .regex(/^(?:c\/[0-9a-f]{32}|[0-9a-f]{4,40})$/, {
    message: "expected a (possibly abbreviated) commit SHA or c/<32hex> change-id",
  });
export type RelatedRef = z.infer<typeof relatedRefSchema>;

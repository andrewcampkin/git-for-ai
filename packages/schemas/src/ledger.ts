// Ledger entry + note envelope. Spec: architecture/DATA_MODEL.md §2.
//
// Every record object uses `.passthrough()` because DATA_MODEL.md §6 requires
// forward-compat: unknown fields MUST be ignored by readers and never dropped
// on rewrite, so validation must not strip keys a newer client wrote.

import { z } from "zod";
import {
  changeIdSchema,
  gitShaSchema,
  relatedRefSchema,
  sessionRefSchema,
  timestampSchema,
} from "./common.js";

/**
 * ScopeItem (DATA_MODEL.md §2.2): Agent-Trace-shaped file/line-range/blob
 * item describing what a change touched.
 */
export const scopeItemSchema = z
  .object({
    /** Repo-relative POSIX path. */
    path: z.string().min(1),
    /** 1-based inclusive [start_line, end_line]. Absent = whole file. */
    range: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .refine(([start, end]) => start <= end, {
        message: "range start_line must be <= end_line",
      })
      .optional(),
    /** Git blob SHA of the file version this range refers to. */
    blob: gitShaSchema,
  })
  .passthrough();
export type ScopeItem = z.infer<typeof scopeItemSchema>;

/** `author` object (DATA_MODEL.md §2.3): who/what produced the change. */
export const authorSchema = z
  .object({
    type: z.enum(["agent", "human", "mixed"]),
    /** e.g. `claude-code`. Absent for pure-human. */
    tool: z.string().optional(),
    /** e.g. `claude-opus-4-8`. */
    model: z.string().optional(),
    /** The human on the keyboard (email/handle). */
    human: z.string().optional(),
  })
  .passthrough();
export type Author = z.infer<typeof authorSchema>;

/** An alternative considered and rejected (`reasoning.rejected` item). */
export const rejectedAlternativeSchema = z
  .object({
    option: z.string(),
    why: z.string(),
  })
  .passthrough();
export type RejectedAlternative = z.infer<typeof rejectedAlternativeSchema>;

/**
 * `reasoning` block, Lore vocabulary (DATA_MODEL.md §2.5). All fields are
 * optional; a sparse block is valid.
 */
export const reasoningSchema = z
  .object({
    /** The goal — what outcome the change is trying to achieve. */
    intent: z.string().optional(),
    /** Hard requirements the change had to respect. */
    constraints: z.array(z.string()).optional(),
    /** Alternatives considered and why they were rejected. */
    rejected: z.array(rejectedAlternativeSchema).optional(),
    /** Agent/author confidence in the approach, 0..1. */
    confidence: z.number().min(0).max(1).optional(),
    /** Blast radius of the change. */
    scope_risk: z.enum(["low", "medium", "high"]).optional(),
    /** How hard to undo. */
    reversibility: z.enum(["easy", "moderate", "hard"]).optional(),
    /** The originating instruction/prompt, if captured (redacted). */
    directive: z.string().optional(),
    /** How it was verified (commands run, manual checks). */
    tested: z.array(z.string()).optional(),
    /** Related commit SHAs or `c/`-prefixed change-ids. */
    related: z.array(relatedRefSchema).optional(),
  })
  .passthrough();
export type Reasoning = z.infer<typeof reasoningSchema>;

/** `provenance` enum (DATA_MODEL.md §2.2). */
export const provenanceSchema = z.enum([
  "agent-captured",
  "human-authored",
  "inferred",
]);
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Ledger entry object (DATA_MODEL.md §2.2).
 *
 * The `schema` field is a strict literal: per the DATA_MODEL.md header,
 * consumers must reject a record whose major version they don't understand
 * rather than guess, so anything other than `git-for-ai/ledger-entry@1`
 * fails validation.
 */
export const ledgerEntrySchema = z
  .object({
    schema: z.literal("git-for-ai/ledger-entry@1"),
    /** Stable identity. Matches the enclosing note envelope. */
    change_id: changeIdSchema,
    /** Commit SHA this entry was authored against (the SHA at write time). */
    revision: gitShaSchema,
    /** When this entry was written. Primary sort key for "effective entry". */
    created_at: timestampSchema,
    author: authorSchema,
    /** What this change touched. */
    scope: z.array(scopeItemSchema),
    /** One-line human-readable "what changed". */
    summary: z.string(),
    /** Lore-vocabulary "why" payload. Absent for thin/human commits. */
    reasoning: reasoningSchema.optional(),
    /** `sha256:<hash>` pointer into the sessions ref, or null. */
    session_ref: sessionRefSchema.nullable().optional(),
    /** Present only after a squash fold: all absorbed session pointers. */
    session_refs: z.array(sessionRefSchema).optional(),
    provenance: provenanceSchema,
    /** Present on an absorbed entry after a squash; the surviving change-id. */
    folded_into: changeIdSchema.optional(),
    /** Present if the linked session was dropped (fail-closed redaction). */
    redaction_note: z.string().optional(),
  })
  .passthrough();
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/**
 * Note body envelope (DATA_MODEL.md §2.1) stored in git notes under
 * `refs/notes/git-for-ai/intent`. `entries` is an append-only array, oldest
 * first, with one or more ledger-entry objects.
 */
export const ledgerNoteSchema = z
  .object({
    schema: z.literal("git-for-ai/ledger-note@1"),
    /** The change this note is anchored to. */
    change_id: changeIdSchema,
    entries: z.array(ledgerEntrySchema).min(1),
  })
  .passthrough();
export type LedgerNote = z.infer<typeof ledgerNoteSchema>;

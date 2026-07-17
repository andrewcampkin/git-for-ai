// Change-map entry. Spec: architecture/DATA_MODEL.md §4.
//
// Stored under refs/git-for-ai/change-map, one JSON file per change-id,
// sharded by the first 2 hex chars of the change-id.

import { z } from "zod";
import { changeIdSchema, gitShaSchema, timestampSchema } from "./common.js";

/** `origin` enum (DATA_MODEL.md §4.2): how the entry was created. */
export const changeMapOriginSchema = z.enum([
  "post-commit",
  "post-rewrite",
  "trailer-recovery",
  "inferred",
  "orphan-recovery",
  "rebuild-map",
]);
export type ChangeMapOrigin = z.infer<typeof changeMapOriginSchema>;

/**
 * Change-map entry (DATA_MODEL.md §4.2).
 *
 * `schema` is a strict literal — an unrecognized major version is rejected
 * per the DATA_MODEL.md header rule.
 */
export const changeMapEntrySchema = z
  .object({
    schema: z.literal("git-for-ai/change-map-entry@1"),
    /** The stable id (also encoded in the filename). */
    change_id: changeIdSchema,
    /** Current commit SHA for this change. */
    head: gitShaSchema,
    /** Every SHA this change has had, oldest first, `head` last. */
    history: z.array(gitShaSchema),
    /** Whether a Change-Id trailer exists in the commit message. */
    trailer_seen: z.boolean(),
    origin: changeMapOriginSchema,
    /** If absorbed by a squash, the surviving change-id. */
    folded_into: changeIdSchema.optional(),
    /** On a surviving change, the change-ids it absorbed via squash. */
    absorbed: z.array(changeIdSchema).optional(),
    /** Multi-user only: unreconciled competing heads. */
    divergent_heads: z.array(gitShaSchema).optional(),
    /** Last modification. */
    updated_at: timestampSchema,
  })
  .passthrough();
export type ChangeMapEntry = z.infer<typeof changeMapEntrySchema>;

// Session record. Spec: architecture/DATA_MODEL.md §3.
//
// Content-addressed (sha256 of the canonical serialization) and stored as a
// git blob under `refs/git-for-ai/sessions/<aa>/<hash>`. Shape follows
// OpenTelemetry GenAI semantic conventions.

import { z } from "zod";
import { gitShaSchema, timestampSchema } from "./common.js";

/** Span `kind` enum (DATA_MODEL.md §3.3), OTel-GenAI-shaped. */
export const spanKindSchema = z.enum([
  "agent.plan",
  "gen_ai.completion",
  "gen_ai.tool.execution",
  "agent.step",
]);
export type SpanKind = z.infer<typeof spanKindSchema>;

/** Span object (DATA_MODEL.md §3.3). */
export const spanSchema = z
  .object({
    /** Unique within the record. */
    span_id: z.string().min(1),
    /** Parent span for nested structure. */
    parent_id: z.string().optional(),
    kind: spanKindSchema,
    /** e.g. tool name (`Edit`, `Bash`). */
    name: z.string().optional(),
    /** Span timing when available from the transcript. */
    start: timestampSchema.optional(),
    end: timestampSchema.optional(),
    /** OTel-style key/values, e.g. `{ "file": "src/auth/session.rs" }`. */
    attributes: z.record(z.unknown()).optional(),
    /** Kind-specific payload: `plan` text, redacted `text`, `diff_summary`. */
    body: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type Span = z.infer<typeof spanSchema>;

/** `agent` sub-object of a session record (DATA_MODEL.md §3.2). */
export const sessionAgentSchema = z
  .object({
    tool: z.string(),
    version: z.string(),
    model: z.string(),
  })
  .passthrough();
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

/** `commit_range` sub-object: the commit slice this trace covers. */
export const commitRangeSchema = z
  .object({
    since: gitShaSchema,
    until: gitShaSchema,
  })
  .passthrough();
export type CommitRange = z.infer<typeof commitRangeSchema>;

/**
 * `redaction` sub-object (DATA_MODEL.md §3.2).
 *
 * `truncated_count` is treated as optional: DATA_MODEL.md's field table
 * doesn't itemize per-subfield requiredness the way it does for e.g.
 * ScopeItem/author, and ARCHITECTURE.md §6.2's worked summary example omits
 * it entirely.
 */
export const redactionInfoSchema = z
  .object({
    applied: z.boolean(),
    rules: z.array(z.string()),
    redacted_count: z.number().int().min(0),
    truncated_count: z.number().int().min(0).optional(),
  })
  .passthrough();
export type RedactionInfo = z.infer<typeof redactionInfoSchema>;

/**
 * Session record (DATA_MODEL.md §3.2).
 *
 * `schema` is a strict literal — an unrecognized major version is rejected
 * per the DATA_MODEL.md header rule.
 */
export const sessionRecordSchema = z
  .object({
    schema: z.literal("git-for-ai/session@1"),
    /** Claude Code session_id (join key back to the originating session). */
    session_id: z.string().min(1),
    agent: sessionAgentSchema,
    /** When capture ran. */
    captured_at: timestampSchema,
    commit_range: commitRangeSchema,
    redaction: redactionInfoSchema,
    /** Fingerprint of the transcript-format adapter used. */
    source_fingerprint: z.string().min(1),
    /** Temporally-ordered OTel-GenAI spans. */
    spans: z.array(spanSchema),
    /** Compressed representation used for embedding. */
    summary: z.string().optional(),
  })
  .passthrough();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

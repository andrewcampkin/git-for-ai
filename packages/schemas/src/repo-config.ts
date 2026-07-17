// Repo config (`.git-for-ai/config.toml`). Spec: architecture/DATA_MODEL.md §5.
//
// The file on disk is TOML; this schema validates the parsed JS object shape
// (the nested tables become nested objects). Local, not synced.

import { z } from "zod";

/** `embedder.provider` enum (DATA_MODEL.md §5, illustrative TOML comment). */
export const embedderProviderSchema = z.enum([
  "jina-v2-code",
  "nomic-embed-code",
  "voyage-code-3",
]);
export type EmbedderProvider = z.infer<typeof embedderProviderSchema>;

/** `[embedder]` table. */
export const embedderConfigSchema = z
  .object({
    provider: embedderProviderSchema,
    dim: z.number().int().positive(),
    /** false only for API providers. */
    offline: z.boolean(),
    /** must be explicitly set true to enable voyage (ARCHITECTURE §14.14). */
    voyage_consent: z.boolean(),
  })
  .passthrough();
export type EmbedderConfig = z.infer<typeof embedderConfigSchema>;

/** `[capture]` table. */
export const captureConfigSchema = z
  .object({
    /** set by `init`; the per-repo opt-in switch. */
    enabled: z.boolean(),
    never_capture: z.array(z.string()),
    max_span_bytes: z.number().int().positive(),
  })
  .passthrough();
export type CaptureConfig = z.infer<typeof captureConfigSchema>;

/** `[redaction]` table. */
export const redactionConfigSchema = z
  .object({
    ruleset: z.string(),
    /** user-added regexes. */
    extra_patterns: z.array(z.string()),
  })
  .passthrough();
export type RedactionConfig = z.infer<typeof redactionConfigSchema>;

/** `[index]` table. */
export const indexConfigSchema = z
  .object({
    /** keyword FTS5 + vector (recommended default). */
    hybrid: z.boolean(),
  })
  .passthrough();
export type IndexConfig = z.infer<typeof indexConfigSchema>;

/**
 * Repo config (DATA_MODEL.md §5), parsed from `.git-for-ai/config.toml`.
 *
 * `schema` is a strict literal — an unrecognized major version is rejected
 * per the DATA_MODEL.md header rule.
 */
export const repoConfigSchema = z
  .object({
    schema: z.literal("git-for-ai/config@1"),
    embedder: embedderConfigSchema,
    capture: captureConfigSchema,
    redaction: redactionConfigSchema,
    index: indexConfigSchema,
  })
  .passthrough();
export type RepoConfig = z.infer<typeof repoConfigSchema>;

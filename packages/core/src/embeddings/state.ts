// `.git-for-ai/state.json` — index bookkeeping, DATA_MODEL.md §5.1.
//
// `init` writes the "nothing indexed yet" form of this file; this module is the
// read/update side that the index layer and `reindex` use. Kept deliberately tiny.
//
// ── Judgment calls ──
// 1. Validation is hand-rolled (not Zod): @git-for-ai/core does not currently depend on
//    zod directly, and DATA_MODEL.md §5.1's schema has five fields. If a shared
//    `indexStateSchema` lands in @git-for-ai/schemas later (it arguably belongs there —
//    flagged during the embedding pipeline build), this module shrinks to a call into it.
// 2. Per DATA_MODEL.md §6, unknown fields are preserved on rewrite: `readIndexState`
//    keeps every key it parsed, and `updateIndexState` merges over the existing record
//    rather than regenerating it, so a newer client's fields survive a round-trip.
// 3. A missing file reads as null (pre-init or hand-deleted cache — both fine, the whole
//    directory is derived); a file with the wrong schema major throws loudly per the
//    DATA_MODEL.md header rule ("reject, don't guess").

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INDEX_STATE_SCHEMA = "git-for-ai/index-state@1";

/** The five pinned fields of DATA_MODEL.md §5.1 (without the unknown-key passthrough). */
export interface IndexStateFields {
  schema: typeof INDEX_STATE_SCHEMA;
  last_indexed_commit: string | null;
  model_fingerprint: string;
  vec_schema_version: number;
  chunk_count: number;
  updated_at: string;
}

/** DATA_MODEL.md §5.1. Extra keys from newer writers are preserved, never dropped. */
export interface IndexState extends IndexStateFields {
  [key: string]: unknown;
}

/** Thrown for an unreadable/wrong-major state.json (reject, don't guess — DATA_MODEL.md §6). */
export class IndexStateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexStateFormatError";
  }
}

/** Path of state.json inside a `.git-for-ai/` directory. */
export function indexStatePath(gitForAiDir: string): string {
  return join(gitForAiDir, "state.json");
}

/** Read and validate state.json; null when the file does not exist. */
export async function readIndexState(gitForAiDir: string): Promise<IndexState | null> {
  let raw: string;
  try {
    raw = await readFile(indexStatePath(gitForAiDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new IndexStateFormatError(`state.json is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IndexStateFormatError("state.json is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["schema"] !== INDEX_STATE_SCHEMA) {
    throw new IndexStateFormatError(
      `state.json has schema ${JSON.stringify(record["schema"])}; this build only understands ` +
        `"${INDEX_STATE_SCHEMA}" (reject unknown majors, DATA_MODEL.md §6)`,
    );
  }
  const fingerprint = record["model_fingerprint"];
  const vecVersion = record["vec_schema_version"];
  const chunkCount = record["chunk_count"];
  const lastIndexed = record["last_indexed_commit"];
  const updatedAt = record["updated_at"];
  if (
    typeof fingerprint !== "string" ||
    typeof vecVersion !== "number" ||
    typeof chunkCount !== "number" ||
    (lastIndexed !== null && typeof lastIndexed !== "string") ||
    typeof updatedAt !== "string"
  ) {
    throw new IndexStateFormatError("state.json is missing or mistypes a required field");
  }
  return record as unknown as IndexState;
}

/**
 * Merge `updates` over the existing state (or a fresh record when none exists) and
 * write it back. `updated_at` is stamped automatically unless explicitly supplied.
 */
export async function updateIndexState(
  gitForAiDir: string,
  updates: Partial<Omit<IndexStateFields, "schema">> &
    Pick<IndexStateFields, "model_fingerprint"> &
    Record<string, unknown>,
): Promise<IndexState> {
  const existing = await readIndexState(gitForAiDir);
  const next: IndexState = {
    last_indexed_commit: null,
    vec_schema_version: 1,
    chunk_count: 0,
    ...(existing ?? {}),
    ...updates,
    schema: INDEX_STATE_SCHEMA,
    updated_at: updates.updated_at ?? new Date().toISOString(),
  };
  await writeFile(indexStatePath(gitForAiDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

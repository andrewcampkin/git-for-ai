// state.json bookkeeping tests (DATA_MODEL.md §5.1, §6): round-trip, the
// reject-unknown-major rule, and unknown-key preservation on rewrite.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IndexStateFormatError,
  indexStatePath,
  readIndexState,
  updateIndexState,
} from "./state.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "git-for-ai-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("readIndexState / updateIndexState", () => {
  it("returns null when state.json does not exist", async () => {
    expect(await readIndexState(dir)).toBeNull();
  });

  it("creates and round-trips the DATA_MODEL.md §5.1 shape", async () => {
    const written = await updateIndexState(dir, {
      model_fingerprint: "jina-v2-code/768",
      last_indexed_commit: "b".repeat(40),
      chunk_count: 12,
    });
    expect(written).toMatchObject({
      schema: "git-for-ai/index-state@1",
      model_fingerprint: "jina-v2-code/768",
      last_indexed_commit: "b".repeat(40),
      vec_schema_version: 1,
      chunk_count: 12,
    });
    expect(typeof written.updated_at).toBe("string");

    const read = await readIndexState(dir);
    expect(read).toEqual(written);
  });

  it("parses the exact file `init` writes", async () => {
    // Byte-for-byte the renderDefaultStateJson() shape from packages/cli init.ts.
    const initState = {
      schema: "git-for-ai/index-state@1",
      last_indexed_commit: null,
      model_fingerprint: "jina-v2-code/768",
      vec_schema_version: 1,
      chunk_count: 0,
      updated_at: "2026-07-17T09:41:00.000Z",
    };
    await writeFile(indexStatePath(dir), `${JSON.stringify(initState, null, 2)}\n`, "utf8");
    expect(await readIndexState(dir)).toEqual(initState);
  });

  it("preserves unknown keys across an update (forward-compat, DATA_MODEL.md §6)", async () => {
    await writeFile(
      indexStatePath(dir),
      JSON.stringify({
        schema: "git-for-ai/index-state@1",
        last_indexed_commit: null,
        model_fingerprint: "jina-v2-code/768",
        vec_schema_version: 1,
        chunk_count: 0,
        updated_at: "2026-07-17T09:41:00Z",
        future_field: { keep: "me" },
      }),
      "utf8",
    );
    const updated = await updateIndexState(dir, {
      model_fingerprint: "jina-v2-code/768",
      chunk_count: 7,
    });
    expect(updated["future_field"]).toEqual({ keep: "me" });
    const raw = JSON.parse(await readFile(indexStatePath(dir), "utf8")) as Record<string, unknown>;
    expect(raw["future_field"]).toEqual({ keep: "me" });
    expect(raw["chunk_count"]).toBe(7);
  });

  it("rejects an unknown schema major and malformed files loudly", async () => {
    await writeFile(indexStatePath(dir), JSON.stringify({ schema: "git-for-ai/index-state@2" }), "utf8");
    await expect(readIndexState(dir)).rejects.toThrow(IndexStateFormatError);

    await writeFile(indexStatePath(dir), "not json at all", "utf8");
    await expect(readIndexState(dir)).rejects.toThrow(IndexStateFormatError);

    await writeFile(
      indexStatePath(dir),
      JSON.stringify({ schema: "git-for-ai/index-state@1", model_fingerprint: 42 }),
      "utf8",
    );
    await expect(readIndexState(dir)).rejects.toThrow(/required field/);
  });
});

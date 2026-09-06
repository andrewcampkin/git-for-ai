// The local vector index — architecture/ARCHITECTURE.md §11.4, DATA_MODEL.md §5.1.
//
// Backend: Node's built-in `node:sqlite` (`DatabaseSync`, opened with
// `{ allowExtension: true }`) plus the prebuilt `sqlite-vec` extension loaded from the
// npm package. better-sqlite3 is deliberately not used: it
// cannot build on the reference machine (Node 24.8.0 — no prebuilt binary, broken
// ClangCL), while node:sqlite needs no native build at all and was spike-verified to
// load sqlite-vec (vec0 KNN + FTS5 in the same file) on this machine. `node:sqlite`
// emits a one-time ExperimentalWarning per process; harmless.
//
// Everything in this file is a derived cache (§8.2): `index.db` can be deleted and
// rebuilt from git at any time via reindex. Git is truth; this is speed.
//
// ── Schema (VEC_SCHEMA_VERSION 1) ──
// - `meta`           key/value: vec_schema_version, model_fingerprint, dim. The db is
//                    self-describing; `state.json` (./state.ts) additionally records the
//                    same fingerprint per DATA_MODEL.md §5.1 for doctor to cross-check.
// - `chunks`         one row per indexed chunk: identity key, kind (code|ledger|session),
//                    source metadata (path/blob/node-path/lines or change-id/session-ref)
//                    and the raw text.
// - `chunk_vectors`  vec0 virtual table, rowid-joined to `chunks.id`.
// - `chunk_fts`      FTS5 mirror of the same text, rowid-joined to `chunks.id` — the
//                    keyword half of hybrid retrieval (§11.4); the query engine consumes both.
//
// ── Judgment calls ──
// 1. §11.4 names the VectorStore interface but never writes it down; the shape below
//    (upsert/delete by chunk key, KNN query, keyword query, count) is the minimal
//    surface `reindex` and hybrid retrieval need.
// 2. Chunk identity `key` is caller-defined; for code the convention is
//    `<blob_sha>:<node_path>` (§11.2's chunk identity). Upsert replaces by key, so
//    re-indexing an unchanged file is idempotent.
// 3. vec0 quirk (spike-verified): rowid binds MUST be BigInt (a JS number binds as a
//    SQLite float, which vec0 rejects); rowids READ back as plain numbers. All integer
//    binds here go through BigInt for uniformity.
// 4. Fingerprint/schema mismatch on open throws a typed error instead of silently
//    serving cross-model vectors (§11.3 "never mix"); the caller (`reindex --full`,
//    `doctor`) decides whether to rebuild.
// 5. Distance metric is sqlite-vec's default L2. The default embedder L2-normalizes its
//    output, making L2 ranking equivalent to cosine ranking.
// 6. `toFtsQuery()` is provided for the query engine: FTS5 MATCH has its own query syntax that chokes
//    on raw natural language (apostrophes, hyphens); the helper quotes each token so
//    arbitrary question text is always a valid query.

import { createRequire } from "node:module";

import * as sqliteVec from "sqlite-vec";

// `node:sqlite` is a prefix-only builtin (no bare "sqlite" form), which vite/vitest's
// module resolution (vite 5.x) does not yet recognize as a builtin — a static
// `import { DatabaseSync } from "node:sqlite"` fails to resolve under vitest. Loading it
// through createRequire is invisible to the bundler and byte-identical at runtime; the
// type-only import below is erased at compile time and keeps full typing.
//
// The require is DEFERRED until a store is actually opened: loading node:sqlite prints
// the ExperimentalWarning, and this module is reachable from the core barrel — an eager
// require would make every CLI command (log, show, ...) emit the warning even when no
// index is touched. Deferred, only reindex/query paths that really open the db pay it.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
type DatabaseSync = DatabaseSyncType;

let databaseSyncCtor: typeof DatabaseSyncType | undefined;
function loadDatabaseSync(): typeof DatabaseSyncType {
  databaseSyncCtor ??= (
    require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType }
  ).DatabaseSync;
  return databaseSyncCtor;
}

/** Bump when the table layout changes; mirrored into meta + state.json. */
export const VEC_SCHEMA_VERSION = 1;

/** The three content kinds sharing one embedding space (ARCHITECTURE.md §11.1). */
export type IndexedKind = "code" | "ledger" | "session";

/** One chunk to upsert into the index. */
export interface VectorStoreItem {
  /** Unique chunk identity; for code chunks use `<blob_sha>:<node_path>` (§11.2). */
  key: string;
  kind: IndexedKind;
  /** The text that was embedded; also FTS5-indexed for hybrid retrieval. */
  text: string;
  /** Embedding of `text`; length must equal the store's dim. */
  vector: Float32Array;
  /** Code chunks: repo-relative path. */
  path?: string;
  /** Code chunks: git blob SHA the chunk was cut from. */
  blobSha?: string;
  /** Code chunks: tree-sitter node path within the blob. */
  nodePath?: string;
  startLine?: number;
  endLine?: number;
  /** Ledger/session chunks: owning change-id. */
  changeId?: string;
  /** Session chunks: `sha256:<hash>` session pointer. */
  sessionRef?: string;
}

/** A stored chunk row, as returned by queries. */
export interface StoredChunk {
  key: string;
  kind: IndexedKind;
  text: string;
  path: string | null;
  blobSha: string | null;
  nodePath: string | null;
  startLine: number | null;
  endLine: number | null;
  changeId: string | null;
  sessionRef: string | null;
}

export interface VectorMatch extends StoredChunk {
  /** L2 distance (smaller = closer). */
  distance: number;
}

export interface KeywordMatch extends StoredChunk {
  /** FTS5 bm25 score (more negative = better match). */
  score: number;
}

/**
 * The pluggable vector-store interface (ARCHITECTURE.md §11.4). The sqlite-vec
 * implementation is {@link SqliteVectorStore}; LanceDB is the documented upgrade path.
 */
export interface VectorStore {
  readonly dim: number;
  readonly modelFingerprint: string;
  upsert(items: VectorStoreItem[]): void;
  deleteByKeys(keys: string[]): void;
  has(key: string): boolean;
  /** K-nearest-neighbor search over the vector half of the index. */
  queryVector(vector: Float32Array, k: number): VectorMatch[];
  /** bm25-ranked search over the FTS5 keyword mirror. `query` is FTS5 MATCH syntax — use {@link toFtsQuery} for raw text. */
  queryKeyword(query: string, k: number): KeywordMatch[];
  count(): number;
  close(): void;
}

/** Thrown when an existing index was built under a different model or schema version. */
export class IndexFingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexFingerprintError";
  }
}

export interface OpenVectorStoreOptions {
  /** Path to the database file (`.git-for-ai/index.db`), or `":memory:"`. */
  path: string;
  /** Vector dimensionality (must match the embedder's dim). */
  dim: number;
  /** `<provider>/<dim>` (DATA_MODEL.md §5.1); mismatches with an existing db throw. */
  modelFingerprint: string;
}

/** Escape arbitrary text into a safe FTS5 MATCH query: each token quoted, OR-joined. */
export function toFtsQuery(text: string): string {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

const CHUNK_COLUMNS =
  "key, kind, text, path, blob_sha, node_path, start_line, end_line, change_id, session_ref";

export class SqliteVectorStore implements VectorStore {
  readonly dim: number;
  readonly modelFingerprint: string;
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync, dim: number, modelFingerprint: string) {
    this.db = db;
    this.dim = dim;
    this.modelFingerprint = modelFingerprint;
  }

  /**
   * Open (creating or validating the schema as needed) the index database.
   * Throws {@link IndexFingerprintError} if the file was built under a different
   * model fingerprint or vec-schema version — never mixes vectors across models.
   */
  static open(options: OpenVectorStoreOptions): SqliteVectorStore {
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(options.path, { allowExtension: true });
    try {
      sqliteVec.load(db);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          path TEXT,
          blob_sha TEXT,
          node_path TEXT,
          start_line INTEGER,
          end_line INTEGER,
          change_id TEXT,
          session_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
        CREATE INDEX IF NOT EXISTS idx_chunks_blob ON chunks(blob_sha);
      `);
      const store = new SqliteVectorStore(db, options.dim, options.modelFingerprint);
      store.checkOrStampMeta();
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${options.dim}])`);
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text)");
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private checkOrStampMeta(): void {
    const read = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    const existingVersion = (read.get("vec_schema_version") as { value: string } | undefined)?.value;
    const existingFingerprint = (read.get("model_fingerprint") as { value: string } | undefined)?.value;
    if (existingVersion === undefined && existingFingerprint === undefined) {
      const put = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      put.run("vec_schema_version", String(VEC_SCHEMA_VERSION));
      put.run("model_fingerprint", this.modelFingerprint);
      put.run("dim", String(this.dim));
      return;
    }
    if (existingVersion !== String(VEC_SCHEMA_VERSION)) {
      throw new IndexFingerprintError(
        `index.db has vec_schema_version ${existingVersion ?? "(none)"}; this build expects ` +
          `${VEC_SCHEMA_VERSION}. Run \`git for-ai reindex --full\` to rebuild the index.`,
      );
    }
    if (existingFingerprint !== this.modelFingerprint) {
      throw new IndexFingerprintError(
        `index.db was built with embedder "${existingFingerprint ?? "(none)"}" but the configured ` +
          `embedder is "${this.modelFingerprint}". Vectors from different models are never mixed ` +
          `(ARCHITECTURE.md §11.3) — run \`git for-ai reindex --full\` to rebuild.`,
      );
    }
  }

  upsert(items: VectorStoreItem[]): void {
    if (items.length === 0) {
      return;
    }
    for (const item of items) {
      if (item.vector.length !== this.dim) {
        throw new Error(
          `vector for chunk "${item.key}" has dim ${item.vector.length}; the store is dim ${this.dim}`,
        );
      }
    }
    const findId = this.db.prepare("SELECT id FROM chunks WHERE key = ?");
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (${CHUNK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateChunk = this.db.prepare(
      `UPDATE chunks SET kind = ?, text = ?, path = ?, blob_sha = ?, node_path = ?,
         start_line = ?, end_line = ?, change_id = ?, session_ref = ? WHERE id = ?`,
    );
    const deleteVector = this.db.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunk_fts WHERE rowid = ?");
    const insertVector = this.db.prepare("INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)");
    const insertFts = this.db.prepare("INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)");

    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const meta = [
          item.path ?? null,
          item.blobSha ?? null,
          item.nodePath ?? null,
          item.startLine !== undefined ? BigInt(item.startLine) : null,
          item.endLine !== undefined ? BigInt(item.endLine) : null,
          item.changeId ?? null,
          item.sessionRef ?? null,
        ] as const;
        const existing = findId.get(item.key) as { id: number | bigint } | undefined;
        let rowid: bigint;
        if (existing !== undefined) {
          rowid = BigInt(existing.id);
          updateChunk.run(item.kind, item.text, ...meta, rowid);
          deleteVector.run(rowid);
          deleteFts.run(rowid);
        } else {
          const result = insertChunk.run(item.key, item.kind, item.text, ...meta);
          rowid = BigInt(result.lastInsertRowid);
        }
        insertVector.run(rowid, vectorBytes(item.vector));
        insertFts.run(rowid, item.text);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteByKeys(keys: string[]): void {
    if (keys.length === 0) {
      return;
    }
    const findId = this.db.prepare("SELECT id FROM chunks WHERE key = ?");
    const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    const deleteVector = this.db.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunk_fts WHERE rowid = ?");
    this.db.exec("BEGIN");
    try {
      for (const key of keys) {
        const existing = findId.get(key) as { id: number | bigint } | undefined;
        if (existing === undefined) {
          continue;
        }
        const rowid = BigInt(existing.id);
        deleteVector.run(rowid);
        deleteFts.run(rowid);
        deleteChunk.run(rowid);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  has(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM chunks WHERE key = ?").get(key) !== undefined;
  }

  queryVector(vector: Float32Array, k: number): VectorMatch[] {
    if (vector.length !== this.dim) {
      throw new Error(`query vector has dim ${vector.length}; the store is dim ${this.dim}`);
    }
    const rows = this.db
      .prepare(
        `SELECT c.${CHUNK_COLUMNS.split(", ").join(", c.")}, v.distance
           FROM (SELECT rowid, distance FROM chunk_vectors
                  WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
           JOIN chunks c ON c.id = v.rowid
          ORDER BY v.distance`,
      )
      .all(vectorBytes(vector), BigInt(Math.trunc(k))) as unknown as Array<RawChunkRow & { distance: number }>;
    return rows.map((row) => ({ ...toStoredChunk(row), distance: Number(row.distance) }));
  }

  queryKeyword(query: string, k: number): KeywordMatch[] {
    if (query.trim().length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT c.${CHUNK_COLUMNS.split(", ").join(", c.")}, bm25(chunk_fts) AS score
           FROM chunk_fts
           JOIN chunks c ON c.id = chunk_fts.rowid
          WHERE chunk_fts MATCH ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(query, BigInt(Math.trunc(k))) as unknown as Array<RawChunkRow & { score: number }>;
    return rows.map((row) => ({ ...toStoredChunk(row), score: Number(row.score) }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number | bigint };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}

interface RawChunkRow {
  key: string;
  kind: string;
  text: string;
  path: string | null;
  blob_sha: string | null;
  node_path: string | null;
  start_line: number | bigint | null;
  end_line: number | bigint | null;
  change_id: string | null;
  session_ref: string | null;
}

function toStoredChunk(row: RawChunkRow): StoredChunk {
  return {
    key: row.key,
    kind: row.kind as IndexedKind,
    text: row.text,
    path: row.path,
    blobSha: row.blob_sha,
    nodePath: row.node_path,
    startLine: row.start_line === null ? null : Number(row.start_line),
    endLine: row.end_line === null ? null : Number(row.end_line),
    changeId: row.change_id,
    sessionRef: row.session_ref,
  };
}

/** Raw little-endian float32 bytes — the BLOB form sqlite-vec's vec0 accepts. */
function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

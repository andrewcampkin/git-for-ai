// `git for-ai reindex [--full] [--since <commit>] [--verify]` — Milestone 10
// (architecture/CLI_PLAN.md), over the M9 embedding pipeline. Spec: CLI_REFERENCE.md's
// `reindex` section and ARCHITECTURE.md §11 (what gets indexed) / §8.2 (what is derived).
//
// Rebuilds the local vector cache (`.git-for-ai/index.db` + `embcache/`) from git-native
// truth. Three content kinds land in ONE embedding space (§11.1):
//   1. code chunks    — tree-sitter chunks of every tracked blob at HEAD,
//                       keyed `<blob_sha>:<node_path>` (§11.2 chunk identity);
//   2. ledger entries — the effective entry's summary + reasoning text per change,
//                       keyed `ledger:<change_id>`;
//   3. session summaries — the compressed `summary` of each stored session record
//                       (never the raw spans, §11.1), keyed `session:<content_hash>`.
//
// Incremental by default: `state.json`'s `last_indexed_commit` is the base; only blobs
// touched by `git diff <base> HEAD` are re-chunked, and the blob-hash embcache makes any
// chunk whose content is unchanged free (M9's definition of done: a no-change re-run
// embeds NOTHING). `--full` drops `index.db` and rebuilds from scratch — the required
// recovery path after a model_fingerprint change (IndexFingerprintError) — while KEEPING
// `embcache/`, which is why the CLI_REFERENCE transcript shows "312 reused from embcache"
// even on a --full run.
//
// ── Judgment calls (where the docs are loose, decided + documented here) ──
//
// 1. Ledger granularity: ONE indexed item per change — the *effective* entry
//    (DATA_MODEL.md §2.4) — not one per appended entry. Superseded entries would pollute
//    retrieval with outdated reasoning; CLI_REFERENCE's own transcript agrees (12 changes
//    in the change-map ↔ "ledger entries: 12"). Changes absorbed by a squash
//    (`folded_into` set) are skipped — the surviving change's ledger covers them.
//    Because the item key is `ledger:<change_id>`, a newly appended (superseding) entry
//    simply replaces the old vector on the next run.
// 2. Ledger/session cache identity: `embedChunksWithCache` keys on (blob_sha, node_path).
//    Sessions use their real git blob SHA + node_path "session". Ledger entries have no
//    single blob, so the pseudo-blob is sha256(canonical entry JSON) + node_path
//    "ledger" — content-derived, so an unchanged effective entry is a guaranteed cache
//    hit and a superseded one is a guaranteed miss.
// 3. Ledger + sessions are re-enumerated on EVERY run (never diffed): they are small
//    (one item per change / per session), enumeration is a couple of git calls, and the
//    cache makes unchanged items free. Only code — the big kind — is diff-driven.
// 4. Incremental deletion: stale rows for a modified/deleted file are found by
//    re-chunking the file's OLD blob (from the base tree) to reconstruct its old keys.
//    A key whose blob still exists anywhere in the HEAD tree is NOT deleted (two
//    identical files share `<blob_sha>:<node_path>` keys — a known, benign collision:
//    the store keeps one row, last writer's path wins). If the recorded base commit no
//    longer exists (history rewritten), we fall back to a full drop-and-rebuild with a
//    warning — index.db is a cache, and embcache makes the rebuild cheap.
// 5. What code gets skipped: non-regular-file tree entries (symlinks, submodules),
//    files whose content contains a NUL byte (binary), and files over 1 MiB. Skipped
//    files are counted, never silently lost. Everything else — including non-TS/JS/Py
//    files — is indexed via the chunker's plain-text fallback.
// 6. Session text: `record.summary` when present (DATA_MODEL.md §3.2 calls it the
//    "compressed representation used for embedding"). When a capture predates summaries,
//    a small deterministic fallback (agent + span names) keeps the session findable
//    rather than invisible. A session's owning change-id is recovered by joining
//    ledger `session_ref`s, when one exists.
// 7. Transformers model cache location (flagged by the M9 report): transformers.js
//    defaults to caching model weights inside node_modules, which a `pnpm install`/prune
//    can wipe — forcing a ~160 MB re-download. The default embedder is therefore pointed
//    at a durable per-user cache: `%LOCALAPPDATA%\git-for-ai\models` on Windows,
//    `~/.cache/git-for-ai/models` elsewhere, overridable via GIT_FOR_AI_MODEL_CACHE.
//    Per-user (not per-repo) so the model downloads once per machine.
// 8. Model fingerprint: `<provider>/<dim>` from config.toml on the default path (matches
//    what init wrote to state.json). An injected embedder (tests; future callers)
//    fingerprints as `<embedder.id>/<embedder.dim>` — self-describing, and it makes
//    fingerprint-mismatch behavior honestly testable without the real model.
// 9. config.toml is read with the same deliberately tiny line-based TOML reader idiom as
//    core's captureConfig.ts (the file is written by our own init in a known flat shape;
//    the monorepo has no TOML dependency). Unknown/missing values fall back to init's
//    defaults; the assembled object is validated against repoConfigSchema.
// 10. Embedding is BATCHED (EMBED_BATCH chunks per embedChunksWithCache call), not one
//    giant call: cache files land on disk and rows land in the store after every batch,
//    so a killed run resumes nearly free, and `onProgress` can report real progress.
//    The first real-model dogfood proved why: a single all-chunks call gave zero
//    observable/durable progress for the better part of an hour. Batches are
//    length-sorted first so the embedder's internal padding wastes less compute.
// 11a. GPU/precision (ROADMAP Tier 0, owner-chosen 2026-07-19): the default embedder now
//    resolves a device + weight precision (DirectML/fp16 on win32, CPU/int8 elsewhere;
//    GIT_FOR_AI_DEVICE / GIT_FOR_AI_DTYPE override) and the EFFECTIVE precision folds
//    into the model fingerprint (`jina-v2-code/768/fp16` vs legacy `jina-v2-code/768`
//    for int8) — so GPU-fp16 and CPU-int8 vectors can never silently mix, and switching
//    devices takes the designed IndexFingerprintError → `reindex --full` path. The
//    resolved device/precision/reason is logged via onProgress at run start so a CPU
//    fallback is always visible, never silent.
// 11b. No-progress watchdog (ROADMAP Tier 0 item 3): if no embedding batch completes
//    within a generous timeout (default 15 min; GIT_FOR_AI_REINDEX_WATCHDOG_MS
//    overrides, 0 disables), the run aborts with an explicit error instead of spinning
//    silently. This catches the live-but-stuck failure mode; bin.ts's beforeExit guard
//    already catches the stranded-promise (dead backend) mode. Native inference runs on
//    ORT's threadpool, so the event loop stays live and the timer can actually fire.
// 11. Code chunks are re-windowed at REINDEX_MAX_CHUNK_CHARS (2000 chars ≈ 500 tokens),
//    well below the chunker's 8000-char default: transformer self-attention cost grows
//    quadratically with token count, so 2k-token chunks are ~16x costlier than 500-token
//    ones on CPU — the difference between a coffee break and an unusable first index.
//    ~500 tokens is also conventional retrieval granularity. The same value MUST be used
//    when reconstructing old keys for stale-row deletion (judgment call #4).

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  runGit,
  catFile,
  lsTree,
  readAllChangeMapEntries,
  readLedgerEntries,
  resolveEffectiveEntry,
  LedgerNoteFormatError,
  canonicalJsonStringify,
  readSessionsCommit,
  chunkSourceFile,
  EmbeddingCache,
  embedChunksWithCache,
  SqliteVectorStore,
  VEC_SCHEMA_VERSION,
  createEmbedderFromConfig,
  modelFingerprint,
  readIndexState,
  updateIndexState,
  IndexStateFormatError,
  type Embedder,
  type GitContext,
  type CacheableChunk,
  type VectorStoreItem,
  type LedgerNoteOptions,
} from "@git-for-ai/core";
import {
  repoConfigSchema,
  sessionRecordSchema,
  type LedgerEntry,
  type RepoConfig,
} from "@git-for-ai/schemas";

// ─── Public types ────────────────────────────────────────────────────────────

/** Options for {@link runReindex}, mirroring CLI_REFERENCE.md's `reindex` flags. */
export interface ReindexOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--full` — drop index.db and re-embed everything (embcache is kept). */
  full?: boolean;
  /** `--since <commit>` — incremental base override (instead of state.json's). */
  since?: string;
  /** `--verify` — check the index against state.json without rebuilding. */
  verify?: boolean;
  /**
   * Injectable embedding provider. Tests inject a deterministic fake here; when absent
   * the embedder comes from `.git-for-ai/config.toml` via createEmbedderFromConfig
   * (the real transformers.js model on the default config).
   */
  embedder?: Embedder;
  /** Progress reporting (one line per embedding batch); bin.ts wires this to stderr. */
  onProgress?: (line: string) => void;
}

/** Per-content-kind counts for one run. */
export interface KindCounts {
  /** Items upserted into the index this run. */
  indexed: number;
  /** Of those, embeddings served from embcache (no model call). */
  reused: number;
  /** Of those, embeddings actually computed (and cached for next time). */
  embedded: number;
}

/** `--verify` outcome. */
export interface VerifyReport {
  current: boolean;
  problems: string[];
}

/** The structured result behind the rendered output. */
export interface ReindexData {
  mode: "full" | "initial" | "incremental" | "verify";
  modelFingerprint: string;
  /** HEAD at the time of the run (full 40-hex). */
  headCommit: string;
  /** The incremental base actually used, or null (full/initial). */
  baseCommit: string | null;
  code: KindCounts & { filesIndexed: number; filesSkipped: number; staleKeysDeleted: number };
  ledger: KindCounts;
  sessions: KindCounts;
  /** Total chunks in the index after the run (store.count()). */
  totalChunks: number;
  /** Repo-relative path of the index database. */
  indexPath: string;
  /** True when an incremental run found nothing to embed or delete. */
  upToDate: boolean;
  warnings: string[];
  /** Present only in `--verify` mode. */
  verify?: VerifyReport;
}

export interface ReindexResult {
  data: ReindexData;
  /** Rendered console output (CLI_REFERENCE.md transcript shape). */
  output: string;
}

// ─── Constants / small helpers ───────────────────────────────────────────────

/** Files larger than this are skipped (never chunked/embedded). See judgment call #5. */
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;

/** Chunk window for reindex (~500 tokens). See judgment call #11. */
const REINDEX_MAX_CHUNK_CHARS = 2000;

/** Chunks per embedChunksWithCache call (progressive cache/store writes, #10). */
const EMBED_BATCH = 32;

const INDEX_DB_RELPATH = ".git-for-ai/index.db";

/** Default no-progress watchdog timeout (judgment call #11b). Generous: the first batch
 * may include a multi-hundred-MB one-time model download. */
const WATCHDOG_DEFAULT_MS = 15 * 60_000;

function watchdogTimeoutMs(): number {
  const raw = process.env["GIT_FOR_AI_REINDEX_WATCHDOG_MS"];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return WATCHDOG_DEFAULT_MS;
}

/**
 * No-progress watchdog (judgment call #11b): `promise` rejects if `pet()` is not called
 * within `timeoutMs`. Race it against the embedding work; pet it after every batch.
 * A timeout of 0 disables it (the promise then never settles).
 */
class BatchWatchdog {
  readonly promise: Promise<never>;
  private timer: NodeJS.Timeout | null = null;
  private rejectFn: ((error: Error) => void) | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.promise = new Promise<never>((_, reject) => {
      this.rejectFn = reject;
    });
    // Register a handler so an un-raced timeout never surfaces as an unhandled rejection.
    this.promise.catch(() => {});
    this.arm();
  }

  private arm(): void {
    if (this.timeoutMs <= 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.rejectFn?.(
        new Error(
          `reindex watchdog: no embedding batch completed within ${Math.round(this.timeoutMs / 60_000)} ` +
            "minutes — the embedding backend appears stuck (live but making no progress). " +
            "Completed batches are already cached; re-run `git for-ai reindex` to resume. " +
            "GIT_FOR_AI_REINDEX_WATCHDOG_MS adjusts this timeout (0 disables); " +
            "GIT_FOR_AI_DEVICE=cpu forces the CPU backend if the GPU is misbehaving.",
        ),
      );
    }, this.timeoutMs);
  }

  /** A batch landed: re-arm the timer. */
  pet(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.arm();
  }

  /** Stop the timer (always call in finally — a live timer holds the event loop open). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Durable per-user model cache for the transformers.js embedder (judgment call #7).
 * Exported so doctor (M14) can report where the weights live.
 */
export function defaultModelCacheDir(): string {
  const override = process.env["GIT_FOR_AI_MODEL_CACHE"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const localAppData = process.env["LOCALAPPDATA"];
  if (process.platform === "win32" && localAppData !== undefined && localAppData !== "") {
    return join(localAppData, "git-for-ai", "models");
  }
  return join(homedir(), ".cache", "git-for-ai", "models");
}

function toContext(cwd: string): GitContext {
  return { cwd };
}

const short = (sha: string): string => sha.slice(0, 8);

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ─── config.toml reader (judgment call #9) ───────────────────────────────────

/** Init-era defaults, mirrored from init.ts's renderDefaultConfigToml. */
const CONFIG_DEFAULTS: RepoConfig = {
  schema: "git-for-ai/config@1",
  embedder: { provider: "jina-v2-code", dim: 768, offline: true, voyage_consent: false },
  capture: {
    enabled: true,
    never_capture: [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"],
    max_span_bytes: 16384,
  },
  redaction: { ruleset: "builtin@1", extra_patterns: [] },
  index: { hybrid: true },
};

function parseTomlScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted !== null) {
    return quoted[1]!.replace(/\\(.)/g, "$1");
  }
  return null;
}

/**
 * Read `.git-for-ai/config.toml` (init's known flat shape), fill defaults for anything
 * missing, and validate the result against repoConfigSchema. A missing file yields pure
 * defaults; a value the schema rejects (e.g. an unknown embedder provider) throws loudly.
 * Exported for the query-side commands (M12 `ask`/`blame --why` via ./queryDeps.ts),
 * which must read the SAME config the index was built from.
 */
export async function readRepoConfig(gitForAiDir: string): Promise<RepoConfig> {
  const assembled = structuredClone(CONFIG_DEFAULTS) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  let raw: string | null = null;
  try {
    raw = await readFile(join(gitForAiDir, "config.toml"), "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    let section = "";
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped === "" || stripped.startsWith("#")) continue;
      const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped);
      if (sectionMatch !== null) {
        section = sectionMatch[1]!.trim();
        continue;
      }
      const eq = stripped.indexOf("=");
      if (eq === -1 || section !== "embedder") {
        // Only the [embedder] table matters for reindex; the rest keeps defaults.
        continue;
      }
      const key = stripped.slice(0, eq).trim();
      const value = parseTomlScalar(stripped.slice(eq + 1));
      if (value !== null) {
        (assembled["embedder"] as Record<string, unknown>)[key] = value;
      }
    }
  }
  return repoConfigSchema.parse(assembled);
}

// ─── Git tree / diff helpers (NUL-delimited, quoting-proof) ──────────────────

interface TreeBlob {
  path: string;
  sha: string;
}

/** All regular-file blobs (`100644`/`100755`) at a commit, path → blob SHA. */
async function listTreeBlobs(rev: string, ctx: GitContext): Promise<Map<string, string>> {
  const result = await runGit(["ls-tree", "-r", "-z", rev], { ...ctx, stripFinalNewline: false });
  const blobs = new Map<string, string>();
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    // "<mode> <type> <sha>\t<path>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if ((mode === "100644" || mode === "100755") && type === "blob" && sha !== undefined) {
      blobs.set(path, sha);
    }
  }
  return blobs;
}

interface DiffEntry {
  status: string;
  /** Pre-image path (D/M/T, and the old side of R/C). */
  oldPath?: string;
  /** Post-image path (A/M/T, and the new side of R/C). */
  newPath?: string;
}

/** `git diff --name-status -z <base> <head>`, parsed. Renames arrive as delete+add. */
async function diffNameStatus(base: string, head: string, ctx: GitContext): Promise<DiffEntry[]> {
  const result = await runGit(["diff", "--name-status", "-z", "--no-renames", base, head], {
    ...ctx,
    stripFinalNewline: false,
  });
  const fields = result.stdout.split("\0").filter((f) => f !== "");
  const entries: DiffEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]!;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      // Defensive: --no-renames should prevent these, but the -z format for them is
      // <status>\0<old>\0<new>\0 — consume both paths if they ever appear.
      entries.push({ status, oldPath: fields[i + 1], newPath: fields[i + 2] } as DiffEntry);
      i += 3;
    } else {
      const path = fields[i + 1];
      if (kind === "D") {
        entries.push({ status, ...(path !== undefined ? { oldPath: path } : {}) });
      } else if (kind === "A") {
        entries.push({ status, ...(path !== undefined ? { newPath: path } : {}) });
      } else {
        // M, T, U, X... — treat as modify: old + new at the same path.
        entries.push({
          status,
          ...(path !== undefined ? { oldPath: path, newPath: path } : {}),
        });
      }
      i += 2;
    }
  }
  return entries;
}

/** True when file content should be skipped (binary or oversized) — judgment call #5. */
function shouldSkipContent(content: string): boolean {
  return content.length > MAX_INDEXED_FILE_BYTES || content.includes("\u0000");
}

// ─── Content-kind collectors ─────────────────────────────────────────────────

/** A chunk ready for cache-aware embedding, paired with its final store item shape. */
interface PendingItem {
  chunk: CacheableChunk;
  item: Omit<VectorStoreItem, "vector">;
}

/** Chunk one file's blob into pending code items. */
async function collectFileItems(path: string, blobSha: string, ctx: GitContext): Promise<PendingItem[]> {
  const content = await catFile(blobSha, ctx);
  if (shouldSkipContent(content)) {
    return [];
  }
  const chunks = await chunkSourceFile(path, content, { maxChunkChars: REINDEX_MAX_CHUNK_CHARS });
  return chunks.map((chunk) => ({
    chunk: { text: chunk.text, blobSha, nodePath: chunk.nodePath },
    item: {
      key: `${blobSha}:${chunk.nodePath}`,
      kind: "code",
      text: chunk.text,
      path,
      blobSha,
      nodePath: chunk.nodePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    },
  }));
}

/** Reconstruct the keys a file's OLD blob would have produced (judgment call #4). */
async function oldKeysForBlob(path: string, blobSha: string, ctx: GitContext): Promise<string[]> {
  const content = await catFile(blobSha, ctx);
  if (shouldSkipContent(content)) {
    return [];
  }
  // Same window size as collectFileItems, or reconstructed keys would not match.
  const chunks = await chunkSourceFile(path, content, { maxChunkChars: REINDEX_MAX_CHUNK_CHARS });
  return chunks.map((chunk) => `${blobSha}:${chunk.nodePath}`);
}

/** The text embedded for a ledger entry: summary + reasoning (§11.1 kind 2). */
function ledgerText(entry: LedgerEntry): string {
  const parts = [entry.summary];
  const reasoning = entry.reasoning;
  if (reasoning?.intent !== undefined) parts.push(`Intent: ${reasoning.intent}`);
  if (reasoning?.constraints !== undefined && reasoning.constraints.length > 0) {
    parts.push(`Constraints: ${reasoning.constraints.join("; ")}`);
  }
  for (const rejected of reasoning?.rejected ?? []) {
    parts.push(`Rejected: ${rejected.option} — ${rejected.why}`);
  }
  if (reasoning?.directive !== undefined) parts.push(`Directive: ${reasoning.directive}`);
  if (reasoning?.tested !== undefined && reasoning.tested.length > 0) {
    parts.push(`Tested: ${reasoning.tested.join("; ")}`);
  }
  return parts.join("\n");
}

/**
 * Effective ledger entry per non-absorbed change (judgment calls #1/#2), plus a
 * session_ref → change_id join map for the session items.
 */
async function collectLedgerItems(
  ctx: GitContext,
  warnings: string[],
): Promise<{ pending: PendingItem[]; sessionOwner: Map<string, string> }> {
  const pending: PendingItem[] = [];
  const sessionOwner = new Map<string, string>();
  const noteOpts: LedgerNoteOptions = { ...ctx };

  for (const mapEntry of await readAllChangeMapEntries(ctx)) {
    if (mapEntry.folded_into !== undefined) {
      continue; // absorbed by a squash; the surviving change's ledger covers it
    }
    const shas = [...new Set([...mapEntry.history, mapEntry.head])];
    const seen = new Set<string>();
    const entries: LedgerEntry[] = [];
    for (const sha of shas) {
      let read: LedgerEntry[] | null;
      try {
        read = await readLedgerEntries(sha, noteOpts);
      } catch (error) {
        if (error instanceof LedgerNoteFormatError) {
          warnings.push(`ledger note on commit ${short(sha)} is unreadable: ${error.message}`);
          continue;
        }
        throw error;
      }
      for (const entry of read ?? []) {
        const canonical = canonicalJsonStringify(entry);
        if (!seen.has(canonical)) {
          seen.add(canonical);
          entries.push(entry);
        }
        if (entry.session_ref !== undefined && entry.session_ref !== null) {
          sessionOwner.set(entry.session_ref, entry.change_id);
        }
      }
    }
    if (entries.length === 0) {
      continue; // change exists but has no captured intent — nothing to embed
    }
    const effective = resolveEffectiveEntry(entries);
    const text = ledgerText(effective);
    pending.push({
      chunk: { text, blobSha: sha256hex(canonicalJsonStringify(effective)), nodePath: "ledger" },
      item: {
        key: `ledger:${effective.change_id}`,
        kind: "ledger",
        text,
        changeId: effective.change_id,
        ...(effective.session_ref !== undefined && effective.session_ref !== null
          ? { sessionRef: effective.session_ref }
          : {}),
      },
    });
  }
  return { pending, sessionOwner };
}

/** Deterministic fallback text for a session record without a summary (judgment #6). */
function sessionFallbackText(record: {
  agent: { tool: string; model: string };
  session_id: string;
  spans: Array<{ kind: string; name?: string | undefined }>;
}): string {
  const names = [
    ...new Set(record.spans.map((span) => span.name ?? span.kind)),
  ].slice(0, 20);
  return (
    `Agent session (${record.agent.tool}, ${record.agent.model}) ${record.session_id}: ` +
    `${record.spans.length} spans` +
    (names.length > 0 ? ` — ${names.join(", ")}` : "")
  );
}

/** One item per stored session record under refs/git-for-ai/sessions (§11.1 kind 3). */
async function collectSessionItems(
  ctx: GitContext,
  sessionOwner: Map<string, string>,
  warnings: string[],
): Promise<PendingItem[]> {
  const commit = await readSessionsCommit(ctx);
  if (commit === null) {
    return [];
  }
  const pending: PendingItem[] = [];
  for (const treeEntry of await lsTree(commit, { ...ctx, recursive: true })) {
    if (treeEntry.type !== "blob") continue;
    const contentHash = treeEntry.path.replace(/\.json$/, "").replace("/", "");
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      warnings.push(`unrecognized object in sessions ref: ${treeEntry.path} (skipped)`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await catFile(treeEntry.sha, ctx));
    } catch {
      warnings.push(`session object ${treeEntry.path} is not valid JSON (skipped)`);
      continue;
    }
    const record = sessionRecordSchema.safeParse(parsed);
    if (!record.success) {
      warnings.push(`session object ${treeEntry.path} does not match the session schema (skipped)`);
      continue;
    }
    const sessionRef = `sha256:${contentHash}`;
    const text = record.data.summary ?? sessionFallbackText(record.data);
    const changeId = sessionOwner.get(sessionRef);
    pending.push({
      chunk: { text, blobSha: treeEntry.sha, nodePath: "session" },
      item: {
        key: `session:${contentHash}`,
        kind: "session",
        text,
        sessionRef,
        ...(changeId !== undefined ? { changeId } : {}),
      },
    });
  }
  return pending;
}

/**
 * Embed pending items through the cache and upsert them, in EMBED_BATCH-sized batches
 * (judgment call #10): cache files and store rows land after every batch, so progress
 * is observable and a killed run resumes nearly free. Batches are length-sorted so the
 * embedder pads less. Returns the aggregated kind counts.
 */
async function embedAndUpsert(
  label: string,
  pending: PendingItem[],
  embedder: Embedder,
  cache: EmbeddingCache,
  store: SqliteVectorStore,
  onProgress?: (line: string) => void,
  watchdog?: BatchWatchdog,
): Promise<KindCounts> {
  if (pending.length === 0) {
    return { indexed: 0, reused: 0, embedded: 0 };
  }
  const ordered = [...pending].sort((a, b) => a.chunk.text.length - b.chunk.text.length);
  let reused = 0;
  let embedded = 0;
  for (let offset = 0; offset < ordered.length; offset += EMBED_BATCH) {
    const batch = ordered.slice(offset, offset + EMBED_BATCH);
    const { vectors, hits, misses } = await embedChunksWithCache(
      embedder,
      cache,
      batch.map((p) => p.chunk),
    );
    store.upsert(batch.map((p, i) => ({ ...p.item, vector: vectors[i]! })));
    watchdog?.pet();
    reused += hits;
    embedded += misses;
    const done = Math.min(offset + EMBED_BATCH, ordered.length);
    if (onProgress !== undefined && (misses > 0 || done === ordered.length)) {
      onProgress(`${label}: ${done}/${ordered.length} chunks (${reused} reused, ${embedded} embedded)`);
    }
  }
  return { indexed: pending.length, reused, embedded };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function countLine(label: string, counts: KindCounts, showSplit: boolean): string {
  const base = `  ${`${label}:`.padEnd(18)}${String(counts.indexed).padStart(6)}`;
  if (!showSplit || counts.indexed === 0) {
    return base;
  }
  return `${base}  (${counts.reused} reused from embcache, ${counts.embedded} embedded)`;
}

function render(data: ReindexData): string {
  const lines: string[] = [];
  const modeText =
    data.mode === "full"
      ? "Re-embedding from scratch."
      : data.mode === "initial"
        ? "First index of this repository."
        : `Incremental since ${short(data.baseCommit ?? "")}.`;
  lines.push(`Embedder ${data.modelFingerprint}. ${modeText}`);
  lines.push(countLine("code chunks", data.code, true));
  lines.push(countLine("ledger entries", data.ledger, false));
  lines.push(countLine("session summaries", data.sessions, false));
  if (data.code.filesSkipped > 0) {
    lines.push(
      `  (${data.code.filesSkipped} binary/oversized file${data.code.filesSkipped === 1 ? "" : "s"} skipped)`,
    );
  }
  const verb = data.mode === "incremental" ? (data.upToDate ? "current" : "updated") : "rebuilt";
  lines.push(
    `✓ index ${verb} at ${INDEX_DB_RELPATH}  (last_indexed_commit ${short(data.headCommit)})`,
  );
  for (const warning of data.warnings) {
    lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

function renderVerify(data: ReindexData): string {
  const lines = [`index verify: ${INDEX_DB_RELPATH}  (embedder ${data.modelFingerprint})`];
  const verify = data.verify!;
  if (verify.current) {
    lines.push(`✓ index is consistent and current  (${data.totalChunks} chunks, HEAD ${short(data.headCommit)})`);
  } else {
    for (const problem of verify.problems) {
      lines.push(`  ✗ ${problem}`);
    }
    lines.push("Run `git for-ai reindex` (or `reindex --full` after a model change) to repair.");
  }
  return lines.join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * `git for-ai reindex`: rebuild the local vector cache from git-native truth.
 * Pure logic, no console I/O — bin.ts prints `result.output`.
 */
export async function runReindex(options: ReindexOptions = {}): Promise<ReindexResult> {
  const cwd = options.cwd ?? process.cwd();
  const ctx = toContext(cwd);
  const warnings: string[] = [];

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (toplevel.exitCode !== 0) {
    throw new Error(`not a git repository (or any parent up to mount point): ${cwd}`);
  }
  const repoRoot = resolve(toplevel.stdout);
  const gitForAiDir = join(repoRoot, ".git-for-ai");
  if (!existsSync(gitForAiDir)) {
    throw new Error(
      "this repository is not initialized for git-for-ai — run `git for-ai init` first",
    );
  }

  const headResult = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    ...ctx,
    allowFailure: true,
  });
  if (headResult.exitCode !== 0 || headResult.stdout.length === 0) {
    throw new Error("repository has no commits yet — nothing to index");
  }
  const headCommit = headResult.stdout;

  // Embedder: injected (tests) or from config.toml (real transformers.js / Voyage).
  const config = await readRepoConfig(gitForAiDir);
  const embedder =
    options.embedder ??
    createEmbedderFromConfig(config, {
      transformersCacheDir: defaultModelCacheDir(),
      ...(process.env["VOYAGE_API_KEY"] !== undefined
        ? { voyageApiKey: process.env["VOYAGE_API_KEY"] }
        : {}),
    });
  // Effective precision folds into the fingerprint (judgment call #11a): fp16-GPU and
  // int8-CPU vectors must never mix. q8/undefined maps to the legacy bare form.
  const fingerprint =
    options.embedder !== undefined
      ? modelFingerprint(embedder.id, embedder.dim, embedder.precision)
      : modelFingerprint(config.embedder.provider, embedder.dim, embedder.precision);

  // Make the resolved device visible up front — a CPU fallback must never be silent.
  const deviceInfo = embedder as Partial<{ device: string; dtype: string; deviceReason: string }>;
  if (typeof deviceInfo.device === "string" && typeof deviceInfo.dtype === "string") {
    options.onProgress?.(
      `embedder ${fingerprint}: device ${deviceInfo.device}, weights ${deviceInfo.dtype}` +
        (typeof deviceInfo.deviceReason === "string" ? ` (${deviceInfo.deviceReason})` : ""),
    );
  }

  const indexDbPath = join(gitForAiDir, "index.db");

  // ── --verify: read-only consistency check, never rebuilds ──
  if (options.verify === true) {
    return verifyIndex({ gitForAiDir, indexDbPath, fingerprint, headCommit, ctx });
  }

  // ── Determine mode + incremental base ──
  const full = options.full === true;
  let state = null;
  try {
    state = await readIndexState(gitForAiDir);
  } catch (error) {
    if (!(error instanceof IndexStateFormatError) || !full) {
      throw error;
    }
    // --full is the recovery path: an unreadable state.json is rebuilt below.
    warnings.push(`state.json was unreadable and has been rebuilt (${error.message})`);
  }

  let baseCommit: string | null = null;
  let mode: ReindexData["mode"] = full ? "full" : "initial";
  if (!full) {
    const candidate = options.since ?? state?.last_indexed_commit ?? null;
    if (candidate !== null) {
      const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
        ...ctx,
        allowFailure: true,
      });
      if (resolved.exitCode === 0 && resolved.stdout.length > 0) {
        baseCommit = resolved.stdout;
        mode = "incremental";
      } else {
        warnings.push(
          `previous base commit ${candidate} no longer exists — rebuilding from scratch`,
        );
        mode = "initial";
      }
    }
  }

  // --full drops the index database (embcache is deliberately KEPT — see header).
  if (full) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${indexDbPath}${suffix}`, { force: true });
    }
  }

  // May throw IndexFingerprintError: model/schema changed since the index was built.
  // That is deliberate — the caller retries with --full (the documented recovery path).
  const store = SqliteVectorStore.open({
    path: indexDbPath,
    dim: embedder.dim,
    modelFingerprint: fingerprint,
  });

  try {
    const cache = new EmbeddingCache({
      dir: join(gitForAiDir, "embcache"),
      modelFingerprint: fingerprint,
      dim: embedder.dim,
    });

    // ── Kind 1: code chunks (diff-driven when incremental) ──
    const headBlobs = await listTreeBlobs(headCommit, ctx);
    const codePending: PendingItem[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let staleKeysDeleted = 0;

    if (baseCommit === null) {
      for (const [path, blobSha] of headBlobs) {
        const items = await collectFileItems(path, blobSha, ctx);
        if (items.length === 0) {
          filesSkipped += 1;
        } else {
          filesIndexed += 1;
          codePending.push(...items);
        }
      }
    } else if (baseCommit !== headCommit) {
      const baseBlobs = await listTreeBlobs(baseCommit, ctx);
      const headBlobSet = new Set(headBlobs.values());
      const staleKeys: string[] = [];
      for (const entry of await diffNameStatus(baseCommit, headCommit, ctx)) {
        // Post-image: (re-)chunk and upsert.
        if (entry.newPath !== undefined) {
          const blobSha = headBlobs.get(entry.newPath);
          if (blobSha !== undefined) {
            const items = await collectFileItems(entry.newPath, blobSha, ctx);
            if (items.length === 0) {
              filesSkipped += 1;
            } else {
              filesIndexed += 1;
              codePending.push(...items);
            }
          }
        }
        // Pre-image: reconstruct and delete stale keys (unless the blob survives
        // elsewhere in the HEAD tree — see judgment call #4).
        if (entry.oldPath !== undefined) {
          const oldBlob = baseBlobs.get(entry.oldPath);
          if (oldBlob !== undefined && !headBlobSet.has(oldBlob)) {
            staleKeys.push(...(await oldKeysForBlob(entry.oldPath, oldBlob, ctx)));
          }
        }
      }
      if (staleKeys.length > 0) {
        store.deleteByKeys(staleKeys);
        staleKeysDeleted = staleKeys.length;
      }
    }
    const onProgress = options.onProgress;
    // Judgment call #11b: race every embedding phase against a no-progress watchdog.
    const watchdog = new BatchWatchdog(watchdogTimeoutMs());
    let codeCounts: KindCounts;
    let ledgerCounts: KindCounts;
    let sessionCounts: KindCounts;
    // If the watchdog fires, the stuck work promise is orphaned; register a noop catch
    // so its eventual rejection (e.g. upsert on a closed store) is never "unhandled".
    const raced = (work: Promise<KindCounts>): Promise<KindCounts> => {
      work.catch(() => {});
      return Promise.race([work, watchdog.promise]);
    };
    try {
      codeCounts = await raced(
        embedAndUpsert("code", codePending, embedder, cache, store, onProgress, watchdog),
      );

      // ── Kinds 2 + 3: ledger entries and session summaries (always full-swept) ──
      const { pending: ledgerPending, sessionOwner } = await collectLedgerItems(ctx, warnings);
      ledgerCounts = await raced(
        embedAndUpsert("ledger", ledgerPending, embedder, cache, store, onProgress, watchdog),
      );

      const sessionPending = await collectSessionItems(ctx, sessionOwner, warnings);
      sessionCounts = await raced(
        embedAndUpsert("sessions", sessionPending, embedder, cache, store, onProgress, watchdog),
      );
    } finally {
      watchdog.dispose();
    }

    // ── Bookkeeping (DATA_MODEL.md §5.1) ──
    const totalChunks = store.count();
    await updateIndexState(gitForAiDir, {
      last_indexed_commit: headCommit,
      model_fingerprint: fingerprint,
      vec_schema_version: VEC_SCHEMA_VERSION,
      chunk_count: totalChunks,
    });

    const upToDate =
      mode === "incremental" &&
      codeCounts.embedded + ledgerCounts.embedded + sessionCounts.embedded === 0 &&
      staleKeysDeleted === 0;

    const data: ReindexData = {
      mode,
      modelFingerprint: fingerprint,
      headCommit,
      baseCommit,
      code: { ...codeCounts, filesIndexed, filesSkipped, staleKeysDeleted },
      ledger: ledgerCounts,
      sessions: sessionCounts,
      totalChunks,
      indexPath: INDEX_DB_RELPATH,
      upToDate,
      warnings,
    };
    return { data, output: render(data) };
  } finally {
    store.close();
  }
}

// ─── --verify ────────────────────────────────────────────────────────────────

async function verifyIndex(params: {
  gitForAiDir: string;
  indexDbPath: string;
  fingerprint: string;
  headCommit: string;
  ctx: GitContext;
}): Promise<ReindexResult> {
  const { gitForAiDir, indexDbPath, fingerprint, headCommit } = params;
  const problems: string[] = [];
  let totalChunks = 0;

  let state = null;
  try {
    state = await readIndexState(gitForAiDir);
  } catch (error) {
    problems.push(
      `state.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (state === null && problems.length === 0) {
    problems.push("state.json does not exist — the index has never been built");
  }
  if (state !== null && state.model_fingerprint !== fingerprint) {
    problems.push(
      `state.json fingerprint ${state.model_fingerprint} does not match the configured embedder ` +
        `${fingerprint} — run \`git for-ai reindex --full\``,
    );
  }

  try {
    const store = SqliteVectorStore.open({
      path: indexDbPath,
      // dim from state when available so a config/db mismatch is reported, not masked.
      dim: typeof state?.["dim"] === "number" ? (state["dim"] as number) : parseDim(fingerprint),
      modelFingerprint: fingerprint,
    });
    try {
      totalChunks = store.count();
      if (state !== null && state.chunk_count !== totalChunks) {
        problems.push(
          `state.json records ${state.chunk_count} chunks but index.db holds ${totalChunks}`,
        );
      }
    } finally {
      store.close();
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (state !== null && state.last_indexed_commit !== headCommit) {
    problems.push(
      `index is stale: last_indexed_commit ${state.last_indexed_commit === null ? "(none)" : short(state.last_indexed_commit)} ` +
        `!= HEAD ${short(headCommit)} — run \`git for-ai reindex\``,
    );
  }

  const data: ReindexData = {
    mode: "verify",
    modelFingerprint: fingerprint,
    headCommit,
    baseCommit: null,
    code: { indexed: 0, reused: 0, embedded: 0, filesIndexed: 0, filesSkipped: 0, staleKeysDeleted: 0 },
    ledger: { indexed: 0, reused: 0, embedded: 0 },
    sessions: { indexed: 0, reused: 0, embedded: 0 },
    totalChunks,
    indexPath: INDEX_DB_RELPATH,
    upToDate: problems.length === 0,
    warnings: [],
    verify: { current: problems.length === 0, problems },
  };
  return { data, output: renderVerify(data) };
}

function parseDim(fingerprint: string): number {
  // `<provider>/<dim>` or `<provider>/<dim>/<precision>` — dim is always segment 1.
  const dim = Number(fingerprint.split("/")[1]);
  return Number.isFinite(dim) && dim > 0 ? dim : 768;
}

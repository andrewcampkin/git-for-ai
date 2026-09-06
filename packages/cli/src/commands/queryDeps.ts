// Shared query-side dependency opener for `ask` / `blame --why` (and the
// review server's /api/ask): opens the SAME config/store/fingerprint surface that
// reindex.ts owns on the write side, but builds the QUERY-side embedder via the query engine's
// `createQueryEmbedderFromConfig` (the Voyage path embeds queries with input_type
// "query"; the offline transformers path is symmetric and delegated as-is).
//
// ── Judgment calls ──
// 1. "Index built" is judged from `state.json`'s `last_indexed_commit` (DATA_MODEL.md
//    §5.1), not from `index.db`'s existence — init stubs index.db as an empty file, so
//    file existence proves nothing. Missing/never-run state is an ACTIONABLE error
//    naming `git for-ai reindex`.
// 2. A fingerprint mismatch (config/model changed since the index was built) is an error
//    naming `git for-ai reindex --full` — the documented recovery path — whether it is
//    detected via state.json or via the store's own IndexFingerprintError.
// 3. A STALE index (last_indexed_commit != HEAD) is a WARNING carried on the handle, not
//    an error: stale retrieval is still genuinely useful, and the caller surfaces the
//    warning next to its answer so the degradation is visible, never silent.
// 4. `embedder`/`fingerprint` are injectable: tests inject a deterministic fake (the
//    real model is never loaded in tests), and the review server injects its cached
//    embedder so the model is loaded once per process, not once per request.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  runGit,
  modelFingerprint,
  readIndexState,
  IndexFingerprintError,
  IndexStateFormatError,
  SqliteVectorStore,
  createQueryEmbedderFromConfig,
  type Embedder,
  type GitContext,
} from "@git-for-ai/core";

import { defaultModelCacheDir, readRepoConfig } from "./reindex.js";

/** Options for {@link openQueryDeps}. */
export interface OpenQueryDepsOptions {
  /** Repository to operate on. Defaults to the current process cwd. */
  cwd?: string;
  /**
   * Injectable embedding provider (tests: a deterministic fake; review server: the
   * process-cached instance). When absent the query embedder comes from config.toml.
   */
  embedder?: Embedder;
  /**
   * Fingerprint override, paired with an injected `embedder` whose instance was built
   * from config (so `<id>/<dim>` would misrepresent it). Defaults to
   * `<embedder.id>/<dim>` for injected embedders, `<provider>/<dim>` otherwise —
   * matching reindex.ts exactly.
   */
  fingerprint?: string;
}

/** An opened query surface: the store + embedder `askQuestion`/`explainLine` need. */
export interface QueryDeps {
  store: SqliteVectorStore;
  embedder: Embedder;
  /** Fingerprint the store was verified against. */
  fingerprint: string;
  /** Git context rooted at the repository toplevel. */
  ctx: GitContext;
  /** Absolute worktree toplevel. */
  repoRoot: string;
  /** Non-fatal notices (index staleness) to surface alongside the answer. */
  warnings: string[];
  close(): void;
}

const short = (sha: string): string => sha.slice(0, 8);

/**
 * Open the query dependencies for a repository, with actionable errors for every
 * not-ready state (uninitialized → `init`; never indexed → `reindex`; model changed →
 * `reindex --full`) and a staleness warning when HEAD has moved past the index.
 */
export async function openQueryDeps(options: OpenQueryDepsOptions = {}): Promise<QueryDeps> {
  const cwd = options.cwd ?? process.cwd();

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (toplevel.exitCode !== 0) {
    throw new Error(`not a git repository (or any parent up to mount point): ${cwd}`);
  }
  const repoRoot = resolve(toplevel.stdout);
  const ctx: GitContext = { cwd: repoRoot };
  const gitForAiDir = join(repoRoot, ".git-for-ai");
  if (!existsSync(gitForAiDir)) {
    throw new Error(
      "this repository is not initialized for git-for-ai — run `git for-ai init` first",
    );
  }

  // Judgment call #1: state.json is the authority on whether an index exists.
  let state;
  try {
    state = await readIndexState(gitForAiDir);
  } catch (error) {
    if (error instanceof IndexStateFormatError) {
      throw new Error(
        `the index state file is unreadable (${error.message}) — ` +
          "run `git for-ai reindex --full` to rebuild the index",
      );
    }
    throw error;
  }
  if (state === null || state.last_indexed_commit === null) {
    throw new Error(
      "the local index has not been built yet — run `git for-ai reindex` first",
    );
  }

  const indexDbPath = join(gitForAiDir, "index.db");
  if (!existsSync(indexDbPath)) {
    throw new Error(
      "the index database (.git-for-ai/index.db) is missing — run `git for-ai reindex` to rebuild it",
    );
  }

  const config = await readRepoConfig(gitForAiDir);
  const embedder =
    options.embedder ??
    createQueryEmbedderFromConfig(config, {
      transformersCacheDir: defaultModelCacheDir(),
      ...(process.env["VOYAGE_API_KEY"] !== undefined
        ? { voyageApiKey: process.env["VOYAGE_API_KEY"] }
        : {}),
    });
  const fingerprint =
    options.fingerprint ??
    (options.embedder !== undefined
      ? modelFingerprint(embedder.id, embedder.dim, embedder.precision)
      : modelFingerprint(config.embedder.provider, embedder.dim, embedder.precision));

  // Judgment call #2: cross-check state.json before touching the db, so the mismatch
  // message can name both sides.
  if (state.model_fingerprint !== fingerprint) {
    throw new Error(
      `the index was built with embedder ${state.model_fingerprint}, but the configured ` +
        `embedder is ${fingerprint} — run \`git for-ai reindex --full\` to rebuild`,
    );
  }

  let store: SqliteVectorStore;
  try {
    store = SqliteVectorStore.open({
      path: indexDbPath,
      dim: embedder.dim,
      modelFingerprint: fingerprint,
    });
  } catch (error) {
    if (error instanceof IndexFingerprintError) {
      throw new Error(`${error.message} — run \`git for-ai reindex --full\` to rebuild`);
    }
    throw error;
  }

  // Judgment call #3: staleness is a warning, never a refusal.
  const warnings: string[] = [];
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    ...ctx,
    allowFailure: true,
  });
  if (head.exitCode === 0 && head.stdout.length > 0 && state.last_indexed_commit !== head.stdout) {
    warnings.push(
      `the index is stale (last indexed ${short(state.last_indexed_commit)}, HEAD ` +
        `${short(head.stdout)}) — recent changes may be missing; run \`git for-ai reindex\``,
    );
  }

  return {
    store,
    embedder,
    fingerprint,
    ctx,
    repoRoot,
    warnings,
    close: () => store.close(),
  };
}

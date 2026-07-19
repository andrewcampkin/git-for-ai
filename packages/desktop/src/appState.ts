// Persisted desktop app state — recent repos, last-opened repo, window bounds — as PURE
// logic split from Electron so vitest can exercise it directly (no Electron import here;
// main.ts injects the file path from app.getPath("userData")).
//
// Judgment calls:
//   1. A missing or corrupt state file yields the default state instead of an error. This
//      file is a convenience cache, not data — bricking app launch over it would be the
//      wrong kind of strictness. Nothing is fabricated: we simply start fresh, and the
//      honest-degradation rule (CLAUDE.md #5) concerns *repo* data, which never lives here.
//   2. Recent-repo paths are deduped case-insensitively on Windows (injectable for tests):
//      the same repo picked twice via different casing is one repo, not two.
//   3. The list is capped at 10 — this is a picker, not a history.
//   4. Writes are synchronous (`writeFileSync`): they happen on app shutdown and after a
//      repo switch, where an in-flight async write racing process exit could lose state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const APP_STATE_SCHEMA = "git-for-ai/desktop-state@1";
export const MAX_RECENT_REPOS = 10;

export interface RecentRepo {
  /** Absolute repo-root path as last opened. */
  path: string;
  /** ISO timestamp of the last open (ordering is by list position; this is display data). */
  lastOpenedAt: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppState {
  schema: typeof APP_STATE_SCHEMA;
  /** Most-recently-opened first, capped at {@link MAX_RECENT_REPOS}. */
  recentRepos: RecentRepo[];
  /** The repo to reopen on next launch, or null when the picker should show. */
  lastRepo: string | null;
  /** Remembered window bounds, or null before the first close. */
  windowBounds: WindowBounds | null;
}

export function defaultAppState(): AppState {
  return { schema: APP_STATE_SCHEMA, recentRepos: [], lastRepo: null, windowBounds: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a serialized state file. Anything unrecognizable — bad JSON, wrong schema tag,
 * malformed entries — degrades to the default state (judgment call #1); individually
 * malformed recent entries are dropped rather than poisoning the rest.
 */
export function parseAppState(raw: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultAppState();
  }
  if (!isObject(parsed) || parsed["schema"] !== APP_STATE_SCHEMA) {
    return defaultAppState();
  }

  const recentRepos: RecentRepo[] = [];
  const list = parsed["recentRepos"];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (
        isObject(entry) &&
        typeof entry["path"] === "string" &&
        typeof entry["lastOpenedAt"] === "string"
      ) {
        recentRepos.push({ path: entry["path"], lastOpenedAt: entry["lastOpenedAt"] });
      }
    }
  }

  const lastRepo = typeof parsed["lastRepo"] === "string" ? parsed["lastRepo"] : null;

  const boundsRaw = parsed["windowBounds"];
  const windowBounds =
    isObject(boundsRaw) &&
    typeof boundsRaw["x"] === "number" &&
    typeof boundsRaw["y"] === "number" &&
    typeof boundsRaw["width"] === "number" &&
    typeof boundsRaw["height"] === "number"
      ? {
          x: boundsRaw["x"],
          y: boundsRaw["y"],
          width: boundsRaw["width"],
          height: boundsRaw["height"],
        }
      : null;

  return {
    schema: APP_STATE_SCHEMA,
    recentRepos: recentRepos.slice(0, MAX_RECENT_REPOS),
    lastRepo,
    windowBounds,
  };
}

export interface TouchRecentOptions {
  /** Timestamp source (tests pin it). Default: `new Date()`. */
  now?: Date;
  /** Path-compare case sensitivity. Default: case-insensitive on win32 (judgment call #2). */
  caseInsensitive?: boolean;
}

/**
 * Record `repoPath` as the most recently opened repo (immutable — returns a new state):
 * moves/inserts it at the front, dedupes against existing entries, caps the list, and
 * sets `lastRepo`.
 */
export function touchRecent(
  state: AppState,
  repoPath: string,
  options: TouchRecentOptions = {},
): AppState {
  const now = options.now ?? new Date();
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
  const path = resolve(repoPath);
  const toKey = (p: string): string => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p));
  const key = toKey(path);

  const kept = state.recentRepos.filter((entry) => toKey(entry.path) !== key);
  return {
    ...state,
    lastRepo: path,
    recentRepos: [{ path, lastOpenedAt: now.toISOString() }, ...kept].slice(0, MAX_RECENT_REPOS),
  };
}

/** Immutable bounds update (main.ts calls this on window close). */
export function withWindowBounds(state: AppState, bounds: WindowBounds): AppState {
  return { ...state, windowBounds: { ...bounds } };
}

/** Load state from `filePath`; a missing or unreadable file is the default state. */
export function loadAppState(filePath: string): AppState {
  if (!existsSync(filePath)) {
    return defaultAppState();
  }
  try {
    return parseAppState(readFileSync(filePath, "utf8"));
  } catch {
    return defaultAppState();
  }
}

/** Persist state as pretty-printed JSON (creates the parent directory if needed). */
export function saveAppState(filePath: string, state: AppState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

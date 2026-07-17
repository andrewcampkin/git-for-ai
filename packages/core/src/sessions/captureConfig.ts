// Defensive read of the capture-relevant subset of `.git-for-ai/config.toml`
// (DATA_MODEL.md §5): `capture.enabled`, `capture.never_capture`,
// `capture.max_span_bytes`, and `redaction.extra_patterns`.
//
// Why a hand-rolled reader instead of a TOML dependency: the monorepo has no TOML
// parser and this milestone adds no new dependencies. The file is WRITTEN by our own
// `init` in a known, flat `key = value` / single-line-array shape, so a small
// line-based reader covers everything init can produce. Anything it cannot understand
// degrades to the documented defaults — config parsing must never break capture.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_MAX_SPAN_BYTES } from "./redaction.js";

/** The capture-relevant configuration, post-defaults. */
export interface CaptureSettings {
  /** The per-repo opt-in switch. Default true (init writes true; see judgment note below). */
  enabled: boolean;
  /** `never_capture` ignore-globs. */
  neverCapture: string[];
  /** Span-body size cap in bytes. */
  maxSpanBytes: number;
  /** User-added redaction regex sources (`redaction.extra_patterns`). */
  extraPatterns: string[];
}

/** DATA_MODEL.md §5 defaults, used when config.toml is absent or unreadable. */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  // Judgment call: capture opt-in (§13) is enforced by the hooks only existing after
  // `init` has run — a missing config.toml therefore means "init-era defaults", not
  // "capture off". An EXPLICIT `enabled = false` in the file always wins.
  enabled: true,
  neverCapture: [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"],
  maxSpanBytes: DEFAULT_MAX_SPAN_BYTES,
  extraPatterns: [],
};

/** Parse a single-line TOML string array: `["a", "b"]`. Null when not that shape. */
function parseStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const out: string[] = [];
  // Items are quoted strings separated by commas; init writes double quotes only.
  const itemPattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(inner)) !== null) {
    const value = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]!;
    out.push(value);
  }
  return out.length > 0 || inner === "" ? out : null;
}

function parseScalar(raw: string): string | number | boolean | null {
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
 * Read the capture settings from `<repoRoot>/.git-for-ai/config.toml`, defaulting any
 * missing/unparseable piece. Never throws.
 */
export async function readCaptureSettings(repoRoot: string): Promise<CaptureSettings> {
  const settings: CaptureSettings = {
    ...DEFAULT_CAPTURE_SETTINGS,
    neverCapture: [...DEFAULT_CAPTURE_SETTINGS.neverCapture],
    extraPatterns: [...DEFAULT_CAPTURE_SETTINGS.extraPatterns],
  };

  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".git-for-ai", "config.toml"), "utf8");
  } catch {
    return settings;
  }

  try {
    let section = "";
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped === "" || stripped.startsWith("#")) {
        continue;
      }
      const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped);
      if (sectionMatch !== null) {
        section = sectionMatch[1]!.trim();
        continue;
      }
      const eq = stripped.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = stripped.slice(0, eq).trim();
      const value = stripped.slice(eq + 1);

      if (section === "capture" && key === "enabled") {
        const parsed = parseScalar(value);
        if (typeof parsed === "boolean") settings.enabled = parsed;
      } else if (section === "capture" && key === "never_capture") {
        const parsed = parseStringArray(value);
        if (parsed !== null) settings.neverCapture = parsed;
      } else if (section === "capture" && key === "max_span_bytes") {
        const parsed = parseScalar(value);
        if (typeof parsed === "number" && parsed > 0) settings.maxSpanBytes = parsed;
      } else if (section === "redaction" && key === "extra_patterns") {
        const parsed = parseStringArray(value);
        if (parsed !== null) settings.extraPatterns = parsed;
      }
    }
  } catch {
    // Fall through with whatever was parsed so far (or pure defaults).
  }

  return settings;
}

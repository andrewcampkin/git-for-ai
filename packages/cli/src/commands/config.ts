// `git for-ai config <get|set> <key> [value]` — read/write `.git-for-ai/config.toml`
// (CLI_REFERENCE `config`; DATA_MODEL.md §5). The file is local, never synced, and is
// written by our own `init` in a known flat shape (top-level `schema` plus four flat
// tables), which keeps a dependency-free line-based TOML treatment honest — the same
// deliberate idiom as reindex.ts judgment call #9.
//
// ── Judgment calls (where the docs are loose, decided + documented here) ──
//
// 1. `get` returns the EFFECTIVE value: the file merged over init's defaults and
//    validated through repoConfigSchema — i.e. exactly what reindex/ask/capture will
//    actually use — rather than a raw file lookup. A key the schema doesn't know is an
//    error, not an empty print.
// 2. `set` edits the file TEXTUALLY: the matching `key = ...` line inside the right
//    `[section]` is replaced in place, so user comments and unknown keys survive. A
//    missing key is appended to its section; a missing section is appended to the file.
//    Before anything is written, the WHOLE resulting config is re-assembled and
//    validated against repoConfigSchema — an invalid value writes nothing.
// 3. Value coercion follows the schema's target type: booleans accept true/false,
//    numbers accept integers, string-array keys (`capture.never_capture`,
//    `redaction.extra_patterns`) accept a JSON-style array literal (`'["a","b"]'`),
//    everything else is a string. The `schema` key is read-only (it versions the file
//    format itself).
// 4. The Voyage consent flow (CLI_REFERENCE `config`, ARCHITECTURE §14): setting
//    `embedder.provider` to an API provider prompts for the literal words `i accept`
//    (via an injectable `promptConsent`, so bin.ts owns the TTY read and tests inject
//    answers). Non-TTY invocations (no prompt available) require the explicit
//    `--accept-consent` flag. Declining writes NOTHING. Granting records
//    `voyage_consent = true` alongside provider/dim/offline in one atomic rewrite.
//    Consent already on record (`voyage_consent = true`) is not re-prompted.
// 5. Setting `embedder.provider` also updates `embedder.dim` and `embedder.offline`
//    from the same metadata table `init` uses (EMBEDDERS) — a provider whose recorded
//    dim disagreed with reality would poison the index fingerprint. The success output
//    always points at `git for-ai reindex --full`, the documented recovery path.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { runGit } from "@git-for-ai/core";
import { repoConfigSchema, type EmbedderProvider, type RepoConfig } from "@git-for-ai/schemas";

import { EMBEDDERS } from "./init.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ConfigOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--accept-consent` — grant the API-provider consent non-interactively. */
  acceptConsent?: boolean;
  /**
   * Interactive consent reader (bin.ts wires a TTY readline; tests inject answers).
   * Receives the consent prompt text; resolves to whatever the user typed.
   * When absent and consent is needed, `--accept-consent` is required.
   */
  promptConsent?: (prompt: string) => Promise<string>;
}

export interface ConfigGetResult {
  key: string;
  /** The effective (defaults-merged, schema-validated) value. */
  value: unknown;
  output: string;
}

export interface ConfigSetResult {
  key: string;
  /** The value as coerced and written. */
  value: unknown;
  /** True when the API-provider consent was granted during this invocation. */
  consentRecorded: boolean;
  output: string;
}

// ─── Key table ───────────────────────────────────────────────────────────────

type ValueKind = "string" | "boolean" | "integer" | "string-array";

/** Every settable key: its section/name in the file and its coercion type. */
const KEYS: Record<string, { section: string; name: string; kind: ValueKind }> = {
  "embedder.provider": { section: "embedder", name: "provider", kind: "string" },
  "embedder.dim": { section: "embedder", name: "dim", kind: "integer" },
  "embedder.offline": { section: "embedder", name: "offline", kind: "boolean" },
  "embedder.voyage_consent": { section: "embedder", name: "voyage_consent", kind: "boolean" },
  "capture.enabled": { section: "capture", name: "enabled", kind: "boolean" },
  "capture.never_capture": { section: "capture", name: "never_capture", kind: "string-array" },
  "capture.max_span_bytes": { section: "capture", name: "max_span_bytes", kind: "integer" },
  "redaction.ruleset": { section: "redaction", name: "ruleset", kind: "string" },
  "redaction.extra_patterns": {
    section: "redaction",
    name: "extra_patterns",
    kind: "string-array",
  },
  "index.hybrid": { section: "index", name: "hybrid", kind: "boolean" },
};

/** Keys readable via `get` but refused by `set` (they version the file itself). */
const READ_ONLY_KEYS = new Set(["schema"]);

/** The consent prompt, verbatim per CLI_REFERENCE's `config` transcript. */
function consentPrompt(provider: string): string {
  return (
    `${provider} is an API provider: enabling it sends code to Voyage AI for embedding.\n` +
    `This turns off offline-by-default for indexing. Type 'i accept' to continue: `
  );
}

// ─── TOML (line-based, init's known flat shape) ──────────────────────────────

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

function parseTomlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    // Flat string-array (the only array shape init writes).
    const inner = trimmed.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (inner === "") return [];
    return inner.split(",").map((piece) => {
      const scalar = parseTomlScalar(piece);
      return scalar ?? piece.trim();
    });
  }
  return parseTomlScalar(trimmed);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderTomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => tomlString(String(v))).join(", ")}]`;
  throw new Error(`cannot render value of type ${typeof value} as TOML`);
}

/** Parse the whole file into `section -> key -> value` (top level = section ""). */
function parseTomlFile(raw: string): Map<string, Map<string, unknown>> {
  const tables = new Map<string, Map<string, unknown>>();
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
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    const value = parseTomlValue(stripped.slice(eq + 1));
    if (value !== null) {
      const table = tables.get(section) ?? new Map<string, unknown>();
      table.set(key, value);
      tables.set(section, table);
    }
  }
  return tables;
}

/** Init-era defaults (mirrors reindex.ts CONFIG_DEFAULTS / init.ts renderDefaultConfigToml). */
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

/** File tables merged over defaults, as a plain object ready for schema validation. */
function assembleConfigObject(tables: Map<string, Map<string, unknown>>): Record<string, unknown> {
  const assembled = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;
  for (const [section, table] of tables) {
    if (section === "") {
      for (const [key, value] of table) {
        assembled[key] = value;
      }
      continue;
    }
    const target = assembled[section];
    const into: Record<string, unknown> =
      typeof target === "object" && target !== null
        ? (target as Record<string, unknown>)
        : {};
    for (const [key, value] of table) {
      into[key] = value;
    }
    assembled[section] = into;
  }
  return assembled;
}

/**
 * Textually set `key = value` inside `[section]`, preserving every other line
 * (comments, unknown keys, ordering). Appends the key/section when missing.
 */
function setTomlLine(raw: string, section: string, key: string, rendered: string): string {
  const lines = raw.split(/\r?\n/);
  let currentSection = "";
  let sectionStart = -1;
  let sectionEnd = lines.length; // exclusive: first line of the NEXT section
  let keyLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped);
    if (sectionMatch !== null) {
      if (currentSection === section && sectionStart !== -1 && sectionEnd === lines.length) {
        sectionEnd = i;
      }
      currentSection = sectionMatch[1]!.trim();
      if (currentSection === section && sectionStart === -1) {
        sectionStart = i;
      }
      continue;
    }
    if (currentSection === section && keyLine === -1) {
      const eq = stripped.indexOf("=");
      if (eq !== -1 && stripped.slice(0, eq).trim() === key) {
        keyLine = i;
      }
    }
  }

  const newLine = `${key} = ${rendered}`;
  if (keyLine !== -1) {
    lines[keyLine] = newLine;
    return lines.join("\n");
  }
  if (sectionStart !== -1) {
    // Insert at the end of the section, before any trailing blank lines.
    let insertAt = sectionEnd;
    while (insertAt > sectionStart + 1 && lines[insertAt - 1]!.trim() === "") {
      insertAt--;
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join("\n");
  }
  // Section missing entirely: append it.
  const suffix = raw.endsWith("\n") || raw === "" ? "" : "\n";
  return `${raw}${suffix}\n[${section}]\n${newLine}\n`;
}

// ─── Value coercion ──────────────────────────────────────────────────────────

function coerceValue(key: string, kind: ValueKind, raw: string): unknown {
  switch (kind) {
    case "boolean": {
      const lowered = raw.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
      throw new Error(`${key} expects true or false, got '${raw}'`);
    }
    case "integer": {
      if (!/^-?\d+$/.test(raw.trim())) {
        throw new Error(`${key} expects an integer, got '${raw}'`);
      }
      return Number(raw.trim());
    }
    case "string-array": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${key} expects a JSON array of strings, e.g. '["a", "b"]', got '${raw}'`);
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error(`${key} expects a JSON array of strings, e.g. '["a", "b"]'`);
      }
      return parsed;
    }
    case "string":
      return raw;
  }
}

// ─── Repo/file plumbing ──────────────────────────────────────────────────────

async function locateConfig(options: ConfigOptions): Promise<{ repoRoot: string; path: string }> {
  const cwd = options.cwd ?? process.cwd();
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
  return { repoRoot, path: join(gitForAiDir, "config.toml") };
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // init always writes config.toml, but a hand-deleted file degrades to defaults.
    return "";
  }
}

function lookupPath(config: RepoConfig, key: string): unknown {
  const parts = key.split(".");
  let cursor: unknown = config;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function knownKeysHint(): string {
  return `known keys: schema, ${Object.keys(KEYS).join(", ")}`;
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** `git for-ai config get <key>` — print the effective value (judgment call #1). */
export async function runConfigGet(key: string, options: ConfigOptions = {}): Promise<ConfigGetResult> {
  if (!(key in KEYS) && !READ_ONLY_KEYS.has(key)) {
    throw new Error(`unknown config key '${key}' — ${knownKeysHint()}`);
  }

  const { path } = await locateConfig(options);
  const raw = await readConfigFile(path);
  const config = repoConfigSchema.parse(assembleConfigObject(parseTomlFile(raw)));
  const value = lookupPath(config, key);
  const output = Array.isArray(value) ? JSON.stringify(value) : String(value);
  return { key, value, output };
}

/** `git for-ai config set <key> <value>` — validated textual edit (judgment calls #2–5). */
export async function runConfigSet(
  key: string,
  rawValue: string,
  options: ConfigOptions = {},
): Promise<ConfigSetResult> {
  if (READ_ONLY_KEYS.has(key)) {
    throw new Error(`config key '${key}' is read-only (it versions the file format itself)`);
  }
  const spec = KEYS[key];
  if (spec === undefined) {
    throw new Error(`unknown config key '${key}' — ${knownKeysHint()}`);
  }

  const { path } = await locateConfig(options);
  const raw = await readConfigFile(path);
  const current = repoConfigSchema.parse(assembleConfigObject(parseTomlFile(raw)));

  const value = coerceValue(key, spec.kind, rawValue);

  // The one key with side effects: embedder.provider (judgment calls #4 and #5).
  if (key === "embedder.provider") {
    return setEmbedderProvider(String(value), current, raw, path, options);
  }

  const updatedText = setTomlLine(raw, spec.section, spec.name, renderTomlValue(value));
  validateWholeFile(updatedText);
  await writeFile(path, ensureTrailingNewline(updatedText), "utf8");

  return {
    key,
    value,
    consentRecorded: false,
    output: `✓ ${key} set to ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`,
  };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function validateWholeFile(text: string): void {
  const result = repoConfigSchema.safeParse(assembleConfigObject(parseTomlFile(text)));
  if (!result.success) {
    throw new Error(
      `refusing to write an invalid config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
}

async function setEmbedderProvider(
  provider: string,
  current: RepoConfig,
  raw: string,
  path: string,
  options: ConfigOptions,
): Promise<ConfigSetResult> {
  if (!(provider in EMBEDDERS)) {
    throw new Error(
      `unknown embedder provider '${provider}' — expected one of: ${Object.keys(EMBEDDERS).join(", ")}`,
    );
  }
  const meta = EMBEDDERS[provider as EmbedderProvider];

  // Consent flow for API providers (judgment call #4). Consent already on record is
  // not re-prompted — it is a durable, explicitly-granted fact.
  let consentRecorded = false;
  if (!meta.offline && current.embedder.voyage_consent !== true) {
    if (options.acceptConsent === true) {
      consentRecorded = true;
    } else if (options.promptConsent !== undefined) {
      const answer = await options.promptConsent(consentPrompt(provider));
      if (answer.trim().toLowerCase() !== "i accept") {
        throw new Error("consent not given — embedder unchanged (nothing was written)");
      }
      consentRecorded = true;
    } else {
      throw new Error(
        `${provider} is an API provider: enabling it sends code to Voyage AI for embedding. ` +
          `Consent requires an interactive terminal (to type 'i accept') or the ` +
          `--accept-consent flag.`,
      );
    }
  }

  // One atomic rewrite carrying provider + dim + offline (+ consent when granted).
  let text = setTomlLine(raw, "embedder", "provider", renderTomlValue(provider));
  text = setTomlLine(text, "embedder", "dim", renderTomlValue(meta.dim));
  text = setTomlLine(text, "embedder", "offline", renderTomlValue(meta.offline));
  if (consentRecorded) {
    text = setTomlLine(text, "embedder", "voyage_consent", renderTomlValue(true));
  }
  validateWholeFile(text);
  await writeFile(path, ensureTrailingNewline(text), "utf8");

  return {
    key: "embedder.provider",
    value: provider,
    consentRecorded,
    output: `✓ embedder set to ${provider} (dim ${meta.dim}). Run \`git for-ai reindex --full\` to re-embed.`,
  };
}

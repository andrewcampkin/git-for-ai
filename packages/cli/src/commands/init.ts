// `git for-ai init` — opt-in, idempotent per-repo setup. Spec: architecture/CLI_REFERENCE.md
// (the `init` section) and architecture/ARCHITECTURE.md §8.2 (on-disk layout), §10.1
// (.claude/settings.json hook shape), §13 (capture is opt-in per repo — nothing captures
// until this command runs).
//
// This module exports `runInit(options)` (pure logic, no console output — returns a
// structured `InitResult`) plus `formatInitResult(result)` which renders the exact console
// transcript from CLI_REFERENCE.md. Commander wiring lives in bin.ts, done separately.
//
// ── Judgment calls the architecture docs left open (documented here on purpose) ──
//
// 1. Git hook script shape. Each installed hook (`commit-msg`, `post-commit`,
//    `post-rewrite`) contains a fenced, marker-delimited "managed block" that dispatches to
//    a future CLI subcommand:
//
//        git-for-ai internal-hook <hook-name> "$@" || true
//
//    - `internal-hook <name>` is a placeholder dispatch target: the actual behavior behind
//      it (Change-Id trailer injection for commit-msg, change-map upkeep for post-commit,
//      §7.4 rewrite folding for post-rewrite) is a later milestone's job. Only the *shape*
//      is fixed here, so hooks installed today keep working once the dispatcher exists.
//    - `"$@"` forwards hook arguments (commit-msg gets the message file path; post-rewrite
//      gets the rewrite kind, and its old-SHA/new-SHA pairs arrive on inherited stdin).
//    - `|| true` enforces the architecture's "a hook must never break the user's commit"
//      rule (§10.2/§14): if git-for-ai is missing from PATH or crashes, the hook still
//      exits 0.
//    - Idempotency/non-clobbering: an existing hook file is never overwritten. If it lacks
//      our markers the block is appended after the user's content; if it already has the
//      markers it is left byte-for-byte alone (unless `force`, which regenerates just the
//      managed block between the markers — never the user's surrounding content).
//
// 2. Refspec configuration mechanism. CLI_REFERENCE says init "configures fetch/push
//    refspecs ... without enabling auto-follow" but does not pin the git config mechanism.
//    Adding them to `remote.<name>.fetch` would make every plain `git fetch` pull the
//    intent refs — that IS auto-follow, which decision #6 forbids. So the refspecs are
//    recorded under git-for-ai's own config namespace instead:
//
//        git config --add git-for-ai.refspec "+refs/notes/git-for-ai/*:refs/notes/git-for-ai/*"
//        git config --add git-for-ai.refspec "+refs/git-for-ai/*:refs/git-for-ai/*"
//
//    Plain git ignores unknown config keys, so nothing syncs automatically;
//    `git for-ai sync` reads `git-for-ai.refspec` and passes the specs to fetch/push
//    explicitly. Two patterns cover all three intent refs (intent notes under
//    refs/notes/git-for-ai/*; sessions and change-map under refs/git-for-ai/*).
//
// 3. Embedder metadata table. DATA_MODEL.md §5 pins jina-v2-code at dim 768 and
//    CLI_REFERENCE pins voyage-code-3 at dim 1024; nomic-embed-code's 3584 comes from the
//    published model card and can be corrected in one place (EMBEDDERS below) if the embedder ever moves
//    to a different variant.
//
// 4. sqlite-vec index is a stub: `index.db` is created as an empty file (reindex creates
//    the real schema), alongside an empty `embcache/` directory and a
//    `state.json` matching DATA_MODEL.md §5.1 with `last_indexed_commit: null`.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { runGit } from "@git-for-ai/core";
import {
  repoConfigSchema,
  type EmbedderProvider,
  type RepoConfig,
} from "@git-for-ai/schemas";

// ─── Public types ────────────────────────────────────────────────────────────

export interface InitOptions {
  /** Repository to initialize (any directory inside it). Default: `process.cwd()`. */
  cwd?: string;
  /** Embedding provider recorded in `.git-for-ai/config.toml` (`--embedder`). Default `jina-v2-code`. */
  embedder?: EmbedderProvider;
  /** Override the hooks directory (`--hooks-path`). Default: `core.hooksPath` if set, else `.git/hooks`. */
  hooksPath?: string;
  /** Write/merge `.claude/settings.json` hooks. `false` = `--no-claude-hooks` (git-side only). Default true. */
  claudeHooks?: boolean;
  /** Regenerate existing managed hook blocks in place (`--force`). Default false. */
  force?: boolean;
}

export type HookName = "commit-msg" | "post-commit" | "post-rewrite";

export type HookAction =
  /** Hook file did not exist; created with shebang + managed block. */
  | "created"
  /** Pre-existing hook without our markers; managed block appended, user content preserved. */
  | "appended"
  /** Markers present and `force` given; managed block regenerated between the markers. */
  | "updated"
  /** Markers already present; file left byte-for-byte alone. */
  | "unchanged";

export interface HookInstallResult {
  name: HookName;
  path: string;
  action: HookAction;
}

export interface InitResult {
  /** Absolute path to the repo's working-tree root. */
  repoRoot: string;
  /** Absolute path to the `.git` directory. */
  gitDir: string;
  /** Absolute hooks directory the hooks were written to. */
  hooksDir: string;
  /** Where `hooksDir` came from. */
  hooksPathSource: "option" | "core.hooksPath" | "default";
  hooks: HookInstallResult[];
  claudeSettingsPath: string;
  claudeSettingsAction: "created" | "merged" | "unchanged" | "skipped";
  /** The full set of configured refspecs, and the subset added by this run. */
  refspecs: { specs: string[]; added: string[] };
  /** Absolute path to `.git-for-ai/`. */
  gitForAiDir: string;
  configTomlAction: "created" | "unchanged";
  stateJsonAction: "created" | "unchanged";
  indexDbAction: "created" | "unchanged";
  /** `.git/info/exclude` entry for `.git-for-ai/`. */
  excludeAction: "appended" | "unchanged";
  embedder: EmbedderProvider;
  /** False when the run was a complete no-op (the idempotent re-run case). */
  changed: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Install order matches the CLI_REFERENCE console transcript. */
const HOOK_NAMES: readonly HookName[] = ["post-commit", "post-rewrite", "commit-msg"];

const BLOCK_BEGIN = "# >>> git-for-ai >>>";
const BLOCK_END = "# <<< git-for-ai <<<";

/** The three intent refs, as two refspec patterns (see judgment call #2 above). */
export const GIT_FOR_AI_REFSPECS: readonly string[] = [
  "+refs/notes/git-for-ai/*:refs/notes/git-for-ai/*",
  "+refs/git-for-ai/*:refs/git-for-ai/*",
];

/** git config key holding the refspecs `git for-ai sync` will use (multi-valued). */
export const REFSPEC_CONFIG_KEY = "git-for-ai.refspec";

/** The two PostToolUse hooks from ARCHITECTURE.md §10.1, verbatim. */
const CLAUDE_POST_TOOL_USE_HOOKS: ReadonlyArray<{ matcher: string; command: string }> = [
  { matcher: "ExitPlanMode", command: "git for-ai capture-session --event plan" },
  { matcher: "Bash", command: "git for-ai capture-session --event maybe-commit" },
];

/**
 * Embedder metadata table (judgment call #3 above). Exported for `config set
 * embedder.provider`, which must record the same dim/offline facts init would.
 */
export const EMBEDDERS: Record<
  EmbedderProvider,
  { dim: number; offline: boolean; display: string }
> = {
  "jina-v2-code": {
    dim: 768,
    offline: true,
    display: "jina-embeddings-v2-code (self-hosted, offline)",
  },
  "nomic-embed-code": {
    dim: 3584,
    offline: true,
    display: "nomic-embed-code (self-hosted, offline)",
  },
  "voyage-code-3": {
    dim: 1024,
    offline: false,
    display: "voyage-code-3 (API — requires explicit consent via `git for-ai config`)",
  },
};

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Perform `git for-ai init` against the repository containing `options.cwd`.
 * Idempotent: a second run against an already-initialized repo changes nothing
 * (`result.changed === false`) and never clobbers user-owned content it finds
 * (existing hook scripts, existing `.claude/settings.json` hooks, existing config).
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const embedder = options.embedder ?? "jina-v2-code";
  const claudeHooks = options.claudeHooks ?? true;
  const force = options.force ?? false;

  if (!(embedder in EMBEDDERS)) {
    throw new Error(
      `unknown embedder "${embedder}" — expected one of: ${Object.keys(EMBEDDERS).join(", ")}`,
    );
  }

  // Locate the repo (fail with a plain message, not a raw git error, if we're not in one).
  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (toplevel.exitCode !== 0) {
    throw new Error(`not a git repository (or any parent up to mount point): ${cwd}`);
  }
  const repoRoot = resolve(toplevel.stdout);

  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], { cwd: repoRoot })).stdout;
  const gitDir = isAbsolute(gitDirRaw) ? resolve(gitDirRaw) : resolve(repoRoot, gitDirRaw);

  // 1. Git hooks.
  const { hooksDir, hooksPathSource } = await resolveHooksDir(repoRoot, gitDir, options.hooksPath);
  await mkdir(hooksDir, { recursive: true });
  const hooks: HookInstallResult[] = [];
  for (const name of HOOK_NAMES) {
    hooks.push(await installHook(hooksDir, name, force));
  }

  // 2. Claude Code project hooks.
  const claudeSettingsPath = join(repoRoot, ".claude", "settings.json");
  const claudeSettingsAction = claudeHooks
    ? await writeClaudeSettings(claudeSettingsPath)
    : ("skipped" as const);

  // 3. Refspec config (manual-sync only — see judgment call #2 in the header comment).
  const refspecs = await configureRefspecs(repoRoot);

  // 4. `.git-for-ai/` derived-cache directory (ARCHITECTURE §8.2).
  const gitForAiDir = join(repoRoot, ".git-for-ai");
  await mkdir(join(gitForAiDir, "embcache"), { recursive: true });
  const configTomlAction = await writeIfAbsent(
    join(gitForAiDir, "config.toml"),
    renderDefaultConfigToml(embedder),
  );
  const stateJsonAction = await writeIfAbsent(
    join(gitForAiDir, "state.json"),
    renderDefaultStateJson(embedder),
  );
  // sqlite-vec stub: empty file; reindex creates the real schema.
  const indexDbAction = await writeIfAbsent(join(gitForAiDir, "index.db"), "");

  // 5. Exclude the cache via `.git/info/exclude` (never the user's tracked .gitignore).
  const excludeAction = await addToInfoExclude(gitDir);

  const changed =
    hooks.some((h) => h.action !== "unchanged") ||
    claudeSettingsAction === "created" ||
    claudeSettingsAction === "merged" ||
    refspecs.added.length > 0 ||
    configTomlAction === "created" ||
    stateJsonAction === "created" ||
    indexDbAction === "created" ||
    excludeAction === "appended";

  return {
    repoRoot,
    gitDir,
    hooksDir,
    hooksPathSource,
    hooks,
    claudeSettingsPath,
    claudeSettingsAction,
    refspecs,
    gitForAiDir,
    configTomlAction,
    stateJsonAction,
    indexDbAction,
    excludeAction,
    embedder,
    changed,
  };
}

/**
 * Render the human-readable console report for an {@link InitResult}, matching the
 * transcript in CLI_REFERENCE.md's `init` section (plain text; bin.ts may colorize).
 */
export function formatInitResult(result: InitResult): string {
  const hookNames = result.hooks.map((h) => h.name).join(", ");
  const lines = [`✓ git hooks installed (${hookNames})`];

  if (result.claudeSettingsAction === "skipped") {
    lines.push("- Claude Code hooks skipped (--no-claude-hooks)");
  } else {
    lines.push("✓ Claude Code hooks written to .claude/settings.json");
  }

  lines.push(
    "✓ refspecs configured for refs/notes/git-for-ai/*, refs/git-for-ai/*  (manual sync only)",
    "✓ .git-for-ai/ created and excluded; sqlite-vec index initialized (empty)",
    `  Embedder: ${EMBEDDERS[result.embedder].display}.`,
    "  Capture is ON for this repo. Data stays local until `git for-ai sync --push`.",
  );
  return lines.join("\n");
}

// ─── Git hooks ───────────────────────────────────────────────────────────────

async function resolveHooksDir(
  repoRoot: string,
  gitDir: string,
  override: string | undefined,
): Promise<{ hooksDir: string; hooksPathSource: InitResult["hooksPathSource"] }> {
  if (override !== undefined) {
    return { hooksDir: resolve(repoRoot, override), hooksPathSource: "option" };
  }
  const configured = await runGit(["config", "--get", "core.hooksPath"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (configured.exitCode === 0 && configured.stdout.trim() !== "") {
    // A relative core.hooksPath is interpreted by git relative to where hooks run — the
    // top of the working tree for the hooks we install — so resolve against repoRoot.
    return { hooksDir: resolve(repoRoot, configured.stdout.trim()), hooksPathSource: "core.hooksPath" };
  }
  return { hooksDir: join(gitDir, "hooks"), hooksPathSource: "default" };
}

/** The managed block installed into each hook (see judgment call #1 in the header comment). */
function managedBlock(name: HookName): string {
  return [
    `${BLOCK_BEGIN} (managed by \`git for-ai init\` — regenerate with --force; do not edit between markers)`,
    "# `|| true`: a git-for-ai hook must never break the user's git operation,",
    "# even when git-for-ai is not installed or fails (ARCHITECTURE.md §10.2/§14).",
    `git-for-ai internal-hook ${name} "$@" || true`,
    BLOCK_END,
  ].join("\n");
}

async function installHook(hooksDir: string, name: HookName, force: boolean): Promise<HookInstallResult> {
  const path = join(hooksDir, name);
  const block = managedBlock(name);

  if (!existsSync(path)) {
    const content = `#!/bin/sh\n${block}\n`;
    await writeFile(path, content, "utf8");
    await chmod(path, 0o755);
    return { name, path, action: "created" };
  }

  const existing = await readFile(path, "utf8");
  const lines = existing.split("\n");
  const beginIdx = lines.findIndex((l) => l.startsWith(BLOCK_BEGIN));
  const endIdx = lines.findIndex((l) => l.startsWith(BLOCK_END));

  if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
    // Our managed block is already there.
    const current = lines.slice(beginIdx, endIdx + 1).join("\n");
    if (!force || current === block) {
      // Idempotent re-run: leave the file byte-for-byte alone.
      await chmod(path, 0o755);
      return { name, path, action: "unchanged" };
    }
    // --force: regenerate ONLY the managed block; user content around it is untouched.
    const updated = [...lines.slice(0, beginIdx), ...block.split("\n"), ...lines.slice(endIdx + 1)].join("\n");
    await writeFile(path, updated, "utf8");
    await chmod(path, 0o755);
    return { name, path, action: "updated" };
  }

  // Pre-existing hook not managed by us: append, never overwrite (CLI_REFERENCE:
  // "appending rather than clobbering").
  const separator = existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${separator}\n${block}\n`, "utf8");
  await chmod(path, 0o755);
  return { name, path, action: "appended" };
}

// ─── .claude/settings.json ───────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create or merge the two PostToolUse hooks from ARCHITECTURE.md §10.1 into the project's
 * `.claude/settings.json`, preserving every setting and hook the user already has. A hook
 * entry is considered "ours" (and skipped) when the same matcher group already contains a
 * command-type hook with the exact same command string.
 */
async function writeClaudeSettings(path: string): Promise<"created" | "merged" | "unchanged"> {
  let settings: JsonObject = {};
  let existed = false;

  if (existsSync(path)) {
    existed = true;
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch (cause) {
      // Never clobber a file we can't understand.
      throw new Error(
        `${path} exists but is not valid JSON — fix or remove it, then re-run \`git for-ai init\``,
        { cause },
      );
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`${path} exists but is not a JSON object — refusing to overwrite it`);
    }
    settings = parsed;
  }

  const hooksValue = settings["hooks"] ?? {};
  if (!isJsonObject(hooksValue)) {
    throw new Error(`${path}: "hooks" is not an object — refusing to modify it`);
  }
  const postToolUseValue = hooksValue["PostToolUse"] ?? [];
  if (!Array.isArray(postToolUseValue)) {
    throw new Error(`${path}: "hooks.PostToolUse" is not an array — refusing to modify it`);
  }

  let changedAnything = false;
  for (const { matcher, command } of CLAUDE_POST_TOOL_USE_HOOKS) {
    const group = postToolUseValue.find(
      (entry): entry is JsonObject => isJsonObject(entry) && entry["matcher"] === matcher,
    );
    if (group === undefined) {
      postToolUseValue.push({ matcher, hooks: [{ type: "command", command }] });
      changedAnything = true;
      continue;
    }
    const groupHooks = group["hooks"];
    if (!Array.isArray(groupHooks)) {
      throw new Error(
        `${path}: hooks.PostToolUse entry for matcher "${matcher}" has no "hooks" array — refusing to modify it`,
      );
    }
    const alreadyWired = groupHooks.some(
      (h) => isJsonObject(h) && h["type"] === "command" && h["command"] === command,
    );
    if (!alreadyWired) {
      groupHooks.push({ type: "command", command });
      changedAnything = true;
    }
  }

  if (existed && !changedAnything) {
    return "unchanged";
  }

  hooksValue["PostToolUse"] = postToolUseValue;
  settings["hooks"] = hooksValue;

  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return existed ? "merged" : "created";
}

// ─── Refspec config ──────────────────────────────────────────────────────────

async function configureRefspecs(repoRoot: string): Promise<InitResult["refspecs"]> {
  const existing = await runGit(["config", "--get-all", REFSPEC_CONFIG_KEY], {
    cwd: repoRoot,
    allowFailure: true, // exit 1 = key unset, which is fine
  });
  const present = existing.exitCode === 0 ? existing.stdout.split("\n").filter((l) => l !== "") : [];

  const added: string[] = [];
  for (const spec of GIT_FOR_AI_REFSPECS) {
    if (!present.includes(spec)) {
      await runGit(["config", "--add", REFSPEC_CONFIG_KEY, spec], { cwd: repoRoot });
      added.push(spec);
    }
  }
  return { specs: [...GIT_FOR_AI_REFSPECS], added };
}

// ─── .git-for-ai/ contents ───────────────────────────────────────────────────

/** Write `content` to `path` only if the file doesn't exist yet (user/config files are never regenerated). */
async function writeIfAbsent(path: string, content: string): Promise<"created" | "unchanged"> {
  if (existsSync(path)) {
    return "unchanged";
  }
  await writeFile(path, content, "utf8");
  return "created";
}

/** Build the default RepoConfig (validated against @git-for-ai/schemas) and serialize it as TOML. */
function renderDefaultConfigToml(embedder: EmbedderProvider): string {
  const meta = EMBEDDERS[embedder];
  const config: RepoConfig = repoConfigSchema.parse({
    schema: "git-for-ai/config@1",
    embedder: {
      provider: embedder,
      dim: meta.dim,
      offline: meta.offline,
      // Consent is only ever granted via the explicit `git for-ai config set` flow
      // (CLI_REFERENCE `config`), never implicitly at init.
      voyage_consent: false,
    },
    capture: {
      enabled: true,
      never_capture: [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"],
      max_span_bytes: 16384,
    },
    redaction: {
      ruleset: "builtin@1",
      extra_patterns: [],
    },
    index: {
      hybrid: true,
    },
  } satisfies RepoConfig);

  return [
    "# git-for-ai repo config — local, not synced. See architecture/DATA_MODEL.md §5.",
    `schema = ${tomlString(config.schema)}`,
    "",
    "[embedder]",
    `provider = ${tomlString(config.embedder.provider)}`,
    `dim = ${config.embedder.dim}`,
    `offline = ${config.embedder.offline}`,
    `voyage_consent = ${config.embedder.voyage_consent}`,
    "",
    "[capture]",
    `enabled = ${config.capture.enabled}`,
    `never_capture = ${tomlStringArray(config.capture.never_capture)}`,
    `max_span_bytes = ${config.capture.max_span_bytes}`,
    "",
    "[redaction]",
    `ruleset = ${tomlString(config.redaction.ruleset)}`,
    `extra_patterns = ${tomlStringArray(config.redaction.extra_patterns)}`,
    "",
    "[index]",
    `hybrid = ${config.index.hybrid}`,
    "",
  ].join("\n");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/** `state.json` per DATA_MODEL.md §5.1, in its "nothing indexed yet" state. */
function renderDefaultStateJson(embedder: EmbedderProvider): string {
  const state = {
    schema: "git-for-ai/index-state@1",
    last_indexed_commit: null,
    model_fingerprint: `${embedder}/${EMBEDDERS[embedder].dim}`,
    vec_schema_version: 1,
    chunk_count: 0,
    updated_at: new Date().toISOString(),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

// ─── .git/info/exclude ───────────────────────────────────────────────────────

const EXCLUDE_ENTRY = ".git-for-ai/";

async function addToInfoExclude(gitDir: string): Promise<"appended" | "unchanged"> {
  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });

  const existing = existsSync(excludePath) ? await readFile(excludePath, "utf8") : "";
  const alreadyExcluded = existing
    .split(/\r?\n/)
    .some((line) => line.trim() === EXCLUDE_ENTRY || line.trim() === ".git-for-ai");
  if (alreadyExcluded) {
    return "unchanged";
  }

  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const addition = `${separator}# git-for-ai derived cache (added by \`git for-ai init\`)\n${EXCLUDE_ENTRY}\n`;
  await writeFile(excludePath, existing + addition, "utf8");
  return "appended";
}

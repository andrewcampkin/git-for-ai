// `git for-ai doctor` — the single pane of glass for health (CLI_REFERENCE `doctor`),
// including the identity audits: `origin: inferred` rows, orphan-recovery rows, dangling
// session refs, and hooks-installed-but-dispatcher-missing (the failure class, not just
// the instance).
//
// Hard rules:
//   - READ-ONLY. Doctor never writes: no resolveChangeId (its R4/R5 branches mint map
//     rows — the same non-minting discipline as log/show/report), no config repair, no
//     note migration. It diagnoses and names the command that heals.
//   - Actionable: every non-✓ row carries a concrete remediation line.
//   - The embedding model is NEVER loaded (reachability is judged from config + the
//     on-disk model cache; loading ~GBs of weights to say "✓" would violate the
//     project's own resource discipline).
//
// ── Judgment calls ──
//
// 1. Exit code: CLI_REFERENCE's `doctor` transcript exits 3 whenever problems (warnings
//    OR errors) are found, matching its "3 = environment problem (doctor-detectable)"
//    convention — that is what this implements (a plan note said "exit 1"; the
//    CLI_REFERENCE contract wins, and anything nonzero still reads as unhealthy).
// 2. An uninitialized repo is a DIAGNOSIS (every row fails with "run `git for-ai
//    init`"), not a crash — doctor is exactly the command a confused user runs first.
// 3. Legacy-envelope ledger notes (pre-JSONL format) are surfaced as a warning: they read
//    fine, but a divergent sync merge cannot union them until their next (migrating)
//    append — worth knowing, not worth failing.
// 4. The dispatcher check scans PATH for a `git-for-ai` executable the hook scripts
//    could actually invoke (PATHEXT-aware on Windows). Injectable env for tests.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

import {
  runGit,
  lsTree,
  readAllChangeMapEntries,
  readLedgerNoteWithFormat,
  LedgerNoteFormatError,
  readIndexState,
  IndexStateFormatError,
  modelFingerprint,
  resolveTransformersDevice,
  sessionShardPath,
  INTENT_NOTES_REF,
  SESSIONS_REF,
  type GitContext,
} from "@git-for-ai/core";
import type { LedgerEntry } from "@git-for-ai/schemas";

import { GIT_FOR_AI_REFSPECS, REFSPEC_CONFIG_KEY } from "./init.js";
import { readRepoConfig, defaultModelCacheDir } from "./reindex.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface DoctorOptions {
  /** Repository to examine (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** PATH override for the dispatcher check (tests). Defaults to process.env.PATH. */
  pathEnv?: string;
}

export type DoctorStatus = "ok" | "warn" | "error";

/**
 * A repair a GUI can actually offer for a finding (DESKTOP.md §3 item 4, "guided repair").
 *
 * `remediation` above is prose for a person reading a terminal; this is the SAME advice as
 * data, so the desktop app can put a button on it without parsing English. Doctor is the
 * code that already worked out which repair applies and to which changes — having the UI
 * re-derive that from a sentence would be exactly the guessing this project avoids. A
 * finding with no mechanical repair simply carries none.
 */
export interface DoctorRepair {
  /** Action endpoint verb (`/api/actions/<action>`) — the CLI command of the same name. */
  action: "reconcile" | "relink";
  /** One sentence, in a reader's words, about what running it does. */
  what: string;
  /** relink only: the `--detach` form (drop a commit from a change it was wrongly given). */
  detach: boolean;
  /**
   * True when a person must name a commit before this can run. Doctor never guesses which
   * commit is right — that is the judgement a human is here to make.
   */
  needsCommit: boolean;
  /** Changes this finding is about, when doctor identified them (may be empty). */
  changeIds: string[];
}

export interface DoctorCheck {
  /** Short row label (`hooks`, `index`, ...). */
  name: string;
  status: DoctorStatus;
  /** One-line finding. */
  message: string;
  /** Concrete next steps (rendered indented under the row). */
  remediation: string[];
  /** Machine-readable form of the same advice, where a repair exists. */
  repairs?: DoctorRepair[];
}

export interface DoctorData {
  repoRoot: string;
  checks: DoctorCheck[];
  warnings: number;
  errors: number;
  /** 0 healthy; 3 when any problem was found (CLI_REFERENCE exit convention). */
  exitCode: 0 | 3;
}

export interface DoctorResult {
  data: DoctorData;
  output: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOOK_NAMES = ["post-commit", "post-rewrite", "commit-msg"] as const;
const MANAGED_MARKER = "git-for-ai internal-hook";

const ok = (name: string, message: string): DoctorCheck => ({
  name,
  status: "ok",
  message,
  remediation: [],
});
const warn = (name: string, message: string, ...remediation: string[]): DoctorCheck => ({
  name,
  status: "warn",
  message,
  remediation,
});
/** Attach structured repairs to a check (kept separate so the constructors stay terse). */
const withRepairs = (check: DoctorCheck, repairs: DoctorRepair[]): DoctorCheck =>
  repairs.length > 0 ? { ...check, repairs } : check;
const fail = (name: string, message: string, ...remediation: string[]): DoctorCheck => ({
  name,
  status: "error",
  message,
  remediation,
});

async function resolveHooksDir(repoRoot: string, gitDir: string, ctx: GitContext): Promise<string> {
  const configured = await runGit(["config", "--get", "core.hooksPath"], {
    ...ctx,
    allowFailure: true,
  });
  if (configured.exitCode === 0 && configured.stdout.trim() !== "") {
    return resolve(repoRoot, configured.stdout.trim());
  }
  return join(gitDir, "hooks");
}

/** PATHEXT-aware executable lookup (judgment call #4). */
export function findDispatcherOnPath(pathEnv: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of ["", ...exts]) {
      const candidate = join(dir, `git-for-ai${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Lines in a log file, or 0 when absent/unreadable (logs are best-effort evidence). */
async function countLogLines(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

const plural = (n: number, word: string): string =>
  n === 1 ? `1 ${word}` : `${n} ${word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;

// ─── The checks ──────────────────────────────────────────────────────────────

async function checkHooks(
  repoRoot: string,
  gitDir: string,
  ctx: GitContext,
): Promise<{ check: DoctorCheck; installed: boolean }> {
  const hooksDir = await resolveHooksDir(repoRoot, gitDir, ctx);
  const missing: string[] = [];
  const unmanaged: string[] = [];
  for (const name of HOOK_NAMES) {
    const path = join(hooksDir, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const content = await readFile(path, "utf8");
    if (!content.includes(MANAGED_MARKER)) {
      unmanaged.push(name);
    }
  }
  if (missing.length === 0 && unmanaged.length === 0) {
    return { check: ok("hooks", `${HOOK_NAMES.join(", ")} installed`), installed: true };
  }
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
  if (unmanaged.length > 0) problems.push(`present but not managed: ${unmanaged.join(", ")}`);
  return {
    check: fail("hooks", problems.join("; "), "run `git for-ai init` to (re)install the git hooks"),
    installed: missing.length + unmanaged.length < HOOK_NAMES.length,
  };
}

async function checkDispatcher(
  hooksInstalled: boolean,
  repoRoot: string,
  pathEnv: string,
): Promise<DoctorCheck> {
  const found = findDispatcherOnPath(pathEnv);
  if (found === null) {
    // The failure class: hooks fire `git-for-ai
    // internal-hook ... || true`, so a missing binary silently disables capture.
    const message = hooksInstalled
      ? "hooks are installed but no `git-for-ai` executable is on PATH — hooks silently no-op"
      : "no `git-for-ai` executable is on PATH";
    return fail(
      "dispatcher",
      message,
      "install the CLI onto PATH (e.g. `pnpm link --global` from packages/cli, or npm i -g)",
      "until then, commits get no Change-Id trailer and no capture",
    );
  }
  const hooksLogLines = await countLogLines(join(repoRoot, ".git-for-ai", "hooks.log"));
  if (hooksLogLines > 0) {
    return warn(
      "dispatcher",
      `git-for-ai found on PATH, but .git-for-ai/hooks.log records ${plural(hooksLogLines, "hook failure")}`,
      "read .git-for-ai/hooks.log for the specific errors (safe to delete once resolved)",
    );
  }
  return ok("dispatcher", `git-for-ai on PATH (${found})`);
}

async function checkClaudeHooks(repoRoot: string): Promise<DoctorCheck> {
  const path = join(repoRoot, ".claude", "settings.json");
  const wanted = [
    "git for-ai capture-session --event plan",
    "git for-ai capture-session --event maybe-commit",
  ];
  if (!existsSync(path)) {
    return warn(
      "claude hooks",
      ".claude/settings.json does not exist — Claude Code sessions are not captured",
      "run `git for-ai init` (or add the PostToolUse hooks by hand — ARCHITECTURE.md §10.1)",
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return warn("claude hooks", ".claude/settings.json is unreadable", "check file permissions");
  }
  try {
    JSON.parse(raw);
  } catch {
    return fail(
      "claude hooks",
      ".claude/settings.json is not valid JSON — Claude Code will ignore it",
      "fix the JSON, then re-run `git for-ai init` to re-merge the hooks",
    );
  }
  const missing = wanted.filter((command) => !raw.includes(command));
  if (missing.length > 0) {
    return warn(
      "claude hooks",
      `PostToolUse hook${missing.length === 1 ? "" : "s"} missing: ${missing.join("; ")}`,
      "run `git for-ai init` to merge the missing hooks",
    );
  }
  return ok("claude hooks", "ExitPlanMode + Bash/git-commit wired");
}

async function checkRefspecs(ctx: GitContext): Promise<DoctorCheck> {
  const configured = await runGit(["config", "--get-all", REFSPEC_CONFIG_KEY], {
    ...ctx,
    allowFailure: true,
  });
  const present =
    configured.exitCode === 0
      ? configured.stdout.split("\n").filter((line) => line !== "")
      : [];
  const missing = GIT_FOR_AI_REFSPECS.filter((spec) => !present.includes(spec));
  if (missing.length === 0) {
    return ok("refspecs", "configured (manual sync)");
  }
  return fail(
    "refspecs",
    `missing ${REFSPEC_CONFIG_KEY} entr${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`,
    "run `git for-ai init` to configure them — `git for-ai sync` needs them",
  );
}

interface IndexFacts {
  fingerprintFromConfig: string | null;
}

async function checkConfigAndIndex(
  repoRoot: string,
  ctx: GitContext,
): Promise<{ config: DoctorCheck; index: DoctorCheck; embedder: DoctorCheck }> {
  const gitForAiDir = join(repoRoot, ".git-for-ai");
  if (!existsSync(gitForAiDir)) {
    const init = "run `git for-ai init` to opt this repository in";
    return {
      config: fail("config", ".git-for-ai/ does not exist — repository is not initialized", init),
      index: fail("index", "no index (repository not initialized)", init),
      embedder: fail("embedder", "no configuration (repository not initialized)", init),
    };
  }

  // config.toml
  let configCheck: DoctorCheck;
  const facts: IndexFacts = { fingerprintFromConfig: null };
  let captureEnabled: boolean | null = null;
  let provider: string | null = null;
  let offline: boolean | null = null;
  let voyageConsent: boolean | null = null;
  try {
    const config = await readRepoConfig(gitForAiDir);
    // Precision folds into the fingerprint for the local transformers provider (ROADMAP
    // Tier 0); resolution is pure — the model is still NEVER loaded here.
    facts.fingerprintFromConfig = modelFingerprint(
      config.embedder.provider,
      config.embedder.dim,
      config.embedder.provider === "voyage-code-3"
        ? undefined
        : resolveTransformersDevice().dtype,
    );
    captureEnabled = config.capture.enabled;
    provider = config.embedder.provider;
    offline = config.embedder.offline;
    voyageConsent = config.embedder.voyage_consent;
    configCheck =
      captureEnabled === true
        ? ok("config", "config.toml valid; capture enabled")
        : warn(
            "config",
            "config.toml valid, but capture is DISABLED for this repo",
            "set `git for-ai config set capture.enabled true` to capture again",
          );
  } catch (error) {
    configCheck = fail(
      "config",
      `config.toml is unusable (${error instanceof Error ? error.message : String(error)})`,
      "fix .git-for-ai/config.toml (or delete it and re-run `git for-ai init`)",
    );
  }

  // index.db + state.json (never loading the model)
  let indexCheck: DoctorCheck;
  try {
    const state = await readIndexState(gitForAiDir);
    if (state === null || state.last_indexed_commit === null) {
      indexCheck = warn(
        "index",
        "never built — `ask`/`blame --why` retrieval is unavailable",
        "run `git for-ai reindex` to build it",
      );
    } else if (!existsSync(join(gitForAiDir, "index.db"))) {
      indexCheck = fail(
        "index",
        "state.json records an index but index.db is missing",
        "run `git for-ai reindex --full` to rebuild it",
      );
    } else if (
      facts.fingerprintFromConfig !== null &&
      state.model_fingerprint !== facts.fingerprintFromConfig
    ) {
      indexCheck = fail(
        "index",
        `built with ${state.model_fingerprint}, but config says ${facts.fingerprintFromConfig}`,
        "run `git for-ai reindex --full` to re-embed with the configured model",
      );
    } else {
      const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
        ...ctx,
        allowFailure: true,
      });
      const stale =
        head.exitCode === 0 &&
        head.stdout.length > 0 &&
        head.stdout !== state.last_indexed_commit;
      const summary =
        `schema ${state.vec_schema_version}, fingerprint ${state.model_fingerprint}, ` +
        `${state.chunk_count} chunks`;
      indexCheck = stale
        ? warn(
            "index",
            `${summary}, STALE (last indexed ${state.last_indexed_commit.slice(0, 8)}, HEAD ${head.stdout.slice(0, 8)})`,
            "run `git for-ai reindex` to catch up",
          )
        : ok("index", `${summary}, current`);
    }
  } catch (error) {
    indexCheck =
      error instanceof IndexStateFormatError
        ? fail(
            "index",
            `state.json is unreadable (${error.message})`,
            "run `git for-ai reindex --full` to rebuild the index",
          )
        : fail("index", `cannot inspect the index (${error instanceof Error ? error.message : String(error)})`);
  }

  // embedder (config + cache facts only — the model is NEVER loaded here)
  let embedderCheck: DoctorCheck;
  if (provider === null) {
    embedderCheck = fail("embedder", "unknown (config unusable — see the config row)");
  } else if (offline === false) {
    const keyPresent = (process.env["VOYAGE_API_KEY"] ?? "") !== "";
    if (voyageConsent !== true) {
      embedderCheck = fail(
        "embedder",
        `${provider} configured but consent was never recorded`,
        "run `git for-ai config set embedder.provider voyage-code-3` and accept the prompt",
      );
    } else if (!keyPresent) {
      embedderCheck = warn(
        "embedder",
        `${provider} (API, consent recorded) but VOYAGE_API_KEY is not set`,
        "export VOYAGE_API_KEY before running `reindex`/`ask`",
      );
    } else {
      embedderCheck = ok("embedder", `${provider} (API, consent recorded, key present)`);
    }
  } else {
    const cacheDir = defaultModelCacheDir();
    let cached = false;
    try {
      cached = existsSync(cacheDir) && (await readdir(cacheDir)).length > 0;
    } catch {
      cached = false;
    }
    embedderCheck = cached
      ? ok("embedder", `${provider} (local, model cached at ${cacheDir})`)
      : warn(
          "embedder",
          `${provider} (local) — model not downloaded yet`,
          "the first `git for-ai reindex` downloads it (~160 MB, one-time per machine)",
        );
  }

  return { config: configCheck, index: indexCheck, embedder: embedderCheck };
}

async function checkIdentity(ctx: GitContext): Promise<DoctorCheck> {
  let entries;
  try {
    entries = await readAllChangeMapEntries(ctx);
  } catch (error) {
    return fail(
      "identity",
      `change-map is unreadable (${error instanceof Error ? error.message : String(error)})`,
      "run `git for-ai reconcile --rebuild-map` to reconstruct it from trailers",
    );
  }
  if (entries.length === 0) {
    return ok("identity", "no changes tracked yet");
  }

  const inferred = entries.filter((e) => e.origin === "inferred" && e.folded_into === undefined);
  const orphan = entries.filter((e) => e.origin === "orphan-recovery");
  const trailer = entries.filter((e) => e.origin === "trailer-recovery");
  const divergent = entries.filter(
    (e) => e.divergent_heads !== undefined && e.divergent_heads.length > 0,
  );

  // Unreachable-heads audit (DESKTOP.md G1): a change whose head commit no ref can reach
  // (classically: `merge --squash` then branch delete, before the hook-time fold existed)
  // will lose that commit — and strand its notes — at the next gc. Metadata refs are
  // excluded: reachability must come from real branches/tags/remotes.
  const reachableRaw = await runGit(
    ["rev-list", "--branches", "--tags", "--remotes"],
    { ...ctx, allowFailure: true },
  );
  const reachable = new Set(
    reachableRaw.exitCode === 0
      ? reachableRaw.stdout.split(/\r?\n/).filter((s) => s.length > 0)
      : [],
  );
  const unreachable =
    reachable.size === 0
      ? [] // rev-list failed or empty repo — don't accuse anything
      : entries.filter((e) => e.folded_into === undefined && !reachable.has(e.head));

  const problems: string[] = [];
  const remediation: string[] = [];
  const repairs: DoctorRepair[] = [];
  if (inferred.length > 0) {
    // The inferred-origin audit: R4 continuation inference is the resolver's weakest evidence.
    problems.push(`${plural(inferred.length, "change")} with origin \`inferred\``);
    remediation.push(
      `inferred: verify with \`git for-ai show c/<id> --history\` (${inferred
        .slice(0, 3)
        .map((e) => `c/${e.change_id.slice(0, 8)}`)
        .join(", ")}${inferred.length > 3 ? ", …" : ""}); mis-attributions heal with \`git for-ai relink --detach <commit>\``,
    );
    repairs.push({
      action: "relink",
      what:
        "If one of these changes claimed a commit that isn't really part of it, detach " +
        "that commit so it gets its own identity back.",
      detach: true,
      needsCommit: true,
      changeIds: inferred.map((e) => e.change_id),
    });
  }
  if (orphan.length > 0) {
    problems.push(`${plural(orphan.length, "change")} from orphan-recovery`);
    remediation.push(
      "orphan-recovery: intent existed without a mapped commit — review those changes' ledger entries",
    );
  }
  if (trailer.length > 0) {
    problems.push(`${plural(trailer.length, "commit")} recovered via trailer (cherry-pick suspected)`);
    remediation.push("run `git for-ai reconcile` to heal the change-map eagerly");
    repairs.push({
      action: "reconcile",
      what:
        "Rebuild the links between commits and changes from what the commits themselves " +
        "record. Nothing is deleted; missing links are filled in.",
      detach: false,
      needsCommit: false,
      changeIds: trailer.map((e) => e.change_id),
    });
  }
  if (divergent.length > 0) {
    problems.push(`${plural(divergent.length, "change")} with divergent heads`);
    remediation.push("divergent heads: re-point the survivor with `git for-ai relink <change-id> <commit>`");
    repairs.push({
      action: "relink",
      what: "Point the change at the commit that survived, so its history has one end again.",
      detach: false,
      needsCommit: true,
      changeIds: divergent.map((e) => e.change_id),
    });
  }
  if (unreachable.length > 0) {
    problems.push(
      `${plural(unreachable.length, "change")} whose head no branch/tag reaches (will be lost at gc)`,
    );
    remediation.push(
      `unreachable heads: squash-merged-then-deleted branch suspected (${unreachable
        .slice(0, 3)
        .map((e) => `c/${e.change_id.slice(0, 8)}`)
        .join(", ")}${unreachable.length > 3 ? ", …" : ""}) — re-point with \`git for-ai relink <change-id> <commit>\`, or tag the head to keep it`,
    );
    repairs.push({
      action: "relink",
      what:
        "Point the change at a commit that is still on a branch, so its record isn't lost " +
        "the next time git cleans up.",
      detach: false,
      needsCommit: true,
      changeIds: unreachable.map((e) => e.change_id),
    });
  }

  if (problems.length === 0) {
    return ok("identity", `${plural(entries.length, "change")} tracked, no anomalies`);
  }
  return withRepairs(warn("identity", problems.join("; "), ...remediation), repairs);
}

interface LedgerAudit {
  ledger: DoctorCheck;
  sessions: DoctorCheck;
  captures: DoctorCheck;
}

async function checkLedgerAndSessions(repoRoot: string, ctx: GitContext): Promise<LedgerAudit> {
  // Enumerate annotated commits directly from the notes ref — never via the resolver
  // (non-minting discipline).
  const list = await runGit(["notes", `--ref=${INTENT_NOTES_REF}`, "list"], {
    ...ctx,
    allowFailure: true,
  });
  const notedShas =
    list.exitCode === 0 && list.stdout.length > 0
      ? list.stdout.split("\n").flatMap((line) => {
          const sha = line.split(" ")[1];
          return sha === undefined ? [] : [sha];
        })
      : [];

  let entryCount = 0;
  let legacyCount = 0;
  const unreadable: string[] = [];
  const allEntries: LedgerEntry[] = [];
  for (const sha of notedShas) {
    try {
      const read = await readLedgerNoteWithFormat(sha, ctx);
      if (read === null) continue;
      entryCount += read.note.entries.length;
      allEntries.push(...read.note.entries);
      if (read.format === "legacy-envelope") {
        legacyCount += 1;
      }
    } catch (error) {
      if (error instanceof LedgerNoteFormatError) {
        unreadable.push(sha);
      } else {
        throw error;
      }
    }
  }

  let ledger: DoctorCheck;
  if (unreadable.length > 0) {
    ledger = fail(
      "ledger",
      `${plural(unreadable.length, "unreadable note")} (${unreadable
        .slice(0, 3)
        .map((sha) => sha.slice(0, 8))
        .join(", ")}${unreadable.length > 3 ? ", …" : ""}) out of ${plural(notedShas.length, "noted commit")}`,
      "inspect with `git notes --ref=refs/notes/git-for-ai/intent show <sha>` — the data is intact, just unparseable",
    );
  } else if (legacyCount > 0) {
    ledger = warn(
      "ledger",
      `${plural(entryCount, "entry")} on ${plural(notedShas.length, "commit")}; ` +
        `${plural(legacyCount, "note")} still in the legacy envelope format`,
      "legacy notes migrate to JSONL on their next append; until then a divergent sync merge cannot union them",
    );
  } else if (notedShas.length === 0) {
    ledger = ok("ledger", "no intent notes yet");
  } else {
    ledger = ok("ledger", `${plural(entryCount, "entry")} on ${plural(notedShas.length, "commit")}, all readable (JSONL)`);
  }

  // Dangling session refs: every session_ref/session_refs must resolve to a stored blob.
  const referenced = new Set<string>();
  for (const entry of allEntries) {
    if (entry.session_ref !== undefined && entry.session_ref !== null) {
      referenced.add(entry.session_ref);
    }
    for (const ref of entry.session_refs ?? []) {
      referenced.add(ref);
    }
  }
  let stored = new Set<string>();
  let sessionsRefExists = true;
  try {
    const treeEntries = await lsTree(SESSIONS_REF, { ...ctx, recursive: true });
    stored = new Set(treeEntries.filter((e) => e.type === "blob").map((e) => e.path));
  } catch {
    sessionsRefExists = false;
  }
  const dangling = [...referenced].filter((ref) => {
    const hash = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : null;
    return hash === null || !stored.has(sessionShardPath(hash));
  });

  let sessions: DoctorCheck;
  if (referenced.size === 0) {
    sessions = ok("sessions", "no session refs recorded yet");
  } else if (!sessionsRefExists) {
    sessions = warn(
      "sessions",
      `${plural(referenced.size, "session ref")} recorded but the sessions ref does not exist`,
      "run `git for-ai sync --fetch` if the traces live on a remote; otherwise they were never stored here",
    );
  } else if (dangling.length > 0) {
    sessions = warn(
      "sessions",
      `${plural(dangling.length, "dangling session ref")} (ledger points at traces that are not stored)`,
      `first missing: ${dangling[0]}`,
      "run `git for-ai sync --fetch` if the traces live on a remote",
    );
  } else {
    sessions = ok("sessions", `${plural(referenced.size, "session ref")} recorded, all resolvable`);
  }

  // Skipped captures: fail-closed redaction leaves a redaction_note on the entry
  // (ARCHITECTURE.md §13); capture-time failures land in .git-for-ai/capture.log.
  const skipped = allEntries.filter((entry) => entry.redaction_note !== undefined);
  const captureLogLines = await countLogLines(join(repoRoot, ".git-for-ai", "capture.log"));
  let captures: DoctorCheck;
  if (skipped.length > 0) {
    captures = warn(
      "captures",
      `${plural(skipped.length, "session")} skipped (redaction fail-closed) — no trace was stored`,
      `see \`git for-ai show ${skipped[0]!.revision.slice(0, 8)}\` (redaction_note explains why)`,
    );
  } else if (captureLogLines > 0) {
    captures = warn(
      "captures",
      `.git-for-ai/capture.log records ${plural(captureLogLines, "line")} of capture problems`,
      "read .git-for-ai/capture.log (safe to delete once resolved)",
    );
  } else {
    captures = ok("captures", "no skipped captures");
  }

  return { ledger, sessions, captures };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", error: "✗" };

function render(data: DoctorData): string {
  const lines: string[] = ["git-for-ai doctor"];
  const width = Math.max(...data.checks.map((check) => check.name.length));
  for (const check of data.checks) {
    const dots = ".".repeat(width - check.name.length + 3);
    lines.push(`  ${check.name} ${dots} ${STATUS_GLYPH[check.status]} ${check.message}`);
    for (const step of check.remediation) {
      lines.push(`  ${" ".repeat(width + 5)}${step}`);
    }
  }
  lines.push(
    `Overall: ${plural(data.warnings, "warning")}, ${plural(data.errors, "error")}.` +
      (data.exitCode === 0 ? "" : `   [exit ${data.exitCode}]`),
  );
  return lines.join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** `git for-ai doctor`: read-only health audit with concrete remediation. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const cwd = options.cwd ?? process.cwd();
  const pathEnv = options.pathEnv ?? process.env["PATH"] ?? "";

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (toplevel.exitCode !== 0) {
    throw new Error(`not a git repository (or any parent up to mount point): ${cwd}`);
  }
  const repoRoot = resolve(toplevel.stdout);
  const ctx: GitContext = { cwd: repoRoot };
  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], ctx)).stdout;
  const gitDir = resolve(repoRoot, gitDirRaw);

  const checks: DoctorCheck[] = [];
  const { check: hooksCheck, installed } = await checkHooks(repoRoot, gitDir, ctx);
  checks.push(hooksCheck);
  checks.push(await checkDispatcher(installed, repoRoot, pathEnv));
  checks.push(await checkClaudeHooks(repoRoot));
  checks.push(await checkRefspecs(ctx));
  const { config, index, embedder } = await checkConfigAndIndex(repoRoot, ctx);
  checks.push(config, index, embedder);
  checks.push(await checkIdentity(ctx));
  const { ledger, sessions, captures } = await checkLedgerAndSessions(repoRoot, ctx);
  checks.push(ledger, sessions, captures);

  const warnings = checks.filter((check) => check.status === "warn").length;
  const errors = checks.filter((check) => check.status === "error").length;
  const data: DoctorData = {
    repoRoot,
    checks,
    warnings,
    errors,
    exitCode: warnings + errors > 0 ? 3 : 0,
  };
  return { data, output: render(data) };
}

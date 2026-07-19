// `git for-ai sync [--push|--fetch] [<remote>]` — Milestone 13 (architecture/CLI_PLAN.md,
// as amended by PLAN_2026-07-18.md W3). Explicit, manual push/fetch of the three intent
// refs. NEVER automatic, never piggybacked on `git push` (ARCHITECTURE.md §12.1); the
// vector index is never synced (it is derived — §8.2).
//
// The refs come from the `git-for-ai.refspec` config `init` wrote (init.ts judgment
// call #2): plain git ignores that key, so nothing auto-follows; this command reads it
// and passes the specs explicitly. W1-#5 validated that ordinary git remotes (including
// GitHub) round-trip all three ref namespaces, so sync targets any git remote — no
// server tier exists.
//
// ── Judgment calls (where the docs are loose, decided + documented here) ──
//
// 1. Fetch is INTEGRATE, not clobber. The configured refspecs are force (`+`) specs; a
//    plain `git fetch` with them would overwrite local refs and silently drop local
//    divergent entries. So fetch stages each remote ref under a private namespace and
//    integrates per ref kind, with an honest per-ref answer:
//      - intent notes  → real `git notes merge -s cat_sort_uniq` (the merge the JSONL
//        note format — DATA_MODEL.md §2.1 @2 — makes conflict-free by construction).
//        Staging lives under refs/notes/git-for-ai-sync/<remote>/… because git refuses
//        to merge notes from outside refs/notes/.
//      - sessions      → content-addressed union merge (core `mergeSessionsFrom`;
//        §12.2 "sessions never conflict").
//      - change-map    → fast-forward either way; a truly divergent map is REPORTED and
//        left local (the custom 3-way map merge is v1.1 — §12.3; `doctor`/`reconcile`
//        surface and heal it). Honesty over silent guessing.
//    Staging refs are deleted afterwards; they are outside every push pattern so they
//    can never leak to a remote.
// 2. `notes.git-for-ai/intent.mergeStrategy = cat_sort_uniq` is configured (idempotent)
//    per the M13 spec, so even a user-driven bare `git notes merge` unions correctly.
// 3. Push enumerates the CONCRETE local refs matching the configured patterns and
//    pushes them explicitly with `--porcelain`, so the report is per-ref and honest
//    (pushed / up to date / rejected), never a wildcard shrug. Default mode is fetch
//    THEN push, which makes the force-specs safe (remote entries were merged first);
//    a bare `--push` is still explicit user intent and keeps the force semantics.
// 4. The pre-push privacy reminder (CLI_REFERENCE transcript) is a real gate: an
//    injectable `confirm` (bin.ts wires the TTY prompt) or `--yes`. Off-TTY without
//    --yes is a refusal, not a silent push. `--dry-run` skips the gate (nothing leaves
//    the machine) and passes --dry-run through to `git push`.
// 5. Exit degradation: a rejected push or an unmerged divergent change-map yields
//    exitCode 2 (degraded-but-answered, CLI_REFERENCE conventions); infrastructure
//    failures (no remote, no refspecs) throw (exit 1).

import {
  runGit,
  listRefs,
  lsTree,
  notesMerge,
  mergeSessionsFrom,
  readLedgerNoteWithFormat,
  LedgerNoteFormatError,
  INTENT_NOTES_REF,
  SESSIONS_REF,
  CHANGE_MAP_REF,
  type GitContext,
} from "@git-for-ai/core";

// ─── Public types ────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** `--push` — push only. */
  push?: boolean;
  /** `--fetch` — fetch only. Default (neither flag): fetch then push. */
  fetch?: boolean;
  /** Remote name. Default `origin`. */
  remote?: string;
  /** `--dry-run` — report what would happen; move no data. */
  dryRun?: boolean;
  /** `--yes` — skip the pre-push confirmation (non-interactive use). */
  yes?: boolean;
  /**
   * Interactive pre-push confirmation (bin.ts wires the TTY [y/N] prompt; tests inject
   * answers). Receives the privacy reminder text; resolves true to proceed.
   */
  confirm?: (message: string) => Promise<boolean>;
}

/** What happened to one ref during the fetch phase. */
export type FetchAction =
  | "adopted" // no local ref existed; remote taken as-is
  | "up-to-date"
  | "fast-forwarded"
  | "local-ahead"
  | "merged" // union merge (notes cat_sort_uniq / sessions union)
  | "divergent-kept-local" // change-map (or unknown ref) divergence — reported, not merged
  | "would-fetch"; // dry-run only

export interface FetchRefReport {
  ref: string;
  action: FetchAction;
  detail?: string;
}

/** What happened to one ref during the push phase (git push --porcelain terms). */
export type PushAction = "pushed" | "up-to-date" | "rejected" | "would-push" | "skipped";

export interface PushRefReport {
  ref: string;
  action: PushAction;
  detail?: string;
}

export interface SyncResult {
  remote: string;
  mode: "both" | "push" | "fetch";
  dryRun: boolean;
  fetched: FetchRefReport[];
  pushed: PushRefReport[];
  /** True when the user declined the pre-push confirmation. */
  pushAborted: boolean;
  warnings: string[];
  /** 0 clean; 2 degraded (rejected push / unmerged divergence). */
  exitCode: 0 | 2;
  output: string;
}

// ─── Constants / small helpers ───────────────────────────────────────────────

/** git config key holding the refspecs (written by init — see init.ts). */
const REFSPEC_CONFIG_KEY = "git-for-ai.refspec";

/**
 * Notes-merge strategy config for the intent ref: `notes.<name>.mergeStrategy` where
 * <name> is the ref under refs/notes/ (git-config(1), notes.<name>.mergeStrategy).
 */
const NOTES_MERGE_STRATEGY_KEY = "notes.git-for-ai/intent.mergeStrategy";

/** Staging namespaces (outside every push pattern; notes staging must stay under refs/notes/). */
const NOTES_STAGING_PREFIX = "refs/notes/git-for-ai-sync";
const PLAIN_STAGING_PREFIX = "refs/git-for-ai-sync";

const sanitizeRemoteName = (remote: string): string => remote.replace(/[^A-Za-z0-9._-]/g, "-");

function toContext(options: SyncOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

async function isAncestor(maybeAncestor: string, descendant: string, ctx: GitContext): Promise<boolean> {
  const result = await runGit(["merge-base", "--is-ancestor", maybeAncestor, descendant], {
    ...ctx,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function refSha(ref: string, ctx: GitContext): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], {
    ...ctx,
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

/** A refspec's source pattern (`+src:dst` → `src`). */
function refspecSource(spec: string): string {
  const stripped = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = stripped.indexOf(":");
  return colon === -1 ? stripped : stripped.slice(0, colon);
}

/** Does `ref` match a (possibly `*`-suffixed) refspec source pattern? */
function matchesPattern(ref: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return ref === pattern;
  }
  return ref.startsWith(pattern.slice(0, star)) && ref.endsWith(pattern.slice(star + 1));
}

// ─── Fetch phase ─────────────────────────────────────────────────────────────

interface RemoteRef {
  ref: string;
  sha: string;
}

/** Concrete remote refs matching the configured source patterns (`git ls-remote`). */
async function listRemoteRefs(
  remote: string,
  patterns: string[],
  ctx: GitContext,
): Promise<RemoteRef[]> {
  const result = await runGit(["ls-remote", remote, ...patterns], ctx);
  const refs: RemoteRef[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    refs.push({ sha: line.slice(0, tab).trim(), ref: line.slice(tab + 1).trim() });
  }
  return refs;
}

/** The staging ref a remote ref is fetched into before integration (judgment call #1). */
function stagingRefFor(remoteRef: string, remote: string): string {
  const safeRemote = sanitizeRemoteName(remote);
  if (remoteRef.startsWith("refs/notes/")) {
    return `${NOTES_STAGING_PREFIX}/${safeRemote}/${remoteRef.slice("refs/notes/".length)}`;
  }
  return `${PLAIN_STAGING_PREFIX}/${safeRemote}/${remoteRef.slice("refs/".length)}`;
}

/**
 * Integrate one staged remote ref into its local counterpart, returning the honest
 * per-ref answer. `stagedSha` is the remote ref's value (already fetched locally).
 */
async function integrateRef(
  ref: string,
  stagedSha: string,
  stagingRef: string,
  ctx: GitContext,
  warnings: string[],
): Promise<FetchRefReport> {
  const localSha = await refSha(ref, ctx);

  if (localSha === null) {
    await runGit(["update-ref", ref, stagedSha], ctx);
    return { ref, action: "adopted" };
  }
  if (localSha === stagedSha) {
    return { ref, action: "up-to-date" };
  }

  if (ref === INTENT_NOTES_REF || ref.startsWith("refs/notes/")) {
    // The JSONL format's payoff: a REAL `git notes merge -s cat_sort_uniq`.
    const wasFastForward = await isAncestor(localSha, stagedSha, ctx);
    if (await isAncestor(stagedSha, localSha, ctx)) {
      return { ref, action: "local-ahead" };
    }
    await notesMerge(ref, stagingRef, { ...ctx, strategy: "cat_sort_uniq" });
    return wasFastForward
      ? { ref, action: "fast-forwarded" }
      : { ref, action: "merged", detail: "cat_sort_uniq union" };
  }

  if (ref === SESSIONS_REF) {
    const result = await mergeSessionsFrom(stagedSha, ctx);
    switch (result.action) {
      case "adopted":
        return { ref, action: "adopted" };
      case "up-to-date":
        return { ref, action: "up-to-date" };
      case "fast-forward":
        return { ref, action: "fast-forwarded" };
      case "local-ahead":
        return { ref, action: "local-ahead" };
      case "merged":
        return { ref, action: "merged", detail: "content-addressed union" };
    }
  }

  // change-map (and any future ref): fast-forward either way; report divergence.
  if (await isAncestor(localSha, stagedSha, ctx)) {
    await runGit(["update-ref", ref, stagedSha, localSha], ctx);
    return { ref, action: "fast-forwarded" };
  }
  if (await isAncestor(stagedSha, localSha, ctx)) {
    return { ref, action: "local-ahead" };
  }
  warnings.push(
    `${ref} has diverged from the remote and was NOT merged (local kept). ` +
      `Run \`git for-ai reconcile\` after reviewing — the change-map 3-way merge is a ` +
      `v1.1 surface (ARCHITECTURE.md §12.3).`,
  );
  return { ref, action: "divergent-kept-local" };
}

async function runFetchPhase(
  remote: string,
  patterns: string[],
  dryRun: boolean,
  ctx: GitContext,
  warnings: string[],
): Promise<FetchRefReport[]> {
  const remoteRefs = await listRemoteRefs(remote, patterns, ctx);
  const reports: FetchRefReport[] = [];

  for (const { ref, sha } of remoteRefs) {
    if (dryRun) {
      const localSha = await refSha(ref, ctx);
      reports.push(
        localSha === sha
          ? { ref, action: "up-to-date" }
          : { ref, action: "would-fetch", detail: `remote at ${sha.slice(0, 8)}` },
      );
      continue;
    }

    const stagingRef = stagingRefFor(ref, remote);
    try {
      await runGit(["fetch", "--no-tags", remote, `+${ref}:${stagingRef}`], ctx);
      reports.push(await integrateRef(ref, sha, stagingRef, ctx, warnings));
    } finally {
      await runGit(["update-ref", "-d", stagingRef], { ...ctx, allowFailure: true });
    }
  }
  return reports;
}

// ─── Push phase ──────────────────────────────────────────────────────────────

/** Concrete local refs matching the configured source patterns. */
async function listLocalSyncRefs(patterns: string[], ctx: GitContext): Promise<string[]> {
  const all = await listRefs(undefined, ctx);
  return all
    .map((info) => info.ref)
    .filter((ref) => patterns.some((pattern) => matchesPattern(ref, pattern)))
    .sort();
}

/** Count what a ref carries, for the pre-push privacy reminder. Never throws. */
async function describeRefPayload(ref: string, ctx: GitContext): Promise<string> {
  try {
    if (ref === INTENT_NOTES_REF) {
      const list = await runGit(["notes", `--ref=${ref}`, "list"], { ...ctx, allowFailure: true });
      const noted =
        list.exitCode === 0 && list.stdout.length > 0
          ? list.stdout.split("\n").flatMap((line) => {
              const annotated = line.split(" ")[1];
              return annotated === undefined ? [] : [annotated];
            })
          : [];
      let entries = 0;
      let unreadable = 0;
      for (const sha of noted) {
        try {
          const read = await readLedgerNoteWithFormat(sha, { ...ctx, ref });
          entries += read?.note.entries.length ?? 0;
        } catch (error) {
          if (error instanceof LedgerNoteFormatError) {
            unreadable += 1;
          } else {
            throw error;
          }
        }
      }
      const parts = [
        `${entries} entr${entries === 1 ? "y" : "ies"} on ${noted.length} commit${noted.length === 1 ? "" : "s"}`,
      ];
      if (unreadable > 0) {
        parts.push(`${unreadable} unreadable note${unreadable === 1 ? "" : "s"}`);
      }
      return parts.join(", ");
    }
    if (ref === SESSIONS_REF) {
      const entries = await lsTree(ref, { ...ctx, recursive: true });
      const traces = entries.filter((entry) => entry.type === "blob").length;
      return `${traces} trace${traces === 1 ? "" : "s"}, redacted`;
    }
    if (ref === CHANGE_MAP_REF) {
      const entries = await lsTree(ref, { ...ctx, recursive: true });
      const changes = entries.filter((entry) => entry.type === "blob").length;
      return `${changes} change${changes === 1 ? "" : "s"}`;
    }
  } catch {
    // fall through to the generic label
  }
  return "ref";
}

/** Parse one `git push --porcelain` status line into a per-ref report. */
function parsePorcelainLine(line: string): PushRefReport | null {
  // "<flag>\t<from>:<to>\t<summary>" where flag ∈ { ' ', '+', '-', '*', '=', '!' }
  if (line.length < 2 || line.startsWith("To ") || line === "Done") {
    return null;
  }
  const flag = line[0]!;
  const rest = line.slice(1).trim();
  const [fromTo, ...summaryParts] = rest.split("\t");
  const ref = fromTo?.split(":")[0]?.replace(/^\+/, "") ?? rest;
  const summary = summaryParts.join(" ");
  switch (flag) {
    case "=":
      return { ref, action: "up-to-date" };
    case "!":
      return { ref, action: "rejected", detail: summary };
    case " ":
    case "+":
    case "*":
    case "-":
      return { ref, action: "pushed", ...(summary !== "" ? { detail: summary } : {}) };
    default:
      return null;
  }
}

async function runPushPhase(
  remote: string,
  refs: string[],
  dryRun: boolean,
  ctx: GitContext,
): Promise<PushRefReport[]> {
  if (refs.length === 0) {
    return [];
  }
  const specs = refs.map((ref) => `+${ref}:${ref}`);
  const args = ["push", "--porcelain", ...(dryRun ? ["--dry-run"] : []), remote, ...specs];
  const result = await runGit(args, { ...ctx, allowFailure: true });
  // --porcelain reports per-ref status on stdout even when some refs are rejected
  // (exit code 1); only treat it as a hard failure when there is no status at all.
  const reports: PushRefReport[] = [];
  for (const line of result.stdout.split("\n")) {
    const parsed = parsePorcelainLine(line);
    if (parsed !== null) {
      reports.push(dryRun && parsed.action === "pushed" ? { ...parsed, action: "would-push" } : parsed);
    }
  }
  if (reports.length === 0 && result.exitCode !== 0) {
    throw new Error(`git push to ${remote} failed: ${result.stderr || result.stdout}`);
  }
  return reports;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<FetchAction | PushAction, string> = {
  adopted: "adopted (no local ref existed)",
  "up-to-date": "up to date",
  "fast-forwarded": "fast-forwarded",
  "local-ahead": "local ahead (nothing to fetch)",
  merged: "merged",
  "divergent-kept-local": "DIVERGED — local kept, not merged",
  "would-fetch": "would fetch",
  pushed: "pushed",
  rejected: "REJECTED",
  "would-push": "would push",
  skipped: "skipped",
};

function renderReports(
  title: string,
  reports: Array<{ ref: string; action: FetchAction | PushAction; detail?: string }>,
  lines: string[],
): void {
  lines.push(`${title}:`);
  if (reports.length === 0) {
    lines.push("  (no matching refs)");
    return;
  }
  const width = Math.max(...reports.map((report) => report.ref.length));
  for (const report of reports) {
    const label = ACTION_LABELS[report.action];
    lines.push(
      `  ${report.ref.padEnd(width)}  ${label}${report.detail !== undefined ? ` (${report.detail})` : ""}`,
    );
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * `git for-ai sync [--push|--fetch] [<remote>]`: explicit fetch/push of the three
 * intent refs against an ordinary git remote, with honest per-ref reporting.
 */
export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = toContext(options);
  const remote = options.remote ?? "origin";
  const dryRun = options.dryRun === true;
  const mode: SyncResult["mode"] =
    options.push === true && options.fetch !== true
      ? "push"
      : options.fetch === true && options.push !== true
        ? "fetch"
        : "both";

  // Fail loudly when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  // The refspecs init recorded — no refspecs means the repo never opted in.
  const configured = await runGit(["config", "--get-all", REFSPEC_CONFIG_KEY], {
    ...ctx,
    allowFailure: true,
  });
  const refspecs =
    configured.exitCode === 0
      ? configured.stdout.split("\n").filter((line) => line !== "")
      : [];
  if (refspecs.length === 0) {
    throw new Error(
      `no ${REFSPEC_CONFIG_KEY} config found — run \`git for-ai init\` in this repository first`,
    );
  }
  const patterns = refspecs.map(refspecSource);

  // The remote must exist (actionable error before any network activity).
  const remoteUrl = await runGit(["remote", "get-url", remote], { ...ctx, allowFailure: true });
  if (remoteUrl.exitCode !== 0) {
    throw new Error(`remote '${remote}' is not configured in this repository`);
  }

  // Judgment call #2: idempotently pin the notes merge strategy for the intent ref.
  const strategy = await runGit(["config", "--get", NOTES_MERGE_STRATEGY_KEY], {
    ...ctx,
    allowFailure: true,
  });
  if (strategy.exitCode !== 0 || strategy.stdout.trim() !== "cat_sort_uniq") {
    await runGit(["config", NOTES_MERGE_STRATEGY_KEY, "cat_sort_uniq"], ctx);
  }

  const warnings: string[] = [];
  let fetched: FetchRefReport[] = [];
  let pushed: PushRefReport[] = [];
  let pushAborted = false;

  if (mode !== "push") {
    fetched = await runFetchPhase(remote, patterns, dryRun, ctx, warnings);
  }

  if (mode !== "fetch") {
    const localRefs = await listLocalSyncRefs(patterns, ctx);
    if (localRefs.length === 0) {
      warnings.push("nothing to push — no local intent refs exist yet");
    } else if (dryRun) {
      pushed = await runPushPhase(remote, localRefs, true, ctx);
    } else {
      // Judgment call #4: the privacy gate.
      const payloadLines = await Promise.all(
        localRefs.map(async (ref) => `  ${ref.padEnd(34)}(${await describeRefPayload(ref, ctx)})`),
      );
      const reminder =
        `About to push session data to ${remote}. Session traces may contain code/context ` +
        `from your work.\n${payloadLines.join("\n")}\n` +
        `Review with \`git for-ai show <commit> --session\` before sharing.`;

      let proceed = options.yes === true;
      let declined = false;
      if (!proceed && options.confirm !== undefined) {
        proceed = await options.confirm(reminder);
        declined = !proceed;
      } else if (!proceed) {
        throw new Error(
          `refusing to push without confirmation — re-run with --yes, or from an ` +
            `interactive terminal.\n${reminder}`,
        );
      }

      if (proceed) {
        pushed = await runPushPhase(remote, localRefs, false, ctx);
      } else if (declined) {
        pushAborted = true;
        pushed = localRefs.map((ref) => ({ ref, action: "skipped" as const, detail: "aborted" }));
      }
    }
  }

  const rejected = pushed.filter((report) => report.action === "rejected");
  const divergent = fetched.filter((report) => report.action === "divergent-kept-local");
  const exitCode: 0 | 2 = rejected.length > 0 || divergent.length > 0 ? 2 : 0;

  // Render.
  const lines: string[] = [];
  lines.push(`sync with ${remote}${dryRun ? " (dry run — no data moved)" : ""}`);
  if (mode !== "push") {
    renderReports("fetch", fetched, lines);
  }
  if (mode !== "fetch") {
    renderReports("push", pushed, lines);
  }
  for (const warning of warnings) {
    lines.push(`! ${warning}`);
  }
  if (pushAborted) {
    lines.push("push aborted — nothing left this machine.");
  } else if (exitCode === 0) {
    const pushedCount = pushed.filter((r) => r.action === "pushed").length;
    if (mode !== "fetch" && pushedCount > 0) {
      lines.push(`✓ pushed ${pushedCount} ref${pushedCount === 1 ? "" : "s"} to ${remote}`);
    } else {
      lines.push("✓ sync complete");
    }
  } else {
    lines.push(
      `sync completed with problems (${rejected.length} rejected, ${divergent.length} divergent).`,
    );
  }

  return {
    remote,
    mode,
    dryRun,
    fetched,
    pushed,
    pushAborted,
    warnings,
    exitCode,
    output: lines.join("\n"),
  };
}

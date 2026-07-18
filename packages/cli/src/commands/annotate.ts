// `git for-ai annotate [<commit|c/change-id>]` — the deliberate intent write path
// (architecture/PLAN_2026-07-18.md §1.3). Everything the ledger records today is passively
// captured from hook events; this command lets an agent (or a human) *say* something on
// purpose: append a full ledger entry — summary plus the whole DATA_MODEL.md §2.5
// reasoning vocabulary (intent, constraints, rejected alternatives, confidence,
// scope_risk, reversibility, tested, related) — to any commit or change.
//
// Two input surfaces, designed agent-first:
//   - JSON on stdin (`--stdin`): a partial entry object (summary/reasoning/author/...),
//     validated field-by-field; this is the surface an agent should use.
//   - Flags (`--summary`, `--intent`, `--rejected "option::why"`, ...): the human surface.
//   Flags override same-named stdin fields, so a wrapper can pipe a base entry and still
//   patch one field on the command line.
//
// ── Judgment calls (the docs specify the data model, not this command — it's new) ──
//
// 1. Identity: annotate CALLS resolveChangeId, unlike log/show which deliberately avoid
//    minting identity on read. Writing intent REQUIRES an identity to anchor to, so for a
//    commit with none the resolver's R5 branch minting an orphan-recovery row is the
//    correct side effect of this (write) command, not pollution.
// 2. Scope: defaults to the commit's own diff (paths + post-image blob SHAs via
//    `git diff-tree`), because "what did this change touch" is derivable and the schema
//    requires blob SHAs an agent shouldn't have to compute. A deletion contributes its
//    pre-image blob (the post-image is the null SHA). Stdin may override `scope` wholesale;
//    it is trusted but schema-validated.
// 3. Author: `--as agent|human|mixed` (default: agent when --tool or --model given, else
//    human). `author.human` defaults to git's user.email — for an agent entry this
//    matches DATA_MODEL.md §2.3's "the human on the keyboard" accountability field.
// 4. Provenance: the closed §2.2 enum has no "deliberately annotated" value, so this
//    command writes `agent-captured` for agent-typed authors and `human-authored`
//    otherwise, and additionally sets `annotated: true` — a passthrough field
//    (DATA_MODEL.md §6: unknown fields survive round-trips) that readers can use to
//    distinguish deliberate annotation from passive capture. If a future schema rev adds
//    an `agent-annotated` provenance, this is the one place to change.

import {
  ledgerEntrySchema,
  reasoningSchema,
  type Author,
  type LedgerEntry,
  type LedgerNote,
  type Reasoning,
  type ScopeItem,
} from "@git-for-ai/schemas";
import {
  appendLedgerEntry,
  readChangeMapEntry,
  readAllChangeMapEntries,
  resolveChangeId,
  runGit,
  type GitContext,
} from "@git-for-ai/core";

// ─── Public types ────────────────────────────────────────────────────────────

export interface AnnotateOptions {
  /** Repository to operate on (`--repo`). Defaults to the current process cwd. */
  cwd?: string;
  /** Raw stdin content when `--stdin` was given: a JSON partial-entry object. */
  stdinJson?: string;
  /** `--summary` — the one-line "what changed". Required here or in stdin. */
  summary?: string;
  /** `--intent` — reasoning.intent. */
  intent?: string;
  /** `--constraint` (repeatable) — reasoning.constraints. */
  constraints?: string[];
  /** `--rejected "option::why"` (repeatable) — reasoning.rejected. */
  rejected?: string[];
  /** `--confidence` — reasoning.confidence (0..1). */
  confidence?: number;
  /** `--scope-risk` — reasoning.scope_risk. */
  scopeRisk?: string;
  /** `--reversibility` — reasoning.reversibility. */
  reversibility?: string;
  /** `--directive` — reasoning.directive. */
  directive?: string;
  /** `--tested` (repeatable) — reasoning.tested. */
  tested?: string[];
  /** `--related` (repeatable) — reasoning.related. */
  related?: string[];
  /** `--as` — author.type. Default: agent if --tool/--model given, else human. */
  as?: string;
  /** `--tool` — author.tool (e.g. claude-code). */
  tool?: string;
  /** `--model` — author.model (e.g. claude-fable-5). */
  model?: string;
  /** `--session-ref` — link an existing session record (sha256:<64hex>). */
  sessionRef?: string;
}

export interface AnnotateResult {
  /** The commit the entry was anchored to. */
  sha: string;
  /** The change the entry belongs to. */
  changeId: string;
  /** The entry exactly as written (post-validation). */
  entry: LedgerEntry;
  /** Total entries now on the note (the new one is last and, by created_at, effective). */
  entryCount: number;
  /** Human-readable confirmation line. */
  output: string;
}

// ─── Stdin partial-entry shape ───────────────────────────────────────────────

// The stdin surface accepts a PARTIAL entry: any of these keys, each validated with the
// same schema fragment the full entry uses. Unknown keys are rejected loudly (an agent
// typo like "sumary" must not be silently dropped into passthrough).
const STDIN_KEYS = new Set([
  "summary",
  "reasoning",
  "scope",
  "author",
  "session_ref",
]);

interface StdinPartial {
  summary?: string;
  reasoning?: Reasoning;
  scope?: ScopeItem[];
  author?: Partial<Author>;
  session_ref?: string;
}

function parseStdinPartial(raw: string): StdinPartial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("--stdin input is not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--stdin input must be a JSON object (a partial ledger entry)");
  }
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !STDIN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `--stdin input has unrecognized key${unknown.length === 1 ? "" : "s"}: ` +
        `${unknown.join(", ")} — accepted: ${[...STDIN_KEYS].join(", ")}`,
    );
  }
  if (record["reasoning"] !== undefined) {
    const result = reasoningSchema.safeParse(record["reasoning"]);
    if (!result.success) {
      throw new Error(
        `--stdin reasoning is invalid: ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
  }
  return record as StdinPartial;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toContext(options: AnnotateOptions): GitContext {
  return options.cwd !== undefined ? { cwd: options.cwd } : {};
}

/** Parse a repeatable `--rejected "option::why"` value. */
function parseRejected(raw: string): { option: string; why: string } {
  const idx = raw.indexOf("::");
  if (idx <= 0 || idx === raw.length - 2) {
    throw new Error(
      `--rejected value must be "option::why" (got ${JSON.stringify(raw)})`,
    );
  }
  return { option: raw.slice(0, idx).trim(), why: raw.slice(idx + 2).trim() };
}

const NULL_SHA_RE = /^0+$/;

/**
 * Derive the default scope from the commit's own diff: every changed path with its
 * post-image blob SHA (pre-image for deletions). `--root` covers the initial commit;
 * `-r` recurses into directories. Merge commits diff against the first parent, matching
 * what `git show` presents as "the" change.
 */
async function deriveScope(sha: string, ctx: GitContext): Promise<ScopeItem[]> {
  const result = await runGit(
    ["diff-tree", "-r", "--root", "--no-commit-id", "--first-parent", "-z", sha],
    ctx,
  );
  // -z output: ":oldmode newmode oldsha newsha status\0path\0" per entry.
  const tokens = result.stdout.split("\0").filter((t) => t.length > 0);
  const scope: ScopeItem[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i];
    const path = tokens[i + 1];
    if (meta === undefined || path === undefined || !meta.startsWith(":")) {
      continue;
    }
    const parts = meta.slice(1).split(" ");
    const oldSha = parts[2];
    const newSha = parts[3];
    if (oldSha === undefined || newSha === undefined) {
      continue;
    }
    const blob = NULL_SHA_RE.test(newSha) ? oldSha : newSha;
    if (NULL_SHA_RE.test(blob)) {
      continue; // neither side has content (e.g. type-change edge) — nothing to anchor
    }
    scope.push({ path: path.replace(/\\/g, "/"), blob });
  }
  return scope;
}

/** Resolve `c/<change-id>` (full or unambiguous prefix) to its head commit. */
async function resolveChangeTarget(
  target: string,
  ctx: GitContext,
): Promise<{ sha: string; changeId: string }> {
  const raw = target.slice(2).toLowerCase();
  if (!/^[0-9a-f]{4,32}$/.test(raw)) {
    throw new Error(
      `'${target}' is not a valid change reference — expected c/<change-id> ` +
        `(4 to 32 lowercase hex characters after the c/ prefix)`,
    );
  }
  if (raw.length === 32) {
    const entry = await readChangeMapEntry(raw, ctx);
    if (entry === null) {
      throw new Error(`change c/${raw} not found in the change-map`);
    }
    return { sha: entry.head, changeId: entry.change_id };
  }
  const matches = (await readAllChangeMapEntries(ctx)).filter((entry) =>
    entry.change_id.startsWith(raw),
  );
  if (matches.length === 0) {
    throw new Error(`change c/${raw} not found in the change-map`);
  }
  if (matches.length > 1) {
    throw new Error(
      `change reference c/${raw} is ambiguous — matches: ${matches
        .map((entry) => `c/${entry.change_id}`)
        .join(", ")}`,
    );
  }
  const only = matches[0]!;
  return { sha: only.head, changeId: only.change_id };
}

/** Build the reasoning block from flags merged over the stdin partial. Flags win. */
function buildReasoning(options: AnnotateOptions, stdin: StdinPartial): Reasoning | undefined {
  const base: Reasoning = { ...(stdin.reasoning ?? {}) };
  if (options.intent !== undefined) base.intent = options.intent;
  if (options.constraints !== undefined && options.constraints.length > 0) {
    base.constraints = options.constraints;
  }
  if (options.rejected !== undefined && options.rejected.length > 0) {
    base.rejected = options.rejected.map(parseRejected);
  }
  if (options.confidence !== undefined) {
    if (Number.isNaN(options.confidence) || options.confidence < 0 || options.confidence > 1) {
      throw new Error(`--confidence must be a number between 0 and 1`);
    }
    base.confidence = options.confidence;
  }
  if (options.scopeRisk !== undefined) {
    base.scope_risk = options.scopeRisk as Reasoning["scope_risk"];
  }
  if (options.reversibility !== undefined) {
    base.reversibility = options.reversibility as Reasoning["reversibility"];
  }
  if (options.directive !== undefined) base.directive = options.directive;
  if (options.tested !== undefined && options.tested.length > 0) base.tested = options.tested;
  if (options.related !== undefined && options.related.length > 0) base.related = options.related;
  return Object.keys(base).length > 0 ? base : undefined;
}

async function buildAuthor(
  options: AnnotateOptions,
  stdin: StdinPartial,
  ctx: GitContext,
): Promise<Author> {
  const defaultType =
    options.tool !== undefined || options.model !== undefined ? "agent" : "human";
  const type = (options.as ?? stdin.author?.type ?? defaultType) as Author["type"];

  let human = stdin.author?.human;
  if (human === undefined) {
    const email = await runGit(["config", "--get", "user.email"], { ...ctx, allowFailure: true });
    if (email.exitCode === 0 && email.stdout.trim() !== "") {
      human = email.stdout.trim();
    }
  }

  const tool = options.tool ?? stdin.author?.tool;
  const model = options.model ?? stdin.author?.model;
  return {
    type,
    ...(tool !== undefined ? { tool } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(human !== undefined ? { human } : {}),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Append a deliberate ledger entry to `target` (commit-ish or `c/<change-id>`; default
 * HEAD). By append-only semantics (DATA_MODEL.md §2.4) the new entry has the newest
 * `created_at` and therefore becomes the effective one.
 */
export async function runAnnotate(
  target = "HEAD",
  options: AnnotateOptions = {},
): Promise<AnnotateResult> {
  const ctx = toContext(options);

  // Fail loudly (GitError) when cwd is not a git repository at all.
  await runGit(["rev-parse", "--git-dir"], ctx);

  const stdin = options.stdinJson !== undefined ? parseStdinPartial(options.stdinJson) : {};

  const summary = options.summary ?? stdin.summary;
  if (summary === undefined || summary.trim() === "") {
    throw new Error("a summary is required — pass --summary or include \"summary\" in --stdin JSON");
  }

  // Resolve the target to an anchoring commit + change identity (judgment call #1:
  // minting via the resolver is correct for a write command).
  let sha: string;
  let changeId: string;
  if (/^c\//i.test(target)) {
    ({ sha, changeId } = await resolveChangeTarget(target, ctx));
  } else {
    const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${target}^{commit}`], {
      ...ctx,
      allowFailure: true,
    });
    if (resolved.exitCode !== 0 || resolved.stdout.length === 0) {
      throw new Error(`cannot resolve '${target}' to a commit`);
    }
    sha = resolved.stdout;
    ({ changeId } = await resolveChangeId(sha, ctx));
  }

  const scope = stdin.scope ?? (await deriveScope(sha, ctx));
  const reasoning = buildReasoning(options, stdin);
  const author = await buildAuthor(options, stdin, ctx);
  const sessionRef = options.sessionRef ?? stdin.session_ref;

  const candidate = {
    schema: "git-for-ai/ledger-entry@1",
    change_id: changeId,
    revision: sha,
    created_at: new Date().toISOString(),
    author,
    scope,
    summary: summary.trim(),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(sessionRef !== undefined ? { session_ref: sessionRef } : {}),
    provenance: author.type === "human" ? "human-authored" : "agent-captured",
    // Passthrough marker distinguishing deliberate annotation from passive capture
    // (judgment call #4 in the header).
    annotated: true,
  };
  const validated = ledgerEntrySchema.safeParse(candidate);
  if (!validated.success) {
    throw new Error(
      `invalid annotation: ${validated.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const entry: LedgerEntry = validated.data;

  const note: LedgerNote = await appendLedgerEntry(changeId, entry, ctx);

  const output =
    `✓ annotated ${sha.slice(0, 7)} (c/${changeId}): "${entry.summary}"\n` +
    `  entry ${note.entries.length} of ${note.entries.length} — now effective` +
    (reasoning === undefined ? "" : `  [${Object.keys(reasoning).join(", ")}]`);

  return { sha, changeId, entry, entryCount: note.entries.length, output };
}

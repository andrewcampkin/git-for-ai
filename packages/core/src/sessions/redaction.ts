// The redaction pass — architecture/ARCHITECTURE.md §13. Three protections, all applied
// BEFORE any git write:
//
//   1. Pattern-based secret scanning: a built-in, versioned ruleset (AWS keys,
//      GitHub/GitLab tokens, private-key blocks, high-entropy assignments, JWTs,
//      connection strings). Matches are replaced with `«redacted:rule-name»` and counted.
//   2. Configurable ignore-globs: spans that touched a file matching a `never_capture`
//      glob have their content excluded entirely — only the fact the file was touched
//      (the span's name + file attribute) is recorded.
//   3. Content-size caps: span-body strings past `maxSpanBytes` are truncated with a
//      `«truncated»` marker.
//
// Redaction is FAIL-CLOSED (ARCHITECTURE.md §16.5): any error thrown out of
// `redactSpans` means the caller must NOT write the session trace. The orchestrator
// (./capture.ts) enforces that; this module's contract is simply "throws = unusable".
//
// Judgment call on `redaction.rules` (recorded per session record): DATA_MODEL.md §3.4's
// worked example lists only the rules whose patterns actually MATCHED (["aws-key",
// "generic-token"] alongside redacted_count 3), so that is what this module reports —
// the rules that fired, not the whole active ruleset. The active ruleset version lives in
// `.git-for-ai/config.toml` (`redaction.ruleset = "builtin@1"`).

import type { RedactionInfo, Span } from "@git-for-ai/schemas";

/** Version identifier of the built-in ruleset below (config.toml `redaction.ruleset`). */
export const BUILTIN_RULESET_VERSION = "builtin@1";

/** Render the replacement marker for a rule: `«redacted:aws-key»`. */
export function redactionMarker(ruleId: string): string {
  return `«` + `redacted:${ruleId}` + `»`;
}

/** Marker appended where a span-body string was cut at the size cap. */
export const TRUNCATED_MARKER = "«truncated»";

/**
 * One redaction rule. `apply` returns the redacted text plus how many replacements it
 * made. Rules are plain functions (not bare regexes) so composite rules — like the
 * entropy-gated generic-token rule — and test-injected failing rules share one shape.
 */
export interface RedactionRule {
  /** Stable id, recorded in the session record's `redaction.rules` when it fires. */
  readonly id: string;
  apply(text: string): { text: string; count: number };
}

/** Build a simple whole-match-replacing rule from a global regex. */
export function patternRule(id: string, pattern: RegExp): RedactionRule {
  if (!pattern.global) {
    throw new Error(`redaction rule "${id}": pattern must have the global flag`);
  }
  const marker = redactionMarker(id);
  return {
    id,
    apply(text) {
      let count = 0;
      const redacted = text.replace(pattern, () => {
        count += 1;
        return marker;
      });
      return { text: redacted, count };
    },
  };
}

// ─── Built-in rules (ARCHITECTURE.md §13's pattern list) ─────────────────────

/**
 * Entropy gate for the generic-token rule: a value only counts as secret-shaped when it
 * is long, mixes letters and digits, and isn't dominated by a couple of repeated
 * characters — so `retries = 10`, `name = "session-store-refactor"` and similar ordinary
 * assignments never fire even when the key name contains a trigger word.
 */
function looksHighEntropy(value: string): boolean {
  if (value.length < 16) {
    return false;
  }
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) {
    return false;
  }
  return new Set(value).size >= 8;
}

/**
 * `KEY=...` / `token: "..."` style assignments where the key name contains a secret
 * trigger word and the value is high-entropy. Only the VALUE is replaced — the key name
 * and separator are preserved so the surrounding text stays readable.
 */
function genericTokenRule(): RedactionRule {
  const id = "generic-token";
  const marker = redactionMarker(id);
  const pattern =
    /([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential|bearer|auth)[A-Za-z0-9_.-]*\s*[=:]\s*["']?)([A-Za-z0-9+/=_.-]{16,})(["']?)/gi;
  return {
    id,
    apply(text) {
      let count = 0;
      const redacted = text.replace(pattern, (full, prefix: string, value: string, suffix: string) => {
        if (!looksHighEntropy(value)) {
          return full;
        }
        count += 1;
        return `${prefix}${marker}${suffix}`;
      });
      return { text: redacted, count };
    },
  };
}

/**
 * The §13 built-in ruleset. Order matters mildly (more specific first, so e.g. a GitHub
 * token inside an assignment is attributed to `github-token`, not `generic-token`).
 */
export const BUILTIN_REDACTION_RULES: readonly RedactionRule[] = [
  // AWS access key ids: fixed 4-char prefix + 16 uppercase alphanumerics.
  patternRule("aws-key", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g),
  // GitHub tokens: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
  patternRule("github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g),
  // GitLab personal access tokens.
  patternRule("gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g),
  // PEM private key blocks (RSA/EC/OPENSSH/PGP/unlabelled), entire block including headers.
  patternRule(
    "private-key-block",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  ),
  // JWTs: three dot-separated base64url segments, header always starts `eyJ` ("{").
  patternRule("jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g),
  // Connection strings with inline credentials: scheme://user:password@host...
  patternRule(
    "connection-string",
    /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s@"'`]+@[^\s"'`]+/g,
  ),
  // High-entropy `key = value` assignments (entropy-gated; see above).
  genericTokenRule(),
];

// ─── Ignore-globs (config.toml `capture.never_capture`) ──────────────────────

/**
 * Convert one shell-style glob (`.env*`, `*.pem`, `*secrets*`) to a full-match regex.
 * `*` matches any run of characters (including none), `?` exactly one; everything else
 * is literal. Deliberately simple — no `**`/brace/character-class support — matching the
 * simple default patterns DATA_MODEL.md §5 ships.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * True when `filePath` matches any `never_capture` glob. Globs are tested against both
 * the file's basename (the common case — `.env*`, `id_rsa*`) and its full
 * slash-normalized path (so `config/secrets/*`-style patterns also work).
 */
export function matchesNeverCapture(filePath: string, globs: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return globs.some((glob) => {
    const re = globToRegExp(glob);
    return re.test(basename) || re.test(normalized);
  });
}

// ─── Applying the pass to spans ──────────────────────────────────────────────

export interface RedactSpansOptions {
  /** Rules to run. Defaults to {@link BUILTIN_REDACTION_RULES}. */
  rules?: readonly RedactionRule[];
  /** `never_capture` ignore-globs (config.toml). Default: none. */
  ignoreGlobs?: readonly string[];
  /** Size cap for individual span-body strings, in bytes. Default 16384 (DATA_MODEL.md §5). */
  maxSpanBytes?: number;
}

export interface RedactSpansResult {
  /** The redacted spans (deep copies — inputs are never mutated). */
  spans: Span[];
  /** The `redaction` block for the session record (DATA_MODEL.md §3.2). */
  redaction: RedactionInfo;
}

/** Default span-body size cap, matching config.toml's default `max_span_bytes`. */
export const DEFAULT_MAX_SPAN_BYTES = 16384;

/** Body substituted for a span whose file matched a `never_capture` glob. */
const NEVER_CAPTURE_BODY = { omitted: "content excluded by never_capture glob" };

function redactStringWithRules(
  text: string,
  rules: readonly RedactionRule[],
  firedRules: Set<string>,
): { text: string; count: number } {
  let current = text;
  let total = 0;
  for (const rule of rules) {
    const { text: next, count } = rule.apply(current);
    if (count > 0) {
      firedRules.add(rule.id);
      total += count;
    }
    current = next;
  }
  return { text: current, count: total };
}

/** Truncate a string to the byte cap (cut at a character boundary), marking the cut. */
function truncateToByteCap(text: string, maxBytes: number): string | null {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return null;
  }
  // Binary-search the largest character length whose UTF-8 encoding fits the cap.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low) + TRUNCATED_MARKER;
}

interface WalkCounters {
  redacted: number;
  truncated: number;
}

/**
 * Deep-walk a JSON-ish value, redacting every string. `capBytes` is null for values
 * (like span attributes) that are not subject to the size cap.
 */
function redactValue(
  value: unknown,
  rules: readonly RedactionRule[],
  firedRules: Set<string>,
  capBytes: number | null,
  counters: WalkCounters,
): unknown {
  if (typeof value === "string") {
    const { text, count } = redactStringWithRules(value, rules, firedRules);
    counters.redacted += count;
    if (capBytes !== null) {
      const truncated = truncateToByteCap(text, capBytes);
      if (truncated !== null) {
        counters.truncated += 1;
        return truncated;
      }
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, rules, firedRules, capBytes, counters));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      out[key] = redactValue(source[key], rules, firedRules, capBytes, counters);
    }
    return out;
  }
  return value;
}

/**
 * Run the full §13 redaction pass over a span list: ignore-glob exclusion first (a span
 * whose `attributes.file` matches a `never_capture` glob keeps only the fact of the
 * touch — name + file attribute — with its body replaced), then pattern redaction over
 * every string in `attributes` and `body`, then the size cap over body strings.
 *
 * THROWS on any internal error (including a rule whose `apply` throws) — callers must
 * treat a throw as "do not write the trace" (fail-closed, §13). Never mutates its input.
 */
export function redactSpans(spans: readonly Span[], options: RedactSpansOptions = {}): RedactSpansResult {
  const rules = options.rules ?? BUILTIN_REDACTION_RULES;
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const maxSpanBytes = options.maxSpanBytes ?? DEFAULT_MAX_SPAN_BYTES;

  const firedRules = new Set<string>();
  const counters: WalkCounters = { redacted: 0, truncated: 0 };

  const redactedSpans = spans.map((span): Span => {
    const out: Span = { ...span };

    const file = span.attributes?.["file"];
    if (
      typeof file === "string" &&
      ignoreGlobs.length > 0 &&
      matchesNeverCapture(file, ignoreGlobs)
    ) {
      // Only the fact the file was touched is recorded (§13): keep span identity and the
      // file attribute, drop every content-bearing field.
      out.attributes = { file };
      out.body = { ...NEVER_CAPTURE_BODY };
      return out;
    }

    if (span.attributes !== undefined) {
      out.attributes = redactValue(span.attributes, rules, firedRules, null, counters) as Record<
        string,
        unknown
      >;
    }
    if (span.body !== undefined) {
      out.body = redactValue(span.body, rules, firedRules, maxSpanBytes, counters) as Record<
        string,
        unknown
      >;
    }
    return out;
  });

  return {
    spans: redactedSpans,
    redaction: {
      applied: true,
      rules: [...firedRules].sort(),
      redacted_count: counters.redacted,
      truncated_count: counters.truncated,
    },
  };
}

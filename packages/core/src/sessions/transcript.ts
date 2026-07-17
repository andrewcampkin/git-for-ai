// The versioned Claude Code transcript adapter — architecture/ARCHITECTURE.md §10.2.
//
// Claude Code's session transcript is a JSONL file (one JSON object per line) whose
// format is EXPLICITLY INTERNAL AND UNSTABLE. Everything that touches it is therefore
// isolated behind this adapter, which:
//
//   - carries a format fingerprint ({@link CLAUDE_CODE_TRANSCRIPT_FINGERPRINT}) recorded
//     in every session record (`source_fingerprint`) for future re-parse audits;
//   - parses DEFENSIVELY: an unparseable or unrecognized line is skipped and counted,
//     never thrown on;
//   - reports `ok: false` (degrade to plan-only capture, §10.2/§14) when the overall
//     shape is unrecognizable, rather than guessing or crashing — a hook must never
//     break the user's commit.
//
// The shape assumed (stable across observed Claude Code versions, but held loosely):
// each line has a `type` field ("user" | "assistant" | ...); assistant lines carry
// `message.content` arrays of blocks ({type:"text", text} | {type:"tool_use", name,
// input}); lines may carry `timestamp` (ISO 8601) and `version` (Claude Code version);
// assistant lines may carry `message.model`.

import type { Span } from "@git-for-ai/schemas";

/** Fingerprint of the transcript format this adapter understands (recorded per record). */
export const CLAUDE_CODE_TRANSCRIPT_FINGERPRINT = "claude-code-jsonl@1";

/** `source_fingerprint` used when capture degraded to plan-only (no usable transcript). */
export const PLAN_ONLY_FINGERPRINT = "plan-only@1";

/** Metadata scraped opportunistically from the transcript (best-effort, may be absent). */
export interface TranscriptMeta {
  /** Model id from the newest assistant line seen (e.g. `claude-opus-4-8`). */
  model?: string;
  /** Claude Code version from the newest line that carried one. */
  version?: string;
}

export type ParseTranscriptResult =
  | {
      ok: true;
      /** Normalized spans (DATA_MODEL.md §3.3), temporal order, ids assigned s1..sN. */
      spans: Span[];
      /** Total raw line count of the file — record as the next capture's `sinceLine`. */
      totalLines: number;
      /** Lines inside the slice that could not be parsed/recognized (skipped, counted). */
      skippedLines: number;
      meta: TranscriptMeta;
    }
  | {
      ok: false;
      /** Why the format was unrecognizable — surfaced in the capture result and doctor. */
      reason: string;
      totalLines: number;
    };

export interface ParseTranscriptOptions {
  /**
   * Slice marker: number of raw lines already consumed by a previous capture
   * (ARCHITECTURE.md §10.2 — "slice, don't dump"). Lines before this offset are ignored.
   * Default 0 (whole transcript).
   */
  sinceLine?: number;
}

/** Loosely-typed view of one parsed transcript line. */
interface TranscriptLine {
  type: string;
  timestamp: string | undefined;
  version: string | undefined;
  model: string | undefined;
  content: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize a transcript timestamp to RFC 3339 UTC `Z` form; undefined when unusable. */
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

/** Parse one raw JSONL line into the loose shape above; null = skip (unrecognizable). */
function parseLine(raw: string): TranscriptLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    return null;
  }
  const message = isRecord(parsed["message"]) ? parsed["message"] : undefined;
  const content = Array.isArray(message?.["content"]) ? (message["content"] as unknown[]) : [];
  return {
    type: parsed["type"],
    timestamp: optionalString(parsed["timestamp"]),
    version: optionalString(parsed["version"]),
    model: optionalString(message?.["model"]),
    content,
  };
}

/** Build the attributes object for a tool_use block, keeping only well-known keys. */
function toolAttributes(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const attributes: Record<string, unknown> = {};
  const file = optionalString(input["file_path"]);
  if (file !== undefined) {
    attributes["file"] = file;
  }
  const command = optionalString(input["command"]);
  if (command !== undefined) {
    attributes["command"] = command;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

/**
 * Parse (a slice of) a Claude Code JSONL transcript into normalized DATA_MODEL.md §3.3
 * spans:
 *
 *   - `ExitPlanMode` tool_use blocks    -> `agent.plan` spans (body.plan)
 *   - every other tool_use block        -> `gen_ai.tool.execution` spans (name + file/command attrs)
 *   - assistant text blocks             -> `gen_ai.completion` spans (body.text)
 *
 * Never throws on malformed content: individual bad lines are skipped and counted; a
 * transcript whose sliced lines contain nothing recognizable at all returns `ok: false`
 * so the caller degrades to plan-only capture (§10.2).
 */
export function parseTranscriptSlice(
  content: string,
  options: ParseTranscriptOptions = {},
): ParseTranscriptResult {
  const sinceLine = Math.max(0, options.sinceLine ?? 0);

  const rawLines = content.split(/\r?\n/);
  // A trailing newline yields one empty final element; don't count it as a line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const totalLines = rawLines.length;

  // A marker beyond the file means the transcript was rotated/replaced since the last
  // capture — fall back to the whole file rather than slicing into nothing.
  const effectiveSince = sinceLine <= totalLines ? sinceLine : 0;
  const slice = rawLines.slice(effectiveSince);

  const spans: Span[] = [];
  const meta: TranscriptMeta = {};
  let skippedLines = 0;
  let recognizedLines = 0;
  let nonEmptyLines = 0;
  let spanCounter = 0;

  const nextSpanId = (): string => {
    spanCounter += 1;
    return `s${spanCounter}`;
  };

  for (const raw of slice) {
    if (raw.trim() === "") {
      continue;
    }
    nonEmptyLines += 1;

    const line = parseLine(raw);
    if (line === null) {
      skippedLines += 1;
      continue;
    }
    recognizedLines += 1;

    if (line.version !== undefined) {
      meta.version = line.version;
    }
    if (line.model !== undefined) {
      meta.model = line.model;
    }

    if (line.type !== "assistant") {
      continue; // user/tool-result/system lines carry no span content we capture.
    }

    const timestamp = normalizeTimestamp(line.timestamp);
    const timing =
      timestamp !== undefined ? ({ start: timestamp, end: timestamp } as const) : ({} as const);

    for (const block of line.content) {
      if (!isRecord(block) || typeof block["type"] !== "string") {
        continue;
      }

      if (block["type"] === "text") {
        const text = optionalString(block["text"]);
        if (text !== undefined && text.trim().length > 0) {
          spans.push({ span_id: nextSpanId(), kind: "gen_ai.completion", ...timing, body: { text } });
        }
        continue;
      }

      if (block["type"] === "tool_use") {
        const name = optionalString(block["name"]);
        if (name === undefined) {
          continue;
        }
        const input = isRecord(block["input"]) ? block["input"] : {};

        if (name === "ExitPlanMode") {
          const plan = optionalString(input["plan"]);
          if (plan !== undefined) {
            spans.push({ span_id: nextSpanId(), kind: "agent.plan", ...timing, body: { plan } });
          }
          continue;
        }

        const attributes = toolAttributes(input);
        spans.push({
          span_id: nextSpanId(),
          kind: "gen_ai.tool.execution",
          name,
          ...timing,
          ...(attributes !== undefined ? { attributes } : {}),
        });
      }
    }
  }

  // Format-recognizability check: a non-empty slice in which NOTHING parsed as a
  // transcript line means the format has drifted — degrade rather than pretend.
  if (nonEmptyLines > 0 && recognizedLines === 0) {
    return {
      ok: false,
      reason:
        "transcript format not recognized (no line matched the " +
        `${CLAUDE_CODE_TRANSCRIPT_FINGERPRINT} shape) — degrading to plan-only capture`,
      totalLines,
    };
  }

  return { ok: true, spans, totalLines, skippedLines, meta };
}

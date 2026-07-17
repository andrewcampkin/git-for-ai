// Integration tests for the capture orchestrator (./capture.ts) against REAL fixture
// repos with REAL commits — the full ARCHITECTURE.md §10.1 flow: a format-accurate
// synthetic transcript + a maybe-commit hook payload produce a content-addressed,
// schema-valid, redacted session object under refs/git-for-ai/sessions and a ledger
// entry carrying its session_ref. Plus the self-filter (non-commit commands skip), the
// plan-only degradation for unrecognizable transcripts, the fail-closed redaction path,
// and the never-throws contract.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionRecordSchema } from "@git-for-ai/schemas";

import { createFixtureRepo, type FixtureRepo } from "../git/index.js";
import { findEntryByCommitSha } from "../identity/changeMap.js";
import { canonicalJsonStringify } from "../ledger/effective.js";
import { readLedgerEntries } from "../ledger/intentNotes.js";
import {
  captureSession,
  isGitCommitCommand,
  toolResponseIndicatesFailure,
} from "./capture.js";
import { PLAN_ONLY_FINGERPRINT, CLAUDE_CODE_TRANSCRIPT_FINGERPRINT } from "./transcript.js";
import { readSessionRecord, readSessionsCommit } from "./store.js";
import { readSessionCaptureState } from "./state.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SESSION_ID = "b1e2c3d4-5678-90ab-cdef-1234567890ab";

/** A format-accurate transcript: plan, an Edit, a Bash run, a final text turn with a secret. */
function fixtureTranscript(): string {
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-17T09:04:55.000Z",
      message: { content: [{ type: "text", text: "make auth stateless" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:05:00.000Z",
      version: "2.0.13",
      message: {
        model: "claude-opus-4-8",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "ExitPlanMode",
            input: { plan: "1. Extract session logic\n2. Signed cookies\n3. Tests" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:06:10.000Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "src/auth.ts" } },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:07:00.000Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:08:00.000Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Done. Old creds AKIAIOSFODNN7EXAMPLE are rotated out." },
        ],
      },
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function commitPayload(repo: FixtureRepo, transcriptPath: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd: repo.dir,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "switch to signed cookies"' },
    tool_response: { stdout: "[main abc1234] switch to signed cookies", stderr: "", interrupted: false },
    ...overrides,
  };
}

let repo: FixtureRepo;
let transcriptPath: string;

beforeEach(async () => {
  repo = await createFixtureRepo();
  transcriptPath = join(repo.dir, "fixture-transcript.jsonl");
  await writeFile(transcriptPath, fixtureTranscript(), "utf8");
});

afterEach(async () => {
  await repo.cleanup();
});

describe("captureSession — full capture path (maybe-commit)", () => {
  it("captures a real commit: session object + ledger entry + change-map row", async () => {
    const head = await repo.commit("switch to signed cookies", {
      files: { "src/auth.ts": "export const store = 'signed-cookie';\n" },
    });

    const result = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit");
    if (result.status !== "captured") throw new Error(`expected captured, got ${JSON.stringify(result)}`);

    expect(result.commitSha).toBe(head);
    expect(result.degraded).toBe(false);
    expect(result.sessionRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.spanCount).toBe(4); // plan + Edit + Bash + completion

    // The session object exists under the sessions ref and parses against the schema.
    const record = await readSessionRecord(result.sessionRef!, { cwd: repo.dir });
    expect(record).not.toBeNull();
    const parsed = sessionRecordSchema.parse(record);
    expect(parsed.session_id).toBe(SESSION_ID);
    expect(parsed.agent).toEqual({ tool: "claude-code", version: "2.0.13", model: "claude-opus-4-8" });
    expect(parsed.commit_range.until).toBe(head);
    expect(parsed.source_fingerprint).toBe(CLAUDE_CODE_TRANSCRIPT_FINGERPRINT);
    expect(parsed.spans.map((s) => s.kind)).toEqual([
      "agent.plan",
      "gen_ai.tool.execution",
      "gen_ai.tool.execution",
      "gen_ai.completion",
    ]);

    // Correctly content-addressed: recompute sha256 over the canonical serialization.
    const recomputed = createHash("sha256")
      .update(canonicalJsonStringify(record), "utf8")
      .digest("hex");
    expect(`sha256:${recomputed}`).toBe(result.sessionRef);

    // The redaction pass ran BEFORE the write: the AWS key never reached git.
    expect(JSON.stringify(record)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(parsed.redaction.applied).toBe(true);
    expect(parsed.redaction.rules).toContain("aws-key");
    expect(parsed.redaction.redacted_count).toBeGreaterThanOrEqual(1);
    expect(result.redactedCount).toBe(parsed.redaction.redacted_count);

    // The ledger entry carries the right session_ref and shape.
    const entries = await readLedgerEntries(head, { cwd: repo.dir });
    expect(entries).not.toBeNull();
    const entry = entries![entries!.length - 1]!;
    expect(entry.session_ref).toBe(result.sessionRef);
    expect(entry.change_id).toBe(result.changeId);
    expect(entry.revision).toBe(head);
    expect(entry.provenance).toBe("agent-captured");
    expect(entry.summary).toBe("switch to signed cookies");
    expect(entry.scope.map((s) => s.path)).toContain("src/auth.ts");
    expect(entry.reasoning?.intent).toContain("Extract session logic");

    // Identity was resolved and recorded in the change-map.
    const mapEntry = await findEntryByCommitSha(head, { cwd: repo.dir });
    expect(mapEntry).not.toBeNull();
    expect(mapEntry!.change_id).toBe(result.changeId);

    // The slice marker advanced.
    const state = await readSessionCaptureState(repo.dir, SESSION_ID);
    expect(state.last_captured_commit).toBe(head);
    expect(state.last_captured_line).toBe(5);
  });

  it("a second maybe-commit for the same HEAD is a skip, not a duplicate capture", async () => {
    await repo.commit("one", { files: { "a.txt": "a\n" } });
    const first = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit");
    expect(first.status).toBe("captured");

    const second = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit");
    expect(second.status).toBe("skipped");
    if (second.status === "skipped") {
      expect(second.reason).toContain("already captured");
    }
  });
});

describe("captureSession — the maybe-commit self-filter (§10.2)", () => {
  it.each([
    ["git status", "git status"],
    ["echo git commit", 'echo "git commit"'],
    ["git log mentioning commit", "git log --oneline -5"],
    ["grep for the words", "grep -r 'git commit' docs/"],
  ])("%s produces a skip, not a capture", async (_label, command) => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await captureSession(
      commitPayload(repo, transcriptPath, { tool_input: { command } }),
      "maybe-commit",
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("command is not a git commit");
    }
    expect(await readSessionsCommit({ cwd: repo.dir })).toBeNull(); // nothing written
  });

  it("a failed git commit (tool_response reports failure) is skipped", async () => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await captureSession(
      commitPayload(repo, transcriptPath, {
        tool_response: { stdout: "", stderr: "nothing to commit", exit_code: 1 },
      }),
      "maybe-commit",
    );
    expect(result.status).toBe("skipped");
    expect(await readSessionsCommit({ cwd: repo.dir })).toBeNull();
  });

  it("compound commands containing a real git commit DO capture", async () => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await captureSession(
      commitPayload(repo, transcriptPath, {
        tool_input: { command: 'git add -A && git commit -m "msg" && git push' },
      }),
      "maybe-commit",
    );
    expect(result.status).toBe("captured");
  });
});

describe("captureSession — plan buffering and plan-only degradation", () => {
  it("plan event buffers; unrecognizable transcript degrades to plan-only, never throws", async () => {
    const head = await repo.commit("base", { files: { "a.txt": "a\n" } });

    const planResult = await captureSession(
      {
        session_id: SESSION_ID,
        cwd: repo.dir,
        hook_event_name: "PostToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "1. Do the thing\n2. Verify it" },
      },
      "plan",
    );
    expect(planResult).toEqual({ status: "buffered-plan", sessionId: SESSION_ID });

    // Overwrite the transcript with something that is not our JSONL shape at all.
    await writeFile(transcriptPath, "totally not json\n<<< binary-ish garbage >>>\n", "utf8");

    const result = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit");
    if (result.status !== "captured") throw new Error(`expected captured, got ${JSON.stringify(result)}`);
    expect(result.degraded).toBe("plan-only");
    expect(result.degradedReason).toContain("not recognized");
    expect(result.sessionRef).toMatch(/^sha256:/);

    // The stored record is plan-only: the buffered plan span, fingerprinted as such.
    const record = await readSessionRecord(result.sessionRef!, { cwd: repo.dir });
    const parsed = sessionRecordSchema.parse(record);
    expect(parsed.source_fingerprint).toBe(PLAN_ONLY_FINGERPRINT);
    expect(parsed.spans.map((s) => s.kind)).toEqual(["agent.plan"]);
    expect(parsed.spans[0]!.body!["plan"]).toContain("Do the thing");

    // Ledger entry still written, pointing at the plan-only trace.
    const entries = await readLedgerEntries(head, { cwd: repo.dir });
    expect(entries![entries!.length - 1]!.session_ref).toBe(result.sessionRef);
  });

  it("a missing transcript file also degrades to plan-only rather than failing", async () => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await captureSession(
      commitPayload(repo, transcriptPath, { transcript_path: join(repo.dir, "gone.jsonl") }),
      "maybe-commit",
    );
    if (result.status !== "captured") throw new Error(`expected captured, got ${JSON.stringify(result)}`);
    expect(result.degraded).toBe("plan-only");
    expect(result.degradedReason).toContain("unreadable");
  });
});

describe("captureSession — fail-closed redaction (§13)", () => {
  it("a redaction error drops the trace but still writes the ledger entry", async () => {
    const head = await repo.commit("base", { files: { "a.txt": "a\n" } });

    const result = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit", {
      redactionRules: [
        {
          id: "boom",
          apply() {
            throw new Error("injected redaction failure");
          },
        },
      ],
    });

    if (result.status !== "captured") throw new Error(`expected captured, got ${JSON.stringify(result)}`);
    expect(result.sessionRef).toBeNull();

    // Fail-closed: NO session object was written at all.
    expect(await readSessionsCommit({ cwd: repo.dir })).toBeNull();

    // The ledger entry exists, without session_ref, and says why.
    const entries = await readLedgerEntries(head, { cwd: repo.dir });
    const entry = entries![entries!.length - 1]!;
    expect(entry.session_ref).toBeNull();
    expect(entry.redaction_note).toContain("redaction pass failed");
  });
});

describe("captureSession — never throws", () => {
  it.each([
    ["null payload", null],
    ["string payload", "not an object"],
    ["empty object", {}],
    ["missing session_id", { tool_name: "Bash", tool_input: { command: "git commit -m x" } }],
  ])("%s resolves to a structured result", async (_label, payload) => {
    const result = await captureSession(payload, "maybe-commit", { cwd: repo.dir });
    expect(["skipped", "failed-soft"]).toContain(result.status);
  });

  it("a maybe-commit against a repo with no commits yet is a skip", async () => {
    // repo has no commits in this test (no repo.commit call)
    const result = await captureSession(commitPayload(repo, transcriptPath), "maybe-commit");
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toContain("no HEAD commit");
    }
  });
});

describe("isGitCommitCommand (unit)", () => {
  it.each([
    ['git commit -m "x"', true],
    ["git commit --amend --no-edit", true],
    ['git add -A && git commit -m "x"', true],
    ["cd sub; git commit", true],
    ['git -c user.name=x commit -m "y"', true],
    ["git -C /repo commit", true],
    ["FOO=bar git commit", true],
    ["git status", false],
    ["git log --oneline", false],
    ['echo "git commit"', false],
    ["echo git commit", false],
    ["gitk commit", false],
    ["git commitish", false],
    ["", false],
  ])("%s -> %s", (command, expected) => {
    expect(isGitCommitCommand(command)).toBe(expected);
  });
});

describe("toolResponseIndicatesFailure (unit)", () => {
  it.each([
    [{ exit_code: 1 }, true],
    [{ exitCode: 128 }, true],
    [{ interrupted: true }, true],
    [{ is_error: true }, true],
    [{ success: false }, true],
    [{ exit_code: 0 }, false],
    [{ stdout: "ok", stderr: "" }, false],
    [undefined, false],
    ["plain text response", false],
  ])("%j -> %s", (response, expected) => {
    expect(toolResponseIndicatesFailure(response)).toBe(expected);
  });
});

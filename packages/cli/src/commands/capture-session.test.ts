// Tests for `git for-ai capture-session` (./capture-session.ts) against REAL fixture
// repos: the command's one hard rule is that it ALWAYS resolves successfully (exit-0
// semantics — a hook must never break the user's commit, ARCHITECTURE.md §10.2), logging
// failures to `.git-for-ai/capture.log` instead of throwing. Also covers the
// plan/maybe-commit dispatch and the payload-injection path used by the hook wiring.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runCaptureSession } from "./capture-session.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SESSION_ID = "cli-test-session-0001";

function transcriptJsonl(): string {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:05:00.000Z",
      version: "2.0.13",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "tool_use", id: "t1", name: "ExitPlanMode", input: { plan: "1. fix\n2. test" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/x.ts" } },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-17T09:06:00.000Z",
      message: { model: "claude-opus-4-8", content: [{ type: "text", text: "All done." }] },
    }),
  ];
  return `${lines.join("\n")}\n`;
}

let repo: FixtureRepo;
let transcriptPath: string;

beforeEach(async () => {
  repo = await createFixtureRepo();
  transcriptPath = join(repo.dir, "transcript.jsonl");
  await writeFile(transcriptPath, transcriptJsonl(), "utf8");
});

afterEach(async () => {
  await repo.cleanup();
});

function payloadJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd: repo.dir,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "a change"' },
    tool_response: { stdout: "ok", stderr: "", interrupted: false },
    ...overrides,
  });
}

describe("runCaptureSession — maybe-commit", () => {
  it("captures a real commit and appends the representative log line", async () => {
    const head = await repo.commit("a change", { files: { "src/x.ts": "export {};\n" } });

    const result = await runCaptureSession({
      event: "maybe-commit",
      payload: payloadJson(),
      cwd: repo.dir,
    });

    expect(result.outcome.status).toBe("captured");
    if (result.outcome.status !== "captured") return;
    expect(result.outcome.commitSha).toBe(head);
    expect(result.outcome.sessionRef).toMatch(/^sha256:/);

    // CLI_REFERENCE.md's representative log line shape.
    expect(result.logLine).toMatch(
      /^\[git-for-ai\] captured session [0-9a-z-]{8} -> commit [0-9a-f]{8} \(change [0-9a-f]{8}\), \d+ spans, \d+ redactions/,
    );

    // ...and it was persisted to .git-for-ai/capture.log. (Compared by suffix, not
    // full equality: on Windows the fixture tmpdir may use an 8.3 short name while
    // git reports the long form of the same directory.)
    expect(result.logFile).toMatch(/[\\/]\.git-for-ai[\\/]capture\.log$/);
    expect(existsSync(join(repo.dir, ".git-for-ai", "capture.log"))).toBe(true);
    const log = await readFile(result.logFile!, "utf8");
    expect(log).toContain(result.logLine);
  });

  it("a non-commit Bash command is a logged skip", async () => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await runCaptureSession({
      event: "maybe-commit",
      payload: payloadJson({ tool_input: { command: "git status" } }),
      cwd: repo.dir,
    });
    expect(result.outcome).toEqual({ status: "skipped", reason: "command is not a git commit" });
    expect(result.logLine).toContain("skipped: command is not a git commit");
  });
});

describe("runCaptureSession — plan", () => {
  it("buffers the plan and logs it", async () => {
    await repo.commit("base", { files: { "a.txt": "a\n" } });
    const result = await runCaptureSession({
      event: "plan",
      payload: JSON.stringify({
        session_id: SESSION_ID,
        cwd: repo.dir,
        tool_name: "ExitPlanMode",
        tool_input: { plan: "1. do it" },
      }),
      cwd: repo.dir,
    });
    expect(result.outcome).toEqual({ status: "buffered-plan", sessionId: SESSION_ID });
    expect(result.logLine).toContain("buffered plan");
    expect(existsSync(join(repo.dir, ".git-for-ai", "state.json"))).toBe(true);
  });
});

describe("runCaptureSession — ALWAYS resolves (exit-0 semantics)", () => {
  it("garbage (non-JSON) stdin payload resolves as failed-soft and is logged", async () => {
    const result = await runCaptureSession({
      event: "maybe-commit",
      payload: "this is { not json",
      cwd: repo.dir,
    });
    expect(result.outcome.status).toBe("failed-soft");
    expect(result.logLine).toContain("capture failed (soft)");
    // Even the failure gets logged to the repo's capture.log.
    expect(result.logFile).not.toBeNull();
    const log = await readFile(result.logFile!, "utf8");
    expect(log).toContain("capture failed (soft)");
  });

  it("an empty payload resolves as a skip", async () => {
    const result = await runCaptureSession({ event: "maybe-commit", payload: "", cwd: repo.dir });
    expect(result.outcome).toEqual({ status: "skipped", reason: "no hook payload on stdin" });
  });

  it("an unknown --event resolves as a skip, never a throw", async () => {
    const result = await runCaptureSession({
      event: "definitely-not-an-event",
      payload: payloadJson(),
      cwd: repo.dir,
    });
    expect(result.outcome.status).toBe("skipped");
    if (result.outcome.status === "skipped") {
      expect(result.outcome.reason).toContain('unknown --event');
    }
  });

  it("a payload pointing at a directory that is not a repo resolves (skip), no log file", async () => {
    // No commit, no .git anywhere near the transcript path's parent: point cwd at a
    // subdir that does not exist — resolveRepoRoot fails, capture skips, logging is
    // skipped gracefully.
    const result = await runCaptureSession({
      event: "maybe-commit",
      payload: payloadJson({ cwd: join(repo.dir, "does", "not", "exist") }),
      cwd: join(repo.dir, "does", "not", "exist"),
    });
    expect(["skipped", "failed-soft"]).toContain(result.outcome.status);
    expect(result.logFile).toBeNull();
  });
});

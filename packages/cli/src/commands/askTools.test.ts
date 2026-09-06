// Tests for the `ask` toolbox (./askTools.ts — architecture/ASK_TOOLS.md §4) against a
// REAL fixture repo driven through the real git binary (the no-mocks rule). No Anthropic
// API is involved here at all: these are the plain functions the answering model calls,
// so what is under test is that each one reads the repository correctly, degrades
// honestly, and reports bad arguments instead of throwing something unhelpful.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendLedgerEntry, assignChangeId, type SynthesisTool } from "@git-for-ai/core";
import {
  createFixtureRepo,
  makeLedgerEntry,
  type FixtureRepo,
} from "@git-for-ai/core/testing";

import { runInit } from "./init.js";
import { createAskTools, renderCommitDiff, MAX_TOOL_OUTPUT_CHARS } from "./askTools.js";
import { readCommitDiff } from "./reviewGit.js";

const AUTH_FILE = "src/auth/session.ts";

let repo: FixtureRepo;
let firstSha: string;
let secondSha: string;
let changeId: string;
let tools: Map<string, SynthesisTool>;

const call = async (name: string, input: Record<string, unknown>): Promise<string> => {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool.run(input);
};

beforeAll(async () => {
  repo = await createFixtureRepo();
  const ctx = { cwd: repo.dir };
  await runInit({ cwd: repo.dir, claudeHooks: false });

  firstSha = await repo.commit("Add the session module", {
    files: { [AUTH_FILE]: "export function signSessionCookie() {}\n" },
  });
  secondSha = await repo.commit("Move session state to signed cookies", {
    files: {
      [AUTH_FILE]: "export function signSessionCookie(secret: string) {}\n",
      "src/config/toml.ts": "export const parse = (raw: string) => raw;\n",
    },
  });
  ({ changeId } = await assignChangeId(secondSha, ctx));
  const blob = (await repo.run(["rev-parse", `${secondSha}:${AUTH_FILE}`])).stdout;
  await appendLedgerEntry(
    changeId,
    makeLedgerEntry({
      changeId,
      revision: secondSha,
      createdAt: "2026-07-17T10:00:00Z",
      summary: "Move session state to signed cookies",
      scopePath: AUTH_FILE,
      scopeBlob: blob,
      intent: "run more than one replica without sticky sessions",
      rejectedOption: "Redis session store",
      rejectedWhy: "avoid adding an infra dependency",
      confidence: 0.82,
    }),
    ctx,
  );

  tools = new Map(createAskTools({ cwd: repo.dir }).map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  await repo.cleanup();
});

describe("the toolbox contract", () => {
  it("exposes exactly the four v1 read tools, each with a when-to-call description", () => {
    expect([...tools.keys()].sort()).toEqual([
      "blame_why",
      "commit_diff",
      "log_intent",
      "show_change",
    ]);
    for (const tool of tools.values()) {
      // Judgment call #1: the description must say WHEN, not just what — an
      // under-triggered tool reproduces the exact bug this feature fixes.
      expect(tool.description).toMatch(/call this/i);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

describe("commit_diff — the failing question's answer", () => {
  it("names the real files a commit touched, with the patch", async () => {
    const output = await call("commit_diff", { sha: secondSha });

    expect(output).toContain(`commit ${secondSha}`);
    expect(output).toContain("subject: Move session state to signed cookies");
    expect(output).toContain(AUTH_FILE);
    expect(output).toContain("src/config/toml.ts");
    // Real patch content, with markers.
    expect(output).toContain("+export function signSessionCookie(secret: string) {}");
    expect(output).toContain("-export function signSessionCookie() {}");
    expect(output).toMatch(/2 file\(s\) changed, \+\d+ -\d+/);
  });

  it("accepts anything git accepts, including HEAD and short SHAs", async () => {
    const viaHead = await call("commit_diff", { sha: "HEAD" });
    const viaShort = await call("commit_diff", { sha: secondSha.slice(0, 8) });
    expect(viaHead).toContain(`commit ${secondSha}`);
    expect(viaShort).toContain(`commit ${secondSha}`);
  });

  it("labels a root commit honestly instead of pretending it has a parent", async () => {
    const output = await call("commit_diff", { sha: firstSha });
    expect(output).toContain("diffed against the empty tree (root commit)");
  });

  it("throws a resolvable message for a bad commit — the loop reports it to the model", async () => {
    await expect(call("commit_diff", { sha: "deadbeefdeadbeef" })).rejects.toThrow(/deadbeef/);
  });

  it("rejects a missing or malformed argument with a message that says how to fix it", async () => {
    await expect(call("commit_diff", {})).rejects.toThrow(/'sha' is required/);
    await expect(call("commit_diff", { sha: secondSha, context: 99 })).rejects.toThrow(
      /'context' must be an integer between 0 and 20/,
    );
  });
});

describe("show_change — the reasoning behind a change", () => {
  it("returns the captured intent, not just the commit subject", async () => {
    const output = await call("show_change", { target: secondSha });
    expect(output).toContain(changeId.slice(0, 8));
    expect(output).toContain("Move session state to signed cookies");
    expect(output).toContain("run more than one replica without sticky sessions");
    expect(output).toContain("Redis session store");
  });

  it("accepts a c/<change-id> target", async () => {
    const output = await call("show_change", { target: `c/${changeId}` });
    expect(output).toContain("Move session state to signed cookies");
  });

  it("degrades honestly for a commit with no captured intent", async () => {
    const output = await call("show_change", { target: firstSha });
    expect(output.toLowerCase()).toContain("no captured intent");
  });
});

describe("log_intent — what has been happening", () => {
  it("lists commits newest first with their intent annotation", async () => {
    const output = await call("log_intent", { n: 5 });
    expect(output).toContain("Move session state to signed cookies");
    expect(output).toContain("Add the session module");
    expect(output.indexOf("Move session state")).toBeLessThan(output.indexOf("Add the session"));
  });

  it("honors n and path", async () => {
    expect(await call("log_intent", { n: 1 })).not.toContain("Add the session module");
    const scoped = await call("log_intent", { path: "src/config/toml.ts" });
    expect(scoped).toContain("Move session state to signed cookies");
    expect(scoped).not.toContain("Add the session module");
  });

  it("rejects an out-of-range n", async () => {
    await expect(call("log_intent", { n: 500 })).rejects.toThrow(/between 1 and 50/);
  });
});

describe("blame_why — why one line looks the way it does", () => {
  it("explains a line from the captured intent, with no index built", async () => {
    // No `reindex` ran in this fixture: blame degrades to git records only rather than
    // failing, and no embedding model is ever loaded (the RAM rule).
    const output = await call("blame_why", { file: AUTH_FILE, line: 1 });
    expect(output).toContain("Move session state to signed cookies");
    expect(output).toContain("run more than one replica without sticky sessions");
  });

  it("requires both a file and a positive line number", async () => {
    await expect(call("blame_why", { file: AUTH_FILE })).rejects.toThrow(/'line' is required/);
    await expect(call("blame_why", { file: AUTH_FILE, line: 0 })).rejects.toThrow(/'line'/);
    await expect(call("blame_why", { line: 1 })).rejects.toThrow(/'file' is required/);
  });
});

describe("output caps (judgment call #3)", () => {
  it("truncates long output with an explicit notice, never silently", async () => {
    const tiny = new Map(
      createAskTools({ cwd: repo.dir, maxChars: 120 }).map((tool) => [tool.name, tool]),
    );
    const output = await tiny.get("commit_diff")!.run({ sha: secondSha });
    expect(output.length).toBeLessThan(400);
    expect(output).toContain("output truncated at 120 characters");
    expect(output).toContain("Ask for a narrower target");
  });

  it("defaults to a generous cap", () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(20_000);
  });
});

describe("renderCommitDiff", () => {
  it("carries the merge/truncation notices readCommitDiff produced", async () => {
    await repo.run(["checkout", "-b", "side", firstSha]);
    await repo.commit("side work", { files: { "side.txt": "s\n" } });
    await repo.run(["checkout", "main"]);
    await repo.run(["merge", "--no-ff", "-m", "merge side", "side"]);
    const merged = (await repo.run(["rev-parse", "HEAD"])).stdout;

    const rendered = renderCommitDiff(await readCommitDiff(merged, { cwd: repo.dir }));
    expect(rendered).toContain("(first parent — merge commit)");
    expect(rendered).toContain("note: Merge commit");
  });
});

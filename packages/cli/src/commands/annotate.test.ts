// Tests for `git for-ai annotate` (./annotate.ts) against REAL fixture repos: the
// deliberate intent write path. Covers both input surfaces
// (flags, stdin JSON), scope auto-derivation from the commit diff, append-only supersede
// semantics, c/<change-id> targets, and the loud-failure cases (missing summary, stdin
// typos, invalid reasoning values).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLedgerEntries, resolveEffectiveEntry, findEntryByCommitSha } from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runAnnotate } from "./annotate.js";

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

describe("runAnnotate — flags surface", () => {
  it("appends a full-reasoning entry to HEAD with scope derived from the commit diff", async () => {
    const sha = await repo.commit("Add auth module", {
      files: { "src/auth.ts": "export const auth = 1;\n", "src/util.ts": "export {};\n" },
    });

    const result = await runAnnotate("HEAD", {
      cwd: repo.dir,
      summary: "Introduce the auth module",
      intent: "Stateless auth so the API can scale horizontally",
      constraints: ["no new infra services"],
      rejected: ["Redis sessions::adds an infra dependency"],
      confidence: 0.9,
      scopeRisk: "medium",
      reversibility: "easy",
      tested: ["pnpm vitest run src/auth"],
      tool: "claude-code",
      model: "claude-fable-5",
    });

    expect(result.sha).toBe(sha);
    expect(result.changeId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.entryCount).toBe(1);
    expect(result.output).toContain("✓ annotated");
    expect(result.output).toContain(result.changeId);

    // Author defaulted to agent (tool/model given), human from git config user.email.
    expect(result.entry.author).toMatchObject({
      type: "agent",
      tool: "claude-code",
      model: "claude-fable-5",
      human: "fixture@git-for-ai.test",
    });
    expect(result.entry.provenance).toBe("agent-captured");
    // The deliberate-annotation passthrough marker survives schema validation.
    expect((result.entry as Record<string, unknown>)["annotated"]).toBe(true);

    expect(result.entry.reasoning).toMatchObject({
      intent: "Stateless auth so the API can scale horizontally",
      constraints: ["no new infra services"],
      rejected: [{ option: "Redis sessions", why: "adds an infra dependency" }],
      confidence: 0.9,
      scope_risk: "medium",
      reversibility: "easy",
      tested: ["pnpm vitest run src/auth"],
    });

    // Scope was derived from the commit's own diff, with real blob SHAs.
    const paths = result.entry.scope.map((s) => s.path).sort();
    expect(paths).toEqual(["src/auth.ts", "src/util.ts"]);
    for (const item of result.entry.scope) {
      expect(item.blob).toMatch(/^[0-9a-f]{40}$/);
    }

    // And it actually round-trips from the notes ref.
    const entries = await readLedgerEntries(sha, { cwd: repo.dir });
    expect(entries).toHaveLength(1);
    expect(entries![0]!.summary).toBe("Introduce the auth module");
  });

  it("writes human-authored provenance for a human entry (no tool/model)", async () => {
    await repo.commit("Fix typo", { files: { "a.txt": "x\n" } });
    const result = await runAnnotate("HEAD", { cwd: repo.dir, summary: "Fix a typo" });
    expect(result.entry.author.type).toBe("human");
    expect(result.entry.provenance).toBe("human-authored");
  });

  it("a second annotation supersedes the first (append-only, newest effective)", async () => {
    const sha = await repo.commit("Change", { files: { "a.txt": "1\n" } });
    await runAnnotate(sha, { cwd: repo.dir, summary: "First take" });
    const second = await runAnnotate(sha, { cwd: repo.dir, summary: "Corrected take" });

    expect(second.entryCount).toBe(2);
    const entries = await readLedgerEntries(sha, { cwd: repo.dir });
    expect(entries!.map((e) => e.summary)).toEqual(["First take", "Corrected take"]);
    expect(resolveEffectiveEntry(entries!)?.summary).toBe("Corrected take");
  });

  it("mints identity for a commit with none (the deliberate-write exception to non-minting)", async () => {
    const sha = await repo.commit("No identity yet", { files: { "b.txt": "x\n" } });
    expect(await findEntryByCommitSha(sha, { cwd: repo.dir })).toBeNull();

    const result = await runAnnotate(sha, { cwd: repo.dir, summary: "Annotated anyway" });
    const mapEntry = await findEntryByCommitSha(sha, { cwd: repo.dir });
    expect(mapEntry?.change_id).toBe(result.changeId);
  });

  it("targets a change by c/<change-id> prefix, anchoring to its head commit", async () => {
    const sha = await repo.commit("Target me", { files: { "c.txt": "x\n" } });
    const first = await runAnnotate(sha, { cwd: repo.dir, summary: "Seed identity" });

    const viaChange = await runAnnotate(`c/${first.changeId.slice(0, 8)}`, {
      cwd: repo.dir,
      summary: "Annotated via change ref",
    });
    expect(viaChange.sha).toBe(sha);
    expect(viaChange.changeId).toBe(first.changeId);
    expect(viaChange.entryCount).toBe(2);
  });
});

describe("runAnnotate — stdin surface", () => {
  it("accepts a JSON partial entry, with flags overriding stdin fields", async () => {
    await repo.commit("Stdin change", { files: { "d.txt": "x\n" } });
    const result = await runAnnotate("HEAD", {
      cwd: repo.dir,
      stdinJson: JSON.stringify({
        summary: "Stdin summary (should lose to flag)",
        reasoning: {
          intent: "From stdin",
          rejected: [{ option: "other approach", why: "too slow" }],
        },
        author: { type: "agent", tool: "custom-agent", model: "some-model" },
      }),
      summary: "Flag summary wins",
    });

    expect(result.entry.summary).toBe("Flag summary wins");
    expect(result.entry.reasoning?.intent).toBe("From stdin");
    expect(result.entry.reasoning?.rejected).toEqual([{ option: "other approach", why: "too slow" }]);
    expect(result.entry.author).toMatchObject({ type: "agent", tool: "custom-agent" });
  });

  it("accepts an explicit scope override from stdin", async () => {
    const sha = await repo.commit("Scoped", { files: { "e.txt": "x\n", "f.txt": "y\n" } });
    const blob = (await repo.run(["rev-parse", `${sha}:e.txt`])).stdout.trim();
    const result = await runAnnotate(sha, {
      cwd: repo.dir,
      stdinJson: JSON.stringify({
        summary: "Only e.txt matters",
        scope: [{ path: "e.txt", range: [1, 1], blob }],
      }),
    });
    expect(result.entry.scope).toEqual([{ path: "e.txt", range: [1, 1], blob }]);
  });

  it("rejects unknown stdin keys loudly (agent typos must not be silently dropped)", async () => {
    await repo.commit("Typo guard", { files: { "g.txt": "x\n" } });
    await expect(
      runAnnotate("HEAD", {
        cwd: repo.dir,
        stdinJson: JSON.stringify({ sumary: "typo" }),
      }),
    ).rejects.toThrow(/unrecognized key.*sumary/);
  });

  it("rejects non-JSON and non-object stdin", async () => {
    await repo.commit("Bad stdin", { files: { "h.txt": "x\n" } });
    await expect(
      runAnnotate("HEAD", { cwd: repo.dir, stdinJson: "not json" }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      runAnnotate("HEAD", { cwd: repo.dir, stdinJson: "[1,2]" }),
    ).rejects.toThrow(/must be a JSON object/);
  });
});

describe("runAnnotate — failure cases", () => {
  it("requires a summary from somewhere", async () => {
    await repo.commit("No summary", { files: { "i.txt": "x\n" } });
    await expect(runAnnotate("HEAD", { cwd: repo.dir })).rejects.toThrow(/summary is required/);
  });

  it("rejects an out-of-range confidence", async () => {
    await repo.commit("Bad conf", { files: { "j.txt": "x\n" } });
    await expect(
      runAnnotate("HEAD", { cwd: repo.dir, summary: "s", confidence: 1.5 }),
    ).rejects.toThrow(/--confidence/);
  });

  it("rejects an invalid scope-risk via schema validation", async () => {
    await repo.commit("Bad risk", { files: { "k.txt": "x\n" } });
    await expect(
      runAnnotate("HEAD", { cwd: repo.dir, summary: "s", scopeRisk: "catastrophic" }),
    ).rejects.toThrow(/invalid annotation: reasoning.scope_risk/);
  });

  it("rejects a malformed --rejected value", async () => {
    await repo.commit("Bad rejected", { files: { "l.txt": "x\n" } });
    await expect(
      runAnnotate("HEAD", { cwd: repo.dir, summary: "s", rejected: ["no separator"] }),
    ).rejects.toThrow(/option::why/);
  });

  it("fails cleanly on an unresolvable target", async () => {
    await repo.commit("Base", { files: { "m.txt": "x\n" } });
    await expect(
      runAnnotate("deadbeef", { cwd: repo.dir, summary: "s" }),
    ).rejects.toThrow(/cannot resolve 'deadbeef'/);
  });
});

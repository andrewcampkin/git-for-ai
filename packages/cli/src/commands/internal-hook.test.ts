// Tests for `git-for-ai internal-hook` (./internal-hook.ts) against REAL fixture repos:
// the dispatcher behind the three git hooks `git for-ai init` installs. Covers the full
// identity round-trip the hooks are supposed to provide (commit-msg trailer injection →
// post-commit change-map assignment adopting that same trailer → post-rewrite folding),
// plus the guards that keep a hook from ever corrupting a commit (empty-message, existing
// Gerrit trailer, unknown hook name).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findEntryByCommitSha,
  parseChangeIdTrailer,
  readChangeMapEntry,
} from "@git-for-ai/core";
import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import {
  logHookFailure,
  runInternalHook,
  stripCommentsAndScissors,
} from "./internal-hook.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await createFixtureRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

const HEX32 = /^[0-9a-f]{32}$/;

async function writeMsgFile(content: string): Promise<string> {
  await repo.writeFile("MSG", content);
  return join(repo.dir, "MSG");
}

describe("commit-msg", () => {
  it("injects a Change-Id trailer into a plain message", async () => {
    const msgFile = await writeMsgFile("Fix the widget\n\nLonger body.\n");
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });

    expect(result).toMatchObject({ hook: "commit-msg", action: "injected" });
    if (result.hook !== "commit-msg") throw new Error("unreachable");
    expect(result.changeId).toMatch(HEX32);

    const rewritten = await readFile(msgFile, "utf8");
    expect(parseChangeIdTrailer(rewritten)).toBe(result.changeId);
    // Trailer goes at the end, as a proper trailer block after a blank line.
    expect(rewritten).toBe(`Fix the widget\n\nLonger body.\n\nChange-Id: I${result.changeId}\n`);
  });

  it("places the trailer before comments and the scissors section (commit -v)", async () => {
    const msgFile = await writeMsgFile(
      [
        "Fix the widget",
        "",
        "# Please enter the commit message for your changes.",
        "# ------------------------ >8 ------------------------",
        "diff --git a/x b/x",
        "+would-be-discarded",
        "",
      ].join("\n"),
    );
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    expect(result.action).toBe("injected");
    if (result.hook !== "commit-msg") throw new Error("unreachable");

    const rewritten = await readFile(msgFile, "utf8");
    const lines = rewritten.split("\n");
    const trailerIdx = lines.findIndex((l) => l.startsWith("Change-Id:"));
    const commentIdx = lines.findIndex((l) => l.startsWith("#"));
    expect(trailerIdx).toBeGreaterThan(-1);
    expect(trailerIdx).toBeLessThan(commentIdx);
    // What git will keep after cleanup still parses to the same id.
    expect(parseChangeIdTrailer(stripCommentsAndScissors(rewritten, "#"))).toBe(result.changeId);
  });

  it("is a no-op when a Change-Id trailer is already present (Gerrit coexistence, §7.6)", async () => {
    const gerritStyle = "Fix thing\n\nChange-Id: I0123456789abcdef0123456789abcdef01234567\n";
    const msgFile = await writeMsgFile(gerritStyle);
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });

    expect(result.action).toBe("already-present");
    if (result.hook !== "commit-msg") throw new Error("unreachable");
    // Gerrit's 40-hex id normalized to our canonical 32-hex form.
    expect(result.changeId).toBe("0123456789abcdef0123456789abcdef");
    // File byte-for-byte untouched — no second trailer.
    expect(await readFile(msgFile, "utf8")).toBe(gerritStyle);
  });

  it("leaves an effectively-empty message untouched so git still aborts the commit", async () => {
    const original = "\n# Please enter the commit message.\n#\n";
    const msgFile = await writeMsgFile(original);
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });

    expect(result).toEqual({ hook: "commit-msg", action: "empty-message", changeId: null });
    expect(await readFile(msgFile, "utf8")).toBe(original);
  });

  it("respects a custom core.commentChar for the empty-message check", async () => {
    await repo.run(["config", "core.commentChar", ";"]);
    const original = "; nothing but comments\n;\n";
    const msgFile = await writeMsgFile(original);
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    expect(result.action).toBe("empty-message");
    expect(await readFile(msgFile, "utf8")).toBe(original);
  });

  it("throws when invoked without a message file (bin.ts converts this to a logged no-op)", async () => {
    await expect(runInternalHook("commit-msg", { cwd: repo.dir })).rejects.toThrow(
      /without a message file/,
    );
  });
});

describe("post-commit", () => {
  it("adopts the trailer the commit-msg hook injected — the full §7.2 round-trip", async () => {
    // Simulate the real hook sequence for one commit: inject into the message file,
    // commit with that exact message, then run the post-commit assignment.
    const msgFile = await writeMsgFile("Add feature\n");
    const injected = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    expect(injected.action).toBe("injected");

    await repo.writeFile("a.txt", "content\n");
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "-F", msgFile]);
    const head = await repo.revParse("HEAD");

    if (injected.hook !== "commit-msg") throw new Error("unreachable");
    const result = await runInternalHook("post-commit", { cwd: repo.dir });
    expect(result).toMatchObject({
      hook: "post-commit",
      action: "assigned",
      changeId: injected.changeId,
      adoptedFromTrailer: true,
    });

    const entry = await findEntryByCommitSha(head, { cwd: repo.dir });
    expect(entry).toMatchObject({
      change_id: injected.changeId,
      head,
      history: [head],
      origin: "post-commit",
      trailer_seen: true,
    });
  });

  it("mints a fresh id for a commit without a trailer (e.g. --no-verify skipped commit-msg)", async () => {
    const head = await repo.commit("No trailer here", { files: { "b.txt": "x\n" } });
    const result = await runInternalHook("post-commit", { cwd: repo.dir });
    expect(result).toMatchObject({ hook: "post-commit", adoptedFromTrailer: false });
    if (result.hook !== "post-commit") throw new Error("unreachable");
    expect(result.changeId).toMatch(HEX32);
    expect(await findEntryByCommitSha(head, { cwd: repo.dir })).not.toBeNull();
  });
});

describe("post-rewrite", () => {
  it("rekeys an amend via stdin pairs", async () => {
    const msgFile = await writeMsgFile("Original\n");
    await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    await repo.writeFile("c.txt", "1\n");
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "-F", msgFile]);
    const oldSha = await repo.revParse("HEAD");
    const assigned = await runInternalHook("post-commit", { cwd: repo.dir });
    if (assigned.hook !== "post-commit") throw new Error("unreachable");

    await repo.writeFile("c.txt", "2\n");
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "--amend", "--no-edit"]);
    const newSha = await repo.revParse("HEAD");

    const result = await runInternalHook("post-rewrite", {
      cwd: repo.dir,
      args: ["amend"],
      stdin: `${oldSha} ${newSha}\n`,
    });
    expect(result).toMatchObject({ hook: "post-rewrite", action: "applied", rekeyed: 1, folded: 0 });

    const entry = await readChangeMapEntry(assigned.changeId, { cwd: repo.dir });
    expect(entry?.head).toBe(newSha);
    expect(entry?.history).toEqual([oldSha, newSha]);
  });

  it("is a structured no-op on empty stdin", async () => {
    const result = await runInternalHook("post-rewrite", { cwd: repo.dir, args: ["rebase"], stdin: "" });
    expect(result).toEqual({
      hook: "post-rewrite",
      action: "no-pairs",
      rekeyed: 0,
      folded: 0,
      unknownOldShas: 0,
    });
  });
});

describe("squash-merge fold (DESKTOP.md G1)", () => {
  /** Run the full real hook sequence for one commit: commit-msg on a message file, commit with it, post-commit. */
  async function hookCommit(message: string): Promise<{ msgResult: Awaited<ReturnType<typeof runInternalHook>>; sha: string; postResult: Awaited<ReturnType<typeof runInternalHook>> }> {
    await repo.writeFile("MSG", `${message}\n`);
    const msgFile = join(repo.dir, "MSG");
    const msgResult = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "-F", msgFile]);
    const sha = await repo.revParse("HEAD");
    const postResult = await runInternalHook("post-commit", { cwd: repo.dir });
    return { msgResult, sha, postResult };
  }

  it("folds a merge --squash into the branch's first change, absorbing the rest", async () => {
    await repo.writeFile("base.txt", "base\n");
    await hookCommit("base");

    // Feature branch with two hook-tracked commits (two changes).
    await repo.run(["checkout", "-b", "feature"]);
    await repo.writeFile("f1.txt", "1\n");
    const first = await hookCommit("feature: first");
    await repo.writeFile("f2.txt", "2\n");
    const second = await hookCommit("feature: second");
    if (first.postResult.hook !== "post-commit" || second.postResult.hook !== "post-commit") {
      throw new Error("unreachable");
    }

    // Squash-merge onto main. git writes SQUASH_MSG; commit-msg must detect it.
    await repo.run(["checkout", "main"]);
    await repo.run(["merge", "--squash", "feature"]);
    await repo.writeFile("MSG", "squashed feature\n");
    const msgFile = join(repo.dir, "MSG");
    const msgResult = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });

    // The injected trailer is the FIRST branch change's id — it survives.
    expect(msgResult).toMatchObject({
      action: "injected",
      changeId: first.postResult.changeId,
      squash: { survivorChangeId: first.postResult.changeId, squashedCount: 2 },
    });

    await repo.run(["commit", "-F", msgFile]);
    const squashSha = await repo.revParse("HEAD");
    const postResult = await runInternalHook("post-commit", { cwd: repo.dir });
    expect(postResult).toMatchObject({
      changeId: first.postResult.changeId,
      adoptedFromTrailer: true,
      squashFold: { survivorChangeId: first.postResult.changeId, absorbed: 1, unknownOldShas: 0 },
    });

    // Survivor: head is the squash commit; the second change was absorbed.
    const survivor = await readChangeMapEntry(first.postResult.changeId, { cwd: repo.dir });
    expect(survivor?.head).toBe(squashSha);
    expect(survivor?.history).toContain(squashSha);
    expect(survivor?.absorbed).toEqual([second.postResult.changeId]);
    const absorbed = await readChangeMapEntry(second.postResult.changeId, { cwd: repo.dir });
    expect(absorbed?.folded_into).toBe(first.postResult.changeId);

    // The pending file was consumed.
    expect(existsSync(join(repo.dir, ".git", "git-for-ai-squash-pending.json"))).toBe(false);
  });

  it("falls back to a fresh mint when no squashed commit has identity", async () => {
    await repo.commit("base", { files: { "base.txt": "b\n" } }); // no hooks ran — no identity
    await repo.run(["checkout", "-b", "feature"]);
    await repo.commit("untracked work", { files: { "u.txt": "u\n" } });
    await repo.run(["checkout", "main"]);
    await repo.run(["merge", "--squash", "feature"]);

    await repo.writeFile("MSG", "squashed unknown branch\n");
    const msgFile = join(repo.dir, "MSG");
    const result = await runInternalHook("commit-msg", { cwd: repo.dir, args: [msgFile] });
    if (result.hook !== "commit-msg") throw new Error("unreachable");
    expect(result.action).toBe("injected");
    expect(result.squash).toBeUndefined();
    expect(existsSync(join(repo.dir, ".git", "git-for-ai-squash-pending.json"))).toBe(false);
  });

  it("a stale pending file from an aborted squash commit never folds a later commit", async () => {
    await repo.writeFile("base.txt", "base\n");
    const base = await hookCommit("base");
    if (base.postResult.hook !== "post-commit") throw new Error("unreachable");

    // Simulate the abort: a pending file exists whose survivor id will NOT match the
    // next commit's trailer (that commit mints its own fresh id).
    await writeFile(
      join(repo.dir, ".git", "git-for-ai-squash-pending.json"),
      JSON.stringify({ changeId: "0123456789abcdef0123456789abcdef", oldShas: [base.sha] }),
      "utf8",
    );

    await repo.writeFile("next.txt", "n\n");
    const next = await hookCommit("unrelated later commit");
    if (next.postResult.hook !== "post-commit") throw new Error("unreachable");
    expect(next.postResult.squashFold).toBeUndefined();
    // Stale file cleaned up; the base change untouched.
    expect(existsSync(join(repo.dir, ".git", "git-for-ai-squash-pending.json"))).toBe(false);
    const baseEntry = await readChangeMapEntry(base.postResult.changeId, { cwd: repo.dir });
    expect(baseEntry?.head).toBe(base.sha);
    expect(baseEntry?.folded_into).toBeUndefined();
  });
});

describe("dispatch + failure logging", () => {
  it("rejects an unknown hook name", async () => {
    await expect(runInternalHook("pre-push", { cwd: repo.dir })).rejects.toThrow(/unknown hook/);
  });

  it("logHookFailure appends to .git-for-ai/hooks.log inside a repo and never throws", async () => {
    await logHookFailure("commit-msg: boom", repo.dir);
    const log = await readFile(join(repo.dir, ".git-for-ai", "hooks.log"), "utf8");
    expect(log).toMatch(/internal-hook: commit-msg: boom\n$/);
    // Outside any repo: must still resolve (falls back to stderr) rather than throw.
    await expect(logHookFailure("no repo here", join(repo.dir, ".."))).resolves.toBeUndefined();
  });
});

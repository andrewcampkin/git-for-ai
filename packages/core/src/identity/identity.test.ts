// Milestone 3's scenario suite — the rewrite-survival scenarios from ARCHITECTURE.md
// §7.2–§7.5, scripted against REAL fixture repos (real git, real hooks, no mocks):
//
//   - plain first commit -> assigned + recorded in the change-map
//   - git commit --amend -> same change-id, history grows, head updates (real post-rewrite
//     hook input captured from git itself)
//   - interactive rebase autosquash -> N-old-to-1-new fold, absorbed/folded_into bookkeeping
//   - cherry-pick with NO hooks fired -> lazy healing via the Change-Id trailer (§7.5) —
//     per CLI_PLAN.md M3, the single most important test in the codebase.

import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "../git/index.js";

// Every test here drives real git subprocess chains (commits, amends, an interactive
// rebase) — far beyond vitest's 5s default on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { mintChangeId, formatChangeIdTrailer } from "./changeId.js";
import { readChangeMapEntry, findEntryByCommitSha } from "./changeMap.js";
import { assignChangeId } from "./assign.js";
import { resolveChangeId } from "./resolve.js";
import { onPostRewrite, parsePostRewriteInput, type RewritePair } from "./postRewrite.js";

/**
 * Install a REAL post-rewrite hook that appends git's actual stdin (the
 * `<old-sha> <new-sha>` pair lines) to `.git/post-rewrite-pairs`, so tests exercise the
 * exact input format git emits rather than a hand-imagined one.
 */
async function installPostRewriteCapture(repo: FixtureRepo): Promise<void> {
  const hooksDir = join(repo.dir, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-rewrite");
  await writeFile(
    hookPath,
    '#!/bin/sh\ncat >> "$(git rev-parse --git-dir)/post-rewrite-pairs"\n',
    { encoding: "utf8" },
  );
  await chmod(hookPath, 0o755);
}

/** Read (and consume) the pairs the real post-rewrite hook captured. */
async function readCapturedPairs(repo: FixtureRepo): Promise<RewritePair[]> {
  const raw = await readFile(join(repo.dir, ".git", "post-rewrite-pairs"), "utf8");
  return parsePostRewriteInput(raw);
}

function messageWithTrailer(subject: string, changeId: string): string {
  return `${subject}\n\n${formatChangeIdTrailer(changeId)}`;
}

describe("assignChangeId (§7.2)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("assigns a plain first commit and records it correctly in the change-map", async () => {
    // The commit-msg hook (Milestone 5) injects the trailer before the SHA is finalized;
    // the fixture writes the message the same way the hook would have left it.
    const cid = mintChangeId();
    const sha = await repo.commit(messageWithTrailer("feat: first commit", cid), {
      files: { "a.txt": "one\n" },
    });

    const result = await assignChangeId(sha, { cwd: repo.dir });
    expect(result.changeId).toBe(cid);
    expect(result.adoptedFromTrailer).toBe(true);

    const entry = await readChangeMapEntry(cid, { cwd: repo.dir });
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      schema: "git-for-ai/change-map-entry@1",
      change_id: cid,
      head: sha,
      history: [sha],
      trailer_seen: true,
      origin: "post-commit",
    });

    // And the resolver now hits the authoritative fast path.
    const resolved = await resolveChangeId(sha, { cwd: repo.dir });
    expect(resolved.branch).toBe("R1");
    expect(resolved.changeId).toBe(cid);
  });

  it("mints a fresh random change-id when the message has no trailer", async () => {
    const sha = await repo.commit("chore: no trailer here", { files: { "b.txt": "two\n" } });

    const result = await assignChangeId(sha, { cwd: repo.dir });
    expect(result.changeId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.adoptedFromTrailer).toBe(false);

    const entry = await readChangeMapEntry(result.changeId, { cwd: repo.dir });
    expect(entry).toMatchObject({
      head: sha,
      history: [sha],
      trailer_seen: false,
      origin: "post-commit",
    });
  });

  it("adopts a Gerrit-style 40-hex Change-Id rather than minting a second identity (§7.6)", async () => {
    const gerritSuffix = "7944e5ed80f6a3b5b70e7d76d69b9c4f52d0d1a9";
    const sha = await repo.commit(`fix: gerrit repo commit\n\nChange-Id: I${gerritSuffix}`, {
      files: { "c.txt": "three\n" },
    });

    const result = await assignChangeId(sha, { cwd: repo.dir });
    expect(result.adoptedFromTrailer).toBe(true);
    expect(result.changeId).toBe(gerritSuffix.slice(0, 32));
  });
});

describe("amend — 1 old to 1 new rekey via real post-rewrite input (§7.4)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.commit("base", { files: { "README.md": "base\n" } });
    await installPostRewriteCapture(repo);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("keeps the change-id, grows history, and updates head", async () => {
    const cid = mintChangeId();
    const oldSha = await repo.commit(messageWithTrailer("feat: widget", cid), {
      files: { "widget.txt": "v1\n" },
    });
    await assignChangeId(oldSha, { cwd: repo.dir });

    // A real amend — git itself fires post-rewrite and our hook captures its stdin.
    await repo.writeFile("widget.txt", "v2\n");
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "--amend", "--no-edit"]);
    const newSha = await repo.revParse("HEAD");
    expect(newSha).not.toBe(oldSha);

    const pairs = await readCapturedPairs(repo);
    expect(pairs).toEqual([{ oldSha, newSha }]);

    const result = await onPostRewrite(pairs, { cwd: repo.dir });
    expect(result.rekeyed).toEqual([{ changeId: cid, oldSha, newSha }]);
    expect(result.folded).toEqual([]);

    const entry = await readChangeMapEntry(cid, { cwd: repo.dir });
    expect(entry).toMatchObject({
      change_id: cid,
      head: newSha,
      history: [oldSha, newSha],
      origin: "post-rewrite",
    });

    // Both the old and new SHA resolve to the same change-id.
    expect((await resolveChangeId(newSha, { cwd: repo.dir })).changeId).toBe(cid);
    expect((await resolveChangeId(oldSha, { cwd: repo.dir })).changeId).toBe(cid);
  });
});

describe("squash — N old to 1 new fold via a real interactive rebase (§7.4)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await installPostRewriteCapture(repo);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("folds absorbed change-ids into the surviving one and records folded_into", async () => {
    const baseSha = await repo.commit("base", { files: { "README.md": "base\n" } });

    const cidA = mintChangeId();
    const shaA = await repo.commit(messageWithTrailer("feat: add widget", cidA), {
      files: { "widget.txt": "v1\n" },
    });
    await assignChangeId(shaA, { cwd: repo.dir });

    const cidB = mintChangeId();
    const shaB = await repo.commit(messageWithTrailer("fixup! feat: add widget", cidB), {
      files: { "widget.txt": "v2\n" },
    });
    await assignChangeId(shaB, { cwd: repo.dir });

    // A real interactive rebase: --autosquash arranges the fixup, GIT_SEQUENCE_EDITOR=true
    // accepts the todo list unmodified, and git fires post-rewrite with both pairs.
    await repo.run(["rebase", "-i", "--autosquash", baseSha], {
      env: { GIT_SEQUENCE_EDITOR: "true", GIT_EDITOR: "true" },
    });
    const newSha = await repo.revParse("HEAD");

    const pairs = await readCapturedPairs(repo);
    // Observed real-git behavior: an autosquash emits the pick target TWICE (once for the
    // pick step, once when the fixup amends it), so the raw input can contain duplicate
    // old SHAs — onPostRewrite must tolerate that. Every line maps onto the same new SHA,
    // and the squash target (the surviving change, per git's own semantics) comes first.
    expect(new Set(pairs.map((p) => p.newSha))).toEqual(new Set([newSha]));
    expect(new Set(pairs.map((p) => p.oldSha))).toEqual(new Set([shaA, shaB]));
    expect(pairs.findIndex((p) => p.oldSha === shaA)).toBeLessThan(
      pairs.findIndex((p) => p.oldSha === shaB),
    );

    const result = await onPostRewrite(pairs, { cwd: repo.dir });
    expect(result.folded).toEqual([
      { survivorChangeId: cidA, absorbedChangeIds: [cidB], newSha },
    ]);
    expect(result.rekeyed).toEqual([]);

    // Survivor: head moved, history grew, absorbed recorded.
    const entryA = await readChangeMapEntry(cidA, { cwd: repo.dir });
    expect(entryA).toMatchObject({
      head: newSha,
      history: [shaA, newSha],
      origin: "post-rewrite",
      absorbed: [cidB],
    });

    // Absorbed: folded_into points at the survivor; its own history is untouched.
    const entryB = await readChangeMapEntry(cidB, { cwd: repo.dir });
    expect(entryB).toMatchObject({ folded_into: cidA, history: [shaB] });

    // The new commit resolves to the surviving change-id...
    const resolvedNew = await resolveChangeId(newSha, { cwd: repo.dir });
    expect(resolvedNew.branch).toBe("R1");
    expect(resolvedNew.changeId).toBe(cidA);

    // ...and the absorbed change's old SHA transparently redirects to the survivor.
    const resolvedOldB = await resolveChangeId(shaB, { cwd: repo.dir });
    expect(resolvedOldB.changeId).toBe(cidA);
    expect(resolvedOldB.absorbedChangeId).toBe(cidB);
  });
});

describe("cherry-pick with no hooks fired — lazy healing (§7.3 R2/R3, §7.5)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("R2: heals the map when the trailer's change-id is already known (divergent branch)", async () => {
    await repo.commit("base", { files: { "README.md": "base\n" } });

    const cid = mintChangeId();
    await repo.run(["checkout", "-b", "feature"]);
    const originalSha = await repo.commit(messageWithTrailer("feat: session tokens", cid), {
      files: { "feature.txt": "signed cookies\n" },
    });
    await assignChangeId(originalSha, { cwd: repo.dir });

    // Cherry-pick onto a divergent branch. No git-for-ai hooks exist in this repo, so
    // NOTHING observes the copy — exactly the §7.5 blind spot.
    await repo.run(["checkout", "-b", "other", "main"]);
    await repo.run(["cherry-pick", originalSha]);
    const pickedSha = await repo.revParse("HEAD");
    expect(pickedSha).not.toBe(originalSha);
    expect(await findEntryByCommitSha(pickedSha, { cwd: repo.dir })).toBeNull();

    // First read of the copied commit recovers the SAME change-id from the trailer and
    // self-heals the map (R2).
    const resolved = await resolveChangeId(pickedSha, { cwd: repo.dir });
    expect(resolved.branch).toBe("R2");
    expect(resolved.changeId).toBe(cid);

    const entry = await readChangeMapEntry(cid, { cwd: repo.dir });
    expect(entry?.history).toContain(originalSha);
    expect(entry?.history).toContain(pickedSha);
    expect(entry?.trailer_seen).toBe(true);

    // The next lookup hits the authoritative fast path — the map has converged.
    const second = await resolveChangeId(pickedSha, { cwd: repo.dir });
    expect(second.branch).toBe("R1");
    expect(second.changeId).toBe(cid);
  });

  it("R3: recovers the same change-id in a SECOND repo whose change-map never saw it", async () => {
    const target = await createFixtureRepo();
    try {
      // Source repo: one assigned commit carrying its trailer.
      await repo.commit("base", { files: { "README.md": "base\n" } });
      const cid = mintChangeId();
      const originalSha = await repo.commit(messageWithTrailer("feat: portable change", cid), {
        files: { "portable.txt": "rides the message\n" },
      });
      await assignChangeId(originalSha, { cwd: repo.dir });

      // Target repo: fetch the source's history and cherry-pick the commit. The target has
      // no git-for-ai hooks and no change-map ref at all — post-rewrite never fires for
      // cherry-pick anyway (§7.5), so only the trailer rides along in the message.
      await target.commit("target base", { files: { "TARGET.md": "target\n" } });
      await target.run(["fetch", repo.dir.replace(/\\/g, "/"), "main"]);
      await target.run(["cherry-pick", originalSha]);
      const pickedSha = await target.revParse("HEAD");
      expect(pickedSha).not.toBe(originalSha);

      // First read in the target repo: the resolver recovers the SAME change-id from the
      // trailer and registers it (R3, origin=trailer-recovery) — the recovered mapping is
      // written back into the target's change-map.
      const resolved = await resolveChangeId(pickedSha, { cwd: target.dir });
      expect(resolved.branch).toBe("R3");
      expect(resolved.changeId).toBe(cid);
      expect(resolved.entry.origin).toBe("trailer-recovery");

      const entry = await readChangeMapEntry(cid, { cwd: target.dir });
      expect(entry).toMatchObject({
        change_id: cid,
        head: pickedSha,
        history: [pickedSha],
        trailer_seen: true,
        origin: "trailer-recovery",
      });

      // Self-healed: the second lookup is authoritative.
      const second = await resolveChangeId(pickedSha, { cwd: target.dir });
      expect(second.branch).toBe("R1");
      expect(second.changeId).toBe(cid);
    } finally {
      await target.cleanup();
    }
  });
});

describe("resolveChangeId fallback branches (§7.3 R4/R5)", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("R4: infers continuation from a known single parent with high tree similarity", async () => {
    // Parent with a known change-id, in a repo with enough files that a one-file edit
    // stays above the similarity threshold.
    const parentSha = await repo.commit("feat: bulk of the work", {
      files: {
        "a.txt": "a\n",
        "b.txt": "b\n",
        "c.txt": "c\n",
        "d.txt": "d\n",
        "e.txt": "e\n",
      },
    });
    const assigned = await assignChangeId(parentSha, { cwd: repo.dir });

    // Trailer-less child (as if filter-repo stripped the message) touching one file of five.
    const childSha = await repo.commit("stripped message, no trailer", {
      files: { "a.txt": "a v2\n" },
    });

    const resolved = await resolveChangeId(childSha, { cwd: repo.dir });
    expect(resolved.branch).toBe("R4");
    expect(resolved.changeId).toBe(assigned.changeId);
    expect(resolved.lowConfidence).toBe(true);
    expect(resolved.entry.origin).toBe("inferred");
    expect(resolved.entry.head).toBe(childSha);
    expect(resolved.entry.history).toContain(childSha);
  });

  it("R5: mints a fresh orphan-recovery change-id when nothing is recoverable", async () => {
    // No trailer, and the parent is unknown to the (nonexistent) change-map.
    await repo.commit("unobserved base", { files: { "x.txt": "x\n" } });
    const sha = await repo.commit("unobserved child, no trailer", {
      files: { "y.txt": "y\n" },
    });

    const resolved = await resolveChangeId(sha, { cwd: repo.dir });
    expect(resolved.branch).toBe("R5");
    expect(resolved.changeId).toMatch(/^[0-9a-f]{32}$/);
    expect(resolved.lowConfidence).toBe(true);
    expect(resolved.entry.origin).toBe("orphan-recovery");
    expect(resolved.entry.trailer_seen).toBe(false);

    // Even the orphan mapping self-heals to the fast path.
    const second = await resolveChangeId(sha, { cwd: repo.dir });
    expect(second.branch).toBe("R1");
    expect(second.changeId).toBe(resolved.changeId);
  });

  it("R5 rather than R4 when the child rewrote nearly everything (similarity below threshold)", async () => {
    const parentSha = await repo.commit("original", {
      files: { "a.txt": "a\n", "b.txt": "b\n" },
    });
    const assigned = await assignChangeId(parentSha, { cwd: repo.dir });

    const childSha = await repo.commit("total rewrite, no trailer", {
      files: { "a.txt": "completely different\n", "b.txt": "also different\n" },
    });

    const resolved = await resolveChangeId(childSha, { cwd: repo.dir });
    expect(resolved.branch).toBe("R5");
    expect(resolved.changeId).not.toBe(assigned.changeId);
  });
});

// Tests for the review server's WRITE path (DESKTOP.md §5 step 4b), against a real
// listening server over a real fixture repo. The interesting assertions are the guards:
// this is the only code in the project that can change a repository over HTTP, and every
// rule in reviewActions.ts's header is checked here rather than trusted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runInit } from "./init.js";
import { startReviewServer, type ReviewMeta, type ReviewServerHandle } from "./review.js";
import type { ReviewActionJob } from "./reviewActions.js";

const TOKEN = "test-launch-token-0123456789";

/** Poll a job until it leaves `running` (these test actions are fast). */
async function settle(base: string, id: string, token = TOKEN): Promise<ReviewActionJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(new URL(`/api/actions/jobs/${id}`, base), {
      headers: { "x-git-for-ai-token": token },
    });
    const job = (await response.json()) as ReviewActionJob;
    if (job.status !== "running") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${id} never finished`);
}

describe("action endpoints (token-gated writes)", () => {
  let repo: FixtureRepo;
  let handle: ReviewServerHandle;
  let base: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    await repo.commit("first", { files: { "a.ts": "export const a = 1;\n" } });
    await runInit({ cwd: repo.dir, claudeHooks: false });
    handle = await startReviewServer({ cwd: repo.dir, mode: "desktop", actionToken: TOKEN });
    base = handle.url;
  });

  afterAll(async () => {
    await handle.close();
    await repo.cleanup();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("refuses a request with no token, and one with a wrong token", async () => {
    expect((await post("/api/actions/doctor", {})).status).toBe(401);
    expect(
      (await post("/api/actions/doctor", {}, { "x-git-for-ai-token": "not-the-token" })).status,
    ).toBe(401);
    // A same-length wrong token exercises the constant-time comparison path.
    expect(
      (await post("/api/actions/doctor", {}, { "x-git-for-ai-token": "x".repeat(TOKEN.length) }))
        .status,
    ).toBe(401);
  });

  it("refuses a cross-origin request even with the right token", async () => {
    const response = await post(
      "/api/actions/doctor",
      {},
      { "x-git-for-ai-token": TOKEN, origin: "https://evil.example" },
    );
    expect(response.status).toBe(401);
  });

  it("runs doctor and reports its structured result through the job", async () => {
    const started = await post("/api/actions/doctor", {}, { "x-git-for-ai-token": TOKEN });
    expect(started.status).toBe(202);
    const job = (await started.json()) as ReviewActionJob;
    expect(job.status).toBe("running");
    expect(job.action).toBe("doctor");

    const finished = await settle(base, job.id);
    expect(finished.status).toBe("done");
    const result = finished.result as { data: { checks: unknown[] } };
    expect(Array.isArray(result.data.checks)).toBe(true);
    expect(result.data.checks.length).toBeGreaterThan(0);
  });

  it("will not push without an explicit confirmation in the body", async () => {
    const started = await post(
      "/api/actions/sync",
      { push: true },
      { "x-git-for-ai-token": TOKEN },
    );
    expect(started.status).toBe(202);
    const job = await settle(base, ((await started.json()) as ReviewActionJob).id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/requires confirmation/i);
  });

  it("rejects an unknown action and a non-JSON body", async () => {
    expect((await post("/api/actions/rm-rf", {}, { "x-git-for-ai-token": TOKEN })).status).toBe(
      404,
    );
    const bad = await fetch(new URL("/api/actions/doctor", base), {
      method: "POST",
      headers: { "content-type": "application/json", "x-git-for-ai-token": TOKEN },
      body: "not json",
    });
    expect(bad.status).toBe(400);
  });

  it("requires the token to read job state too", async () => {
    const started = await post("/api/actions/doctor", {}, { "x-git-for-ai-token": TOKEN });
    const job = (await started.json()) as ReviewActionJob;
    await settle(base, job.id);

    expect((await fetch(new URL(`/api/actions/jobs/${job.id}`, base))).status).toBe(401);
    const listed = await fetch(new URL("/api/actions/jobs", base), {
      headers: { "x-git-for-ai-token": TOKEN },
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { jobs: ReviewActionJob[] }).jobs.length).toBeGreaterThan(0);
  });

  it("advertises actions in /api/meta — but never the token itself", async () => {
    const response = await fetch(new URL("/api/meta", base));
    const meta = (await response.json()) as ReviewMeta;
    expect(meta.capabilities.actions).toBe(true);
    expect(meta.capabilities.mode).toBe("desktop");
    expect(meta.capabilities.actionNames).toContain("doctor");
    // The whole point of the token: nothing serves it.
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
  });
});

describe("a server without an action token stays strictly read-only", () => {
  let repo: FixtureRepo;
  let handle: ReviewServerHandle;
  let base: string;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    await repo.commit("first", { files: { "a.ts": "export const a = 1;\n" } });
    handle = await startReviewServer({ cwd: repo.dir });
    base = handle.url;
  });

  afterAll(async () => {
    await handle.close();
    await repo.cleanup();
  });

  it("does not offer actions in /api/meta", async () => {
    const meta = (await (await fetch(new URL("/api/meta", base))).json()) as ReviewMeta;
    expect(meta.capabilities.actions).toBe(false);
    expect(meta.capabilities.actionNames).toBeUndefined();
  });

  it("answers 404 for an action, with or without a token guess", async () => {
    for (const headers of [{}, { "x-git-for-ai-token": TOKEN }]) {
      const response = await fetch(new URL("/api/actions/doctor", base), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      expect(response.status).toBe(404);
    }
    expect((await fetch(new URL("/api/actions/jobs", base))).status).toBe(404);
  });

  it("still rejects every other non-GET method as 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(new URL("/api/overview", base), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

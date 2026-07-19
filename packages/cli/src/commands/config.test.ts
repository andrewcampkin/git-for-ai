// Integration tests for `git for-ai config get|set` against REAL fixture repos
// initialized by the REAL runInit (never mocked), per CLI_PLAN.md §4. The Voyage consent
// flow is exercised through the injectable promptConsent seam — the only part bin.ts
// owns is the TTY read itself.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "@git-for-ai/core/testing";

import { runInit } from "./init.js";
import { runConfigGet, runConfigSet } from "./config.js";

describe("config get/set (real git fixture)", () => {
  let repo: FixtureRepo;

  const configPath = (): string => join(repo.dir, ".git-for-ai", "config.toml");
  const readConfig = (): Promise<string> => readFile(configPath(), "utf8");

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.commit("first commit", { files: { "a.txt": "a" } });
    await runInit({ cwd: repo.dir, claudeHooks: false });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // ── get ─────────────────────────────────────────────────────────────────────

  it("gets the effective value init wrote", async () => {
    expect((await runConfigGet("embedder.provider", { cwd: repo.dir })).output).toBe(
      "jina-v2-code",
    );
    expect((await runConfigGet("embedder.dim", { cwd: repo.dir })).output).toBe("768");
    expect((await runConfigGet("capture.enabled", { cwd: repo.dir })).output).toBe("true");
    expect((await runConfigGet("schema", { cwd: repo.dir })).output).toBe("git-for-ai/config@1");
  });

  it("gets array values as JSON", async () => {
    const result = await runConfigGet("redaction.extra_patterns", { cwd: repo.dir });
    expect(result.value).toEqual([]);
    expect(result.output).toBe("[]");
  });

  it("rejects an unknown key on get", async () => {
    await expect(runConfigGet("no.such.key", { cwd: repo.dir })).rejects.toThrow(
      /unknown config key 'no\.such\.key'/,
    );
  });

  it("fails with an actionable error when the repo is not initialized", async () => {
    const bare = await createFixtureRepo();
    try {
      await bare.commit("c", { files: { "a.txt": "a" } });
      await expect(runConfigGet("capture.enabled", { cwd: bare.dir })).rejects.toThrow(
        /run `git for-ai init` first/,
      );
    } finally {
      await bare.cleanup();
    }
  });

  // ── set (plain keys) ────────────────────────────────────────────────────────

  it("sets a boolean key in place, preserving comments and other lines", async () => {
    const before = await readConfig();
    expect(before).toContain("# git-for-ai repo config");

    const result = await runConfigSet("capture.enabled", "false", { cwd: repo.dir });
    expect(result.output).toBe("✓ capture.enabled set to false");

    const after = await readConfig();
    expect(after).toContain("enabled = false");
    expect(after).toContain("# git-for-ai repo config"); // comment preserved
    expect(after).toContain("never_capture = "); // sibling keys untouched
    expect((await runConfigGet("capture.enabled", { cwd: repo.dir })).value).toBe(false);
  });

  it("sets an integer key", async () => {
    await runConfigSet("capture.max_span_bytes", "32768", { cwd: repo.dir });
    expect((await runConfigGet("capture.max_span_bytes", { cwd: repo.dir })).value).toBe(32768);
  });

  it("sets a string-array key from a JSON literal", async () => {
    await runConfigSet("redaction.extra_patterns", '["FOO_[A-Z]+", "internal-token"]', {
      cwd: repo.dir,
    });
    expect((await runConfigGet("redaction.extra_patterns", { cwd: repo.dir })).value).toEqual([
      "FOO_[A-Z]+",
      "internal-token",
    ]);
    expect(await readConfig()).toContain('extra_patterns = ["FOO_[A-Z]+", "internal-token"]');
  });

  it("rejects malformed values without writing anything", async () => {
    const before = await readConfig();
    await expect(
      runConfigSet("capture.max_span_bytes", "lots", { cwd: repo.dir }),
    ).rejects.toThrow(/expects an integer/);
    await expect(
      runConfigSet("capture.enabled", "yes-please", { cwd: repo.dir }),
    ).rejects.toThrow(/expects true or false/);
    await expect(
      runConfigSet("redaction.extra_patterns", "not-an-array", { cwd: repo.dir }),
    ).rejects.toThrow(/JSON array of strings/);
    expect(await readConfig()).toBe(before);
  });

  it("rejects an unknown key and the read-only schema key on set", async () => {
    await expect(runConfigSet("no.such.key", "1", { cwd: repo.dir })).rejects.toThrow(
      /unknown config key/,
    );
    await expect(runConfigSet("schema", "git-for-ai/config@9", { cwd: repo.dir })).rejects.toThrow(
      /read-only/,
    );
  });

  it("refuses a value the schema rejects, writing nothing", async () => {
    const before = await readConfig();
    await expect(
      runConfigSet("capture.max_span_bytes", "-5", { cwd: repo.dir }),
    ).rejects.toThrow(/refusing to write an invalid config/);
    expect(await readConfig()).toBe(before);
  });

  // ── embedder.provider + the Voyage consent flow ─────────────────────────────

  it("switching to another OFFLINE provider needs no consent and updates dim/offline", async () => {
    const result = await runConfigSet("embedder.provider", "nomic-embed-code", {
      cwd: repo.dir,
    });
    expect(result.consentRecorded).toBe(false);
    expect(result.output).toBe(
      "✓ embedder set to nomic-embed-code (dim 3584). Run `git for-ai reindex --full` to re-embed.",
    );
    expect((await runConfigGet("embedder.dim", { cwd: repo.dir })).value).toBe(3584);
    expect((await runConfigGet("embedder.offline", { cwd: repo.dir })).value).toBe(true);
    expect((await runConfigGet("embedder.voyage_consent", { cwd: repo.dir })).value).toBe(false);
  });

  it("voyage-code-3 with an interactive 'i accept' records consent and flips offline", async () => {
    const prompt = vi.fn().mockResolvedValue("i accept");
    const result = await runConfigSet("embedder.provider", "voyage-code-3", {
      cwd: repo.dir,
      promptConsent: prompt,
    });

    expect(prompt).toHaveBeenCalledOnce();
    // The prompt carries the CLI_REFERENCE consent wording.
    expect(prompt.mock.calls[0]![0]).toContain("voyage-code-3 is an API provider");
    expect(prompt.mock.calls[0]![0]).toContain("Type 'i accept' to continue");

    expect(result.consentRecorded).toBe(true);
    expect(result.output).toBe(
      "✓ embedder set to voyage-code-3 (dim 1024). Run `git for-ai reindex --full` to re-embed.",
    );
    expect((await runConfigGet("embedder.provider", { cwd: repo.dir })).value).toBe(
      "voyage-code-3",
    );
    expect((await runConfigGet("embedder.dim", { cwd: repo.dir })).value).toBe(1024);
    expect((await runConfigGet("embedder.offline", { cwd: repo.dir })).value).toBe(false);
    expect((await runConfigGet("embedder.voyage_consent", { cwd: repo.dir })).value).toBe(true);
  });

  it("declining the consent prompt writes NOTHING", async () => {
    const before = await readConfig();
    await expect(
      runConfigSet("embedder.provider", "voyage-code-3", {
        cwd: repo.dir,
        promptConsent: async () => "no thanks",
      }),
    ).rejects.toThrow(/consent not given/);
    expect(await readConfig()).toBe(before);
  });

  it("non-interactive set of an API provider requires --accept-consent", async () => {
    const before = await readConfig();
    await expect(
      runConfigSet("embedder.provider", "voyage-code-3", { cwd: repo.dir }),
    ).rejects.toThrow(/--accept-consent/);
    expect(await readConfig()).toBe(before);

    const result = await runConfigSet("embedder.provider", "voyage-code-3", {
      cwd: repo.dir,
      acceptConsent: true,
    });
    expect(result.consentRecorded).toBe(true);
    expect((await runConfigGet("embedder.voyage_consent", { cwd: repo.dir })).value).toBe(true);
  });

  it("consent already on record is not re-prompted", async () => {
    await runConfigSet("embedder.voyage_consent", "true", { cwd: repo.dir });

    const prompt = vi.fn();
    const result = await runConfigSet("embedder.provider", "voyage-code-3", {
      cwd: repo.dir,
      promptConsent: prompt,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(result.consentRecorded).toBe(false);
    expect((await runConfigGet("embedder.provider", { cwd: repo.dir })).value).toBe(
      "voyage-code-3",
    );
  });

  it("rejects an unknown embedder provider, writing nothing", async () => {
    const before = await readConfig();
    await expect(
      runConfigSet("embedder.provider", "gpt-embeddings-9000", { cwd: repo.dir }),
    ).rejects.toThrow(/unknown embedder provider/);
    expect(await readConfig()).toBe(before);
  });
});

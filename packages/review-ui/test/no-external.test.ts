// REVIEW_UI.md §2 self-contained rule: the built SPA is fully self-contained — zero external requests
// (no CDNs, fonts, telemetry). Enforced the same way report.test.ts asserts no external
// src/href on the report page, here against the actual Vite build output.
//
// Note on scope: HTML attributes and CSS url() references are what the BROWSER fetches.
// JS string literals are deliberately not scanned — React's production bundle embeds
// https://react.dev/... URLs in error MESSAGES (text, never requested), so a blanket
// "no https:// anywhere" assertion would be wrong. What matters is that no markup or
// stylesheet triggers a request, and the app's only fetch() calls target /api/* paths.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

describe("built SPA is fully self-contained (zero external requests)", () => {
  it("has been built (dist/index.html exists — run `pnpm build` if this fails)", () => {
    expect(
      existsSync(join(distDir, "index.html")),
      "packages/review-ui/dist/index.html is missing — run `pnpm build` at the repo root first",
    ).toBe(true);
  });

  it("index.html has no external src/href and only relative asset references", async () => {
    const html = await readFile(join(distDir, "index.html"), "utf8");

    // The exact assertion report.test.ts uses, plus protocol-relative URLs.
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
    expect(html).not.toMatch(/(src|href)=["']\/\//);

    // Every src/href is relative or an inline data: URI (the favicon).
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
      const url = match[1]!;
      expect(
        url.startsWith("./") || url.startsWith("/") || url.startsWith("data:"),
        `external-looking reference in index.html: ${url}`,
      ).toBe(true);
    }
  });

  it("no built stylesheet pulls a remote url()", async () => {
    const assetsDir = join(distDir, "assets");
    const files = existsSync(assetsDir) ? await readdir(assetsDir) : [];
    const cssFiles = files.filter((file) => file.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);
    for (const file of cssFiles) {
      const css = await readFile(join(assetsDir, file), "utf8");
      expect(css, `remote url() in ${file}`).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
      expect(css, `@import in ${file}`).not.toMatch(/@import\s+["'(]?\s*https?:/i);
    }
  });

  it("the app's own fetch targets are all local /api paths", async () => {
    const assetsDir = join(distDir, "assets");
    const files = existsSync(assetsDir) ? await readdir(assetsDir) : [];
    const jsFiles = files.filter((file) => file.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);
    for (const file of jsFiles) {
      const js = await readFile(join(assetsDir, file), "utf8");
      // No fetch/XHR/WebSocket/EventSource call is given an absolute http(s) URL.
      expect(js, `absolute-URL fetch in ${file}`).not.toMatch(
        /fetch\(\s*["'`]https?:/i,
      );
      expect(js, `XMLHttpRequest open with absolute URL in ${file}`).not.toMatch(
        /\.open\(\s*["'][A-Z]+["']\s*,\s*["'`]https?:/i,
      );
      expect(js, `WebSocket in ${file}`).not.toMatch(/new\s+WebSocket\(/);
      expect(js, `EventSource in ${file}`).not.toMatch(/new\s+EventSource\(/);
    }
  });
});

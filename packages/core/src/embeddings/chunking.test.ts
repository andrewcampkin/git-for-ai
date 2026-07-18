// Chunker tests (CLI_PLAN.md M9): real fixture source strings through the real
// web-tree-sitter WASM grammars — no mocked parser — asserting expected function/class
// boundaries, node paths, gap segments, windowing, and the plain-text fallback.

import { describe, expect, it } from "vitest";

import { chunkSourceFile, languageForPath, type CodeChunk } from "./chunking.js";

const TS_FIXTURE = [
  'import { readFile } from "node:fs/promises";', // L1
  "", //                                             L2
  "const GREETING = \"hello\";", //                  L3
  "", //                                             L4
  "export function add(a: number, b: number): number {", // L5
  "  return a + b;", //                              L6
  "}", //                                            L7
  "", //                                             L8
  "export const double = (n: number): number => {", // L9
  "  return n * 2;", //                              L10
  "};", //                                           L11
  "", //                                             L12
  "export class Calculator {", //                    L13
  "  private total = 0;", //                         L14
  "  add(n: number): void {", //                     L15
  "    this.total += n;", //                         L16
  "  }", //                                          L17
  "}", //                                            L18
  "", //                                             L19
].join("\n");

const PY_FIXTURE = [
  "import os", //                  L1
  "", //                           L2
  "def greet(name):", //           L3
  '    return f"hi {name}"', //    L4
  "", //                           L5
  "@staticmethod", //              L6
  "def decorated():", //           L7
  "    pass", //                   L8
  "", //                           L9
  "class Reader:", //              L10
  "    def read(self, path):", //  L11
  "        return open(path)", //  L12
  "", //                           L13
].join("\n");

function byNodePath(chunks: CodeChunk[], nodePath: string): CodeChunk {
  const chunk = chunks.find((c) => c.nodePath === nodePath);
  expect(chunk, `expected a chunk with nodePath ${nodePath}`).toBeDefined();
  return chunk as CodeChunk;
}

describe("languageForPath", () => {
  it("maps extensions to grammars", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("src/a.mts")).toBe("typescript");
    expect(languageForPath("src/App.tsx")).toBe("tsx");
    expect(languageForPath("lib/b.js")).toBe("javascript");
    expect(languageForPath("lib/b.jsx")).toBe("javascript");
    expect(languageForPath("tool.py")).toBe("python");
    expect(languageForPath("README.md")).toBe("text");
    expect(languageForPath("Makefile")).toBe("text");
  });
});

describe("chunkSourceFile — TypeScript", () => {
  it("chunks functions, arrow consts, and classes at the expected boundaries", async () => {
    const chunks = await chunkSourceFile("src/calc.ts", TS_FIXTURE);

    const add = byNodePath(chunks, "function:add");
    expect(add.kind).toBe("function");
    expect(add.startLine).toBe(5);
    expect(add.endLine).toBe(7);
    expect(add.text).toBe("export function add(a: number, b: number): number {\n  return a + b;\n}");

    const doubleFn = byNodePath(chunks, "function:double");
    expect(doubleFn.kind).toBe("function");
    expect(doubleFn.startLine).toBe(9);
    expect(doubleFn.endLine).toBe(11);

    const calculator = byNodePath(chunks, "class:Calculator");
    expect(calculator.kind).toBe("class");
    expect(calculator.startLine).toBe(13);
    expect(calculator.endLine).toBe(18);
    expect(calculator.text).toContain("private total = 0;");
  });

  it("captures imports and top-level constants as gap segments", async () => {
    const chunks = await chunkSourceFile("src/calc.ts", TS_FIXTURE);
    const firstSegment = byNodePath(chunks, "segment:@L1");
    expect(firstSegment.kind).toBe("segment");
    expect(firstSegment.text).toContain('import { readFile } from "node:fs/promises";');
    expect(firstSegment.text).toContain("const GREETING");
  });

  it("covers every non-blank line exactly once (no drops, no overlaps)", async () => {
    const chunks = await chunkSourceFile("src/calc.ts", TS_FIXTURE);
    const lines = TS_FIXTURE.split("\n");
    const coverage = new Array<number>(lines.length).fill(0);
    for (const chunk of chunks) {
      for (let i = chunk.startLine - 1; i < chunk.endLine; i += 1) {
        coverage[i] = (coverage[i] as number) + 1;
      }
    }
    for (let i = 0; i < lines.length; i += 1) {
      if ((lines[i] as string).trim().length > 0) {
        expect(coverage[i], `line ${i + 1} (${lines[i]})`).toBe(1);
      }
      expect(coverage[i]).toBeLessThanOrEqual(1);
    }
  });

  it("chunks are sorted by start line", async () => {
    const chunks = await chunkSourceFile("src/calc.ts", TS_FIXTURE);
    const starts = chunks.map((c) => c.startLine);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("parses TSX components", async () => {
    const tsx = "export function App() {\n  return <div className=\"x\">hi</div>;\n}\n";
    const chunks = await chunkSourceFile("src/App.tsx", tsx);
    const app = byNodePath(chunks, "function:App");
    expect(app.language).toBe("tsx");
    expect(app.startLine).toBe(1);
    expect(app.endLine).toBe(3);
  });
});

describe("chunkSourceFile — JavaScript", () => {
  it("chunks function declarations and classes", async () => {
    const js = "function legacy() { return 1; }\n\nclass Widget {\n  render() {}\n}\n";
    const chunks = await chunkSourceFile("lib/widget.js", js);
    expect(byNodePath(chunks, "function:legacy").startLine).toBe(1);
    const widget = byNodePath(chunks, "class:Widget");
    expect(widget.startLine).toBe(3);
    expect(widget.endLine).toBe(5);
  });
});

describe("chunkSourceFile — Python", () => {
  it("chunks defs, decorated defs, and classes at the expected boundaries", async () => {
    const chunks = await chunkSourceFile("tool.py", PY_FIXTURE);

    const greet = byNodePath(chunks, "function:greet");
    expect(greet.startLine).toBe(3);
    expect(greet.endLine).toBe(4);

    // The decorated_definition wrapper is unwrapped for the NAME but the chunk span
    // includes the decorator line.
    const decorated = byNodePath(chunks, "function:decorated");
    expect(decorated.startLine).toBe(6);
    expect(decorated.endLine).toBe(8);
    expect(decorated.text).toContain("@staticmethod");

    const reader = byNodePath(chunks, "class:Reader");
    expect(reader.kind).toBe("class");
    expect(reader.startLine).toBe(10);
    expect(reader.endLine).toBe(12);

    const imports = byNodePath(chunks, "segment:@L1");
    expect(imports.text).toBe("import os");
  });
});

describe("chunkSourceFile — oversized inputs", () => {
  it("window-splits an oversized function with #n suffixes and contiguous line ranges", async () => {
    const bodyLines = Array.from({ length: 50 }, (_, i) => `  console.log(${"x".repeat(40)}${i});`);
    const source = `function huge() {\n${bodyLines.join("\n")}\n}\n`;
    const chunks = await chunkSourceFile("big.js", source, { maxChunkChars: 600 });

    const windows = chunks.filter((c) => c.nodePath.startsWith("function:huge#"));
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.nodePath).toBe("function:huge#0");
    expect(windows[0]?.startLine).toBe(1);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]?.startLine).toBe((windows[i - 1] as CodeChunk).endLine + 1);
    }
    // Reassembling the windows reproduces the declaration text exactly.
    expect(windows.map((w) => w.text).join("\n")).toBe(source.trimEnd());
    for (const w of windows) {
      expect(w.text.length).toBeLessThanOrEqual(600);
    }
  });

  it("splits an oversized class into per-method chunks and keeps the header as a segment", async () => {
    const method = (name: string): string =>
      `  ${name}() {\n${Array.from({ length: 10 }, () => `    work("${"y".repeat(30)}");`).join("\n")}\n  }`;
    const source = `class Big {\n  field = 1;\n${method("alpha")}\n${method("beta")}\n}\n`;
    const chunks = await chunkSourceFile("big-class.js", source, { maxChunkChars: 500 });

    const alpha = byNodePath(chunks, "class:Big/method:alpha");
    expect(alpha.kind).toBe("method");
    const beta = byNodePath(chunks, "class:Big/method:beta");
    expect(beta.startLine).toBe(alpha.endLine + 1);
    // Header + field land in a segment; nothing is dropped.
    const header = chunks.find((c) => c.kind === "segment" && c.text.includes("class Big {"));
    expect(header?.text).toContain("field = 1;");
    expect(chunks.some((c) => c.nodePath === "class:Big")).toBe(false);
  });
});

describe("chunkSourceFile — plain-text fallback", () => {
  it("emits a single whole-file chunk for unknown extensions", async () => {
    const content = "# Notes\n\nremember the milk\n";
    const chunks = await chunkSourceFile("NOTES.md", content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      language: "text",
      kind: "file",
      nodePath: "file",
      startLine: 1,
      text: content,
    });
  });

  it("returns no chunks for an effectively empty file", async () => {
    expect(await chunkSourceFile("empty.txt", "  \n\n")).toEqual([]);
    expect(await chunkSourceFile("empty.ts", "")).toEqual([]);
  });

  it("window-splits oversized plain text", async () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i} ${"z".repeat(50)}`).join("\n");
    const chunks = await chunkSourceFile("big.log", content, { maxChunkChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.nodePath).toBe("file#0");
    expect(chunks.map((c) => c.text).join("\n")).toBe(content);
  });
});

// Source-code chunking at function/class granularity — architecture/ARCHITECTURE.md §11.1.
//
// Parsing is web-tree-sitter (WASM — no native build step, per CLI_PLAN.md M9), with
// grammars for TypeScript/TSX/JavaScript and Python only, matching M9's deliberate scope.
//
// ── Grammar sourcing (judgment call) ──
// Grammar `.wasm` binaries come from the `tree-sitter-wasms` npm package, which ships
// prebuilt WASM for every common grammar (built with tree-sitter-cli 0.20.x → ABI 14,
// verified compatible with web-tree-sitter 0.24.7 on this machine). Chosen over
// per-grammar npm packages because (a) one dependency covers all four grammars we need
// plus any future language additions, and (b) the individual grammar packages
// (tree-sitter-typescript etc.) are native-first and do not reliably ship a .wasm.
// Everything is resolved from node_modules at runtime — fully offline after install.
//
// ── Chunking judgment calls (the docs pin granularity, not mechanics) ──
// 1. Chunk identity: `node_path` is a stable, human-readable path of
//    `<kind>:<name>` segments (`function:foo`, `class:Bar/method:baz`), NOT a raw
//    tree-sitter node index — so it is stable across whitespace-only edits per §11.2.
//    Anonymous constructs fall back to `@L<startLine>` names. Oversized chunks that get
//    window-split append `#<window>` so each window keys a distinct cache entry.
// 2. What becomes a chunk: top-level function/class declarations (unwrapping `export`
//    statements and Python decorators), plus `const x = () => ...` arrow/function
//    assignments (the dominant TS style). A class bigger than `maxChunkChars` is split
//    into per-method chunks instead of one giant chunk.
// 3. Nothing is dropped: after emitting declaration chunks, any uncovered contiguous
//    non-blank line runs (imports, top-level statements, interfaces, class field
//    headers of a method-split class) are emitted as `segment:@L<n>` chunks, so the
//    FTS/vector index always covers the whole file.
// 4. Unknown languages / extensionless files degrade to plain-text chunking: one
//    whole-file chunk (`file`), window-split if oversized. §11.1 scopes M9 to TS/JS/Py;
//    this keeps other files searchable rather than invisible.
// 5. `maxChunkChars` defaults to 8000 characters (~2k tokens) — comfortably inside the
//    default model's 8192-token window while keeping chunks retrieval-sized.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import Parser from "web-tree-sitter";

import type { Chunk } from "./types.js";

const require = createRequire(import.meta.url);

/** Languages the M9 chunker parses structurally. Anything else gets plain-text chunking. */
export type ChunkLanguage = "typescript" | "tsx" | "javascript" | "python" | "text";

/** What kind of construct a chunk covers. */
export type ChunkKind = "function" | "class" | "method" | "segment" | "file";

/** One chunk of one source file — the unit of embedding and indexing (§11.1/§11.2). */
export interface CodeChunk extends Chunk {
  /** Repo-relative (or caller-relative) path of the source file. */
  readonly path: string;
  readonly language: ChunkLanguage;
  readonly kind: ChunkKind;
  /**
   * Stable within-file identity: `<kind>:<name>` segments joined by `/`, e.g.
   * `function:resolveChangeId`, `class:Store/method:open`, `segment:@L1`, `file`.
   * Chunk identity per §11.2 is `(blob_hash, node_path)`.
   */
  readonly nodePath: string;
  /** 1-based inclusive start line. */
  readonly startLine: number;
  /** 1-based inclusive end line. */
  readonly endLine: number;
  readonly text: string;
}

export interface ChunkSourceFileOptions {
  /** Chunks longer than this are split into line windows. Default 8000. */
  maxChunkChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 8000;

/** Map a file path to the grammar used to chunk it (extension-based). */
export function languageForPath(path: string): ChunkLanguage {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot);
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx": // the javascript grammar includes JSX
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    default:
      return "text";
  }
}

// ─── Grammar loading (lazy, cached, offline) ─────────────────────────────────

const GRAMMAR_WASM: Record<Exclude<ChunkLanguage, "text">, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Parser.Language>>();

function loadLanguage(language: Exclude<ChunkLanguage, "text">): Promise<Parser.Language> {
  let cached = languageCache.get(language);
  if (cached === undefined) {
    cached = (async () => {
      parserInitPromise ??= Parser.init();
      await parserInitPromise;
      const wasmsRoot = dirname(require.resolve("tree-sitter-wasms/package.json"));
      return Parser.Language.load(join(wasmsRoot, "out", GRAMMAR_WASM[language]));
    })();
    languageCache.set(language, cached);
  }
  return cached;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Chunk one source file at function/class granularity (ARCHITECTURE.md §11.1).
 * Returns chunks sorted by start line; together they cover every non-blank line of the
 * file exactly once (declaration chunks + gap-filling `segment` chunks).
 */
export async function chunkSourceFile(
  path: string,
  content: string,
  options: ChunkSourceFileOptions = {},
): Promise<CodeChunk[]> {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const language = languageForPath(path);

  if (language === "text") {
    return plainTextChunks(path, content, maxChunkChars);
  }

  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  try {
    const chunks: CodeChunk[] = [];
    for (const decl of topLevelDeclarations(tree.rootNode, language)) {
      chunks.push(...chunkDeclaration(path, language, content, decl, maxChunkChars));
    }
    chunks.push(...gapSegments(path, language, content, chunks));
    chunks.sort((a, b) => a.startLine - b.startLine || a.nodePath.localeCompare(b.nodePath));
    return chunks;
  } finally {
    tree.delete();
    parser.delete();
  }
}

// ─── Declaration discovery ───────────────────────────────────────────────────

interface Declaration {
  /** The node whose full span becomes the chunk (includes `export`/decorators). */
  node: Parser.SyntaxNode;
  kind: "function" | "class";
  name: string;
}

function topLevelDeclarations(root: Parser.SyntaxNode, language: ChunkLanguage): Declaration[] {
  const decls: Declaration[] = [];
  for (const child of root.namedChildren) {
    const decl = asDeclaration(child, language);
    if (decl !== null) {
      decls.push(decl);
    }
  }
  return decls;
}

/**
 * Classify a top-level node as a function/class declaration, unwrapping wrappers
 * (`export ...` in TS/JS, `@decorator` in Python) while keeping the wrapper's full
 * span as the chunk body.
 */
function asDeclaration(node: Parser.SyntaxNode, language: ChunkLanguage): Declaration | null {
  const inner = unwrap(node);
  if (inner === null) {
    return null;
  }
  switch (inner.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_definition": // python
      return { node, kind: "function", name: nameOf(inner) };
    case "class_declaration":
    case "abstract_class_declaration":
    case "class_definition": // python
      return { node, kind: "class", name: nameOf(inner) };
    case "lexical_declaration":
    case "variable_declaration": {
      // `const foo = (a) => ...` / `var foo = function () {...}` — chunk only when the
      // initializer is a function, so plain constants stay in segment chunks.
      if (language === "python") {
        return null;
      }
      const declarator = inner.namedChildren.find((c) => c.type === "variable_declarator");
      const value = declarator?.childForFieldName("value");
      if (
        declarator !== undefined &&
        value !== null &&
        value !== undefined &&
        (value.type === "arrow_function" ||
          value.type === "function_expression" ||
          value.type === "function" || // older grammar name for function_expression
          value.type === "generator_function")
      ) {
        return { node, kind: "function", name: nameOf(declarator) };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Unwrap `export_statement` / `decorated_definition` to the declaration they carry. */
function unwrap(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "export_statement") {
    return node.childForFieldName("declaration") ?? null;
  }
  if (node.type === "decorated_definition") {
    return node.childForFieldName("definition") ?? null;
  }
  return node;
}

function nameOf(node: Parser.SyntaxNode): string {
  const name = node.childForFieldName("name");
  return name?.text ?? `@L${node.startPosition.row + 1}`;
}

// ─── Chunk emission ──────────────────────────────────────────────────────────

function chunkDeclaration(
  path: string,
  language: ChunkLanguage,
  content: string,
  decl: Declaration,
  maxChunkChars: number,
): CodeChunk[] {
  const text = decl.node.text;
  const nodePath = `${decl.kind}:${decl.name}`;

  if (decl.kind === "class" && text.length > maxChunkChars) {
    // Split an oversized class into per-method chunks; the class header/fields land in
    // gap segments afterwards.
    const chunks: CodeChunk[] = [];
    for (const method of classMethods(decl.node)) {
      const methodPath = `class:${decl.name}/method:${nameOf(method)}`;
      chunks.push(
        ...windowed(path, language, "method", methodPath, method.text, startLineOf(method), maxChunkChars),
      );
    }
    if (chunks.length > 0) {
      return chunks;
    }
    // No methods found (e.g. a giant field-only class): fall through to windowing.
  }

  return windowed(path, language, decl.kind, nodePath, text, startLineOf(decl.node), maxChunkChars);
}

function classMethods(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const inner = unwrap(classNode);
  const body = inner?.childForFieldName("body");
  if (body === null || body === undefined) {
    return [];
  }
  const methods: Parser.SyntaxNode[] = [];
  for (const member of body.namedChildren) {
    const unwrapped = unwrap(member);
    if (
      unwrapped !== null &&
      (unwrapped.type === "method_definition" || unwrapped.type === "function_definition")
    ) {
      methods.push(member);
    }
  }
  return methods;
}

function startLineOf(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

/** Emit one chunk, or several `#<n>`-suffixed window chunks when `text` is oversized. */
function windowed(
  path: string,
  language: ChunkLanguage,
  kind: ChunkKind,
  nodePath: string,
  text: string,
  startLine: number,
  maxChunkChars: number,
): CodeChunk[] {
  const lines = text.split("\n");
  if (text.length <= maxChunkChars) {
    return [{ path, language, kind, nodePath, startLine, endLine: startLine + lines.length - 1, text }];
  }

  const chunks: CodeChunk[] = [];
  let windowLines: string[] = [];
  let windowChars = 0;
  let windowStart = startLine;
  let lineCursor = startLine;
  const flush = (): void => {
    if (windowLines.length === 0) {
      return;
    }
    chunks.push({
      path,
      language,
      kind,
      nodePath: `${nodePath}#${chunks.length}`,
      startLine: windowStart,
      endLine: lineCursor - 1,
      text: windowLines.join("\n"),
    });
    windowLines = [];
    windowChars = 0;
    windowStart = lineCursor;
  };
  for (const line of lines) {
    if (windowLines.length > 0 && windowChars + line.length + 1 > maxChunkChars) {
      flush();
    }
    windowLines.push(line);
    windowChars += line.length + 1;
    lineCursor += 1;
  }
  flush();
  return chunks;
}

/** Plain-text fallback: one `file` chunk, window-split when oversized. */
function plainTextChunks(path: string, content: string, maxChunkChars: number): CodeChunk[] {
  if (content.trim().length === 0) {
    return [];
  }
  return windowed(path, "text", "file", "file", content, 1, maxChunkChars);
}

/**
 * Emit `segment` chunks for contiguous non-blank line runs not covered by any
 * declaration chunk, so imports/top-level statements/interfaces stay indexed.
 */
function gapSegments(
  path: string,
  language: ChunkLanguage,
  content: string,
  existing: CodeChunk[],
): CodeChunk[] {
  const lines = content.split("\n");
  const covered = new Array<boolean>(lines.length).fill(false);
  for (const chunk of existing) {
    for (let i = chunk.startLine - 1; i < chunk.endLine && i < lines.length; i += 1) {
      covered[i] = true;
    }
  }

  const segments: CodeChunk[] = [];
  let runStart: number | null = null;
  const flushRun = (endExclusive: number): void => {
    if (runStart === null) {
      return;
    }
    // Trim blank lines off both ends of the run so segments are tight around content.
    let start = runStart;
    let end = endExclusive;
    runStart = null;
    while (start < end && (lines[start] as string).trim().length === 0) {
      start += 1;
    }
    while (end > start && (lines[end - 1] as string).trim().length === 0) {
      end -= 1;
    }
    if (start >= end) {
      return;
    }
    segments.push({
      path,
      language,
      kind: "segment",
      nodePath: `segment:@L${start + 1}`,
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join("\n"),
    });
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (covered[i] === true) {
      flushRun(i);
    } else if (runStart === null) {
      runStart = i;
    }
  }
  flushRun(lines.length);
  return segments;
}

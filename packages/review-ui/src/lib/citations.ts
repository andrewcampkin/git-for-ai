// Split a synthesized answer into text/citation segments so the panel can render the
// `[n]` markers as links to the numbered source list (mirrors core synthesis.ts's
// extractCitations contract: markers are 1-based indexes into the sources array).
// Out-of-range markers are NOT linkified — they stay literal text, because inventing a
// link target would fabricate a source.

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; n: number };

/** `"cookies [1]; see [2]"` → text/citation/text/citation segments. Pure; no DOM. */
export function splitCitations(answer: string, sourceCount: number): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let last = 0;
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    const index = match.index ?? 0;
    if (n < 1 || n > sourceCount) {
      continue; // literal text, handled by the trailing slice
    }
    if (index > last) {
      segments.push({ kind: "text", text: answer.slice(last, index) });
    }
    segments.push({ kind: "citation", n });
    last = index + match[0].length;
  }
  if (last < answer.length) {
    segments.push({ kind: "text", text: answer.slice(last) });
  }
  return segments;
}

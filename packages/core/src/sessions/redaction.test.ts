// Unit tests for the §13 redaction pass (./redaction.ts): every built-in rule catches
// its target pattern; plausible NON-secret code is left alone (false positives are the
// failure mode that would make people turn capture off); ignore-globs exclude content;
// size caps truncate with the marker; and a failing rule THROWS (fail-closed contract —
// the orchestrator-level "trace is not written" behavior is covered in capture.test.ts).

import { describe, expect, it } from "vitest";

import type { Span } from "@git-for-ai/schemas";

import {
  BUILTIN_REDACTION_RULES,
  TRUNCATED_MARKER,
  matchesNeverCapture,
  redactSpans,
  redactionMarker,
  type RedactionRule,
} from "./redaction.js";

/** Redact a single text body through the full pass; return the redacted text + info. */
function redactText(text: string, rules?: readonly RedactionRule[]) {
  const result = redactSpans(
    [{ span_id: "s1", kind: "gen_ai.completion", body: { text } }],
    rules !== undefined ? { rules } : {},
  );
  return {
    text: result.spans[0]!.body!["text"] as string,
    redaction: result.redaction,
  };
}

describe("built-in redaction rules — each catches its target", () => {
  it("aws-key", () => {
    const { text, redaction } = redactText("creds: AKIAIOSFODNN7EXAMPLE region us-east-1");
    expect(text).toContain(redactionMarker("aws-key"));
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redaction.rules).toContain("aws-key");
    expect(redaction.redacted_count).toBe(1);
  });

  it("github-token (classic and fine-grained)", () => {
    const classic = `ghp_${"Ab1".repeat(12)}`; // 36 chars after the prefix
    const fineGrained = `github_pat_${"x1".repeat(11)}Z`;
    const { text, redaction } = redactText(`push with ${classic} or ${fineGrained}`);
    expect(text).not.toContain(classic);
    expect(text).not.toContain(fineGrained);
    expect(redaction.rules).toContain("github-token");
    expect(redaction.redacted_count).toBe(2);
  });

  it("gitlab-token", () => {
    const token = `glpat-${"aB3dEfGh".repeat(3)}`;
    const { text, redaction } = redactText(`export GL=${token}`);
    expect(text).not.toContain(token);
    expect(redaction.rules).toContain("gitlab-token");
  });

  it("private-key-block (entire block including headers)", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq\nmore+base64/lines==\n-----END RSA PRIVATE KEY-----";
    const { text, redaction } = redactText(`pasted:\n${block}\ndone`);
    expect(text).not.toContain("MIIEow");
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).toContain(redactionMarker("private-key-block"));
    expect(redaction.rules).toContain("private-key-block");
  });

  it("jwt", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const { text, redaction } = redactText(`Authorization: Bearer ${jwt}`);
    expect(text).not.toContain(jwt);
    expect(redaction.rules).toContain("jwt");
  });

  it("connection-string (credentials embedded in a URL)", () => {
    const conn = "postgres://admin:s3cretPass@db.internal:5432/app";
    const { text, redaction } = redactText(`DATABASE_URL points at ${conn}`);
    expect(text).not.toContain("s3cretPass");
    expect(redaction.rules).toContain("connection-string");
  });

  it("generic-token (high-entropy assignment; only the value is replaced)", () => {
    const { text, redaction } = redactText('API_KEY = "9aF3kZ8qL2mN4pR7sT1v"');
    expect(text).toContain("API_KEY = ");
    expect(text).not.toContain("9aF3kZ8qL2mN4pR7sT1v");
    expect(text).toContain(redactionMarker("generic-token"));
    expect(redaction.rules).toContain("generic-token");
  });
});

describe("built-in rules — plausible non-secrets are NOT redacted", () => {
  const nonSecrets = [
    // a bare git SHA (40 hex) — not a token
    'const gitSha = "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70";',
    // ordinary assignments, even with trigger words in the key, when the value is tame
    "tokens_used = 12345",
    'password_hint = "your first pet"',
    'const sessionStore = "signed-cookie";',
    // a credential-free URL
    "see https://example.com/docs/auth for details",
    // low-entropy repeated value under a trigger key
    'secret = "aaaaaaaaaaaaaaaa1"',
    // normal prose mentioning the words
    "the auth token is stored in the keychain",
  ];

  for (const sample of nonSecrets) {
    it(`leaves untouched: ${sample.slice(0, 48)}`, () => {
      const { text, redaction } = redactText(sample);
      expect(text).toBe(sample);
      expect(redaction.redacted_count).toBe(0);
      expect(redaction.rules).toEqual([]);
    });
  }
});

describe("ignore-globs (never_capture)", () => {
  it("matchesNeverCapture matches basenames and full paths", () => {
    expect(matchesNeverCapture(".env.local", [".env*"])).toBe(true);
    expect(matchesNeverCapture("C:\\repo\\keys\\id_rsa_deploy", ["id_rsa*"])).toBe(true);
    expect(matchesNeverCapture("config/secrets/prod.txt", ["*secrets*"])).toBe(true);
    expect(matchesNeverCapture("certs/server.pem", ["*.pem"])).toBe(true);
    expect(matchesNeverCapture("src/auth/session.ts", [".env*", "*.pem", "*secrets*"])).toBe(false);
  });

  it("a span touching a never_capture file keeps only the fact of the touch", () => {
    const spans: Span[] = [
      {
        span_id: "s1",
        kind: "gen_ai.tool.execution",
        name: "Read",
        attributes: { file: ".env.production" },
        body: { text: "DB_PASSWORD=hunter2hunter2hunter2" },
      },
      {
        span_id: "s2",
        kind: "gen_ai.tool.execution",
        name: "Edit",
        attributes: { file: "src/app.ts" },
        body: { text: "plain code" },
      },
    ];
    const result = redactSpans(spans, { ignoreGlobs: [".env*"] });

    const excluded = result.spans[0]!;
    expect(excluded.attributes).toEqual({ file: ".env.production" });
    expect(JSON.stringify(excluded.body)).not.toContain("hunter2");
    expect(excluded.body).toHaveProperty("omitted");
    expect(excluded.name).toBe("Read"); // the touch itself is still recorded

    // the non-matching span is untouched
    expect(result.spans[1]!.body).toEqual({ text: "plain code" });
  });
});

describe("size caps", () => {
  it("truncates over-cap body strings with the «truncated» marker and counts them", () => {
    const long = "x".repeat(200);
    const result = redactSpans(
      [{ span_id: "s1", kind: "gen_ai.completion", body: { text: long } }],
      { maxSpanBytes: 50 },
    );
    const text = result.spans[0]!.body!["text"] as string;
    expect(text.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(text.length).toBeLessThan(long.length);
    expect(result.redaction.truncated_count).toBe(1);
  });

  it("leaves under-cap bodies alone", () => {
    const result = redactSpans(
      [{ span_id: "s1", kind: "gen_ai.completion", body: { text: "short" } }],
      { maxSpanBytes: 50 },
    );
    expect(result.spans[0]!.body).toEqual({ text: "short" });
    expect(result.redaction.truncated_count).toBe(0);
  });
});

describe("fail-closed contract", () => {
  it("a rule that throws propagates (caller must not write the trace)", () => {
    const boom: RedactionRule = {
      id: "boom",
      apply() {
        throw new Error("injected redaction failure");
      },
    };
    expect(() =>
      redactSpans(
        [{ span_id: "s1", kind: "gen_ai.completion", body: { text: "anything" } }],
        { rules: [...BUILTIN_REDACTION_RULES, boom] },
      ),
    ).toThrow("injected redaction failure");
  });

  it("never mutates its input spans", () => {
    const spans: Span[] = [
      { span_id: "s1", kind: "gen_ai.completion", body: { text: "key AKIAIOSFODNN7EXAMPLE" } },
    ];
    const before = JSON.stringify(spans);
    redactSpans(spans);
    expect(JSON.stringify(spans)).toBe(before);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installProcessEnvSecretValueSource, redactCommandText } from "./command-redaction.js";
import {
  invalidateSecretValueCandidates,
  isRedactableSecretValue,
  registerSecretValueSource,
  registerSecretValues,
  resetSecretValueRegistryForTests,
} from "./secret-value-registry.js";

// A synthetic secret, never a real one. High entropy and long enough to clear the
// candidate gate, with no substring that appears in ordinary log text.
const SYNTHETIC_SECRET = "zq7Xv2Lp9Rt4Kd8Nm3Wc6Yb1Hs5Jf0Ag";

// The three shapes from ZIM-2174. Every one of them reached a log in clear under
// the shape-anchored redactor: none carries `NAME=`, `--flag`, or `Bearer`.
const ANCHORLESS_SHAPES: Array<{
  name: string;
  render: (value: string) => string;
  /** True where a shape rule was retro-fitted for this leak after the fact. */
  coveredByShapeRules: boolean;
}> = [
  {
    name: "env reporter arrow line",
    render: (value) =>
      `PAPERCLIP_AGENT_JWT_SECRET set     [environment] Set in process environment => '${value}'`,
    coveredByShapeRules: true,
  },
  {
    name: "bare value under a file header",
    render: (value) => `--- /home/example/.paperclip/instances/default/secrets/master.key\n${value}\n`,
    coveredByShapeRules: false,
  },
  {
    name: "value inside a fenced tool-result echo",
    render: (value) => ["Here is what the file holds:", "```console", value, "```"].join("\n"),
    coveredByShapeRules: false,
  },
];

describe("value-based secret redaction", () => {
  beforeEach(() => {
    resetSecretValueRegistryForTests();
  });

  afterEach(() => {
    resetSecretValueRegistryForTests();
    installProcessEnvSecretValueSource();
  });

  describe("positive control", () => {
    it("fires on every anchorless shape once the value is known", () => {
      registerSecretValues([SYNTHETIC_SECRET]);

      for (const shape of ANCHORLESS_SHAPES) {
        const redacted = redactCommandText(shape.render(SYNTHETIC_SECRET));
        expect(redacted, shape.name).not.toContain(SYNTHETIC_SECRET);
        expect(redacted, shape.name).toContain("***REDACTED***");
      }
    });

    // Guards against the failure mode this whole cluster keeps hitting: a test
    // that passes with a completely broken redactor. With the value absent from
    // the candidate set, only the shape that was retro-fitted a pattern survives
    // — so the assertions above are carried by value matching, not by a rule that
    // happened to fire anyway.
    it("leaks every shape that has no retro-fitted pattern when the value is unknown", () => {
      for (const shape of ANCHORLESS_SHAPES) {
        const redacted = redactCommandText(shape.render(SYNTHETIC_SECRET));
        if (shape.coveredByShapeRules) {
          expect(redacted, shape.name).not.toContain(SYNTHETIC_SECRET);
        } else {
          expect(redacted, shape.name).toContain(SYNTHETIC_SECRET);
        }
      }
    });
  });

  it("leaves a clean stream untouched", () => {
    registerSecretValues([SYNTHETIC_SECRET]);
    const clean = [
      "run 3f0c started for issue ZIM-2174",
      "GET /api/companies/abc/issues 200 in 41ms",
      "queue_v1 drained 12 events",
    ].join("\n");

    expect(redactCommandText(clean)).toBe(clean);
  });

  it("catches the value re-encoded and truncated", () => {
    registerSecretValues([SYNTHETIC_SECRET]);
    const base64 = Buffer.from(SYNTHETIC_SECRET, "utf8").toString("base64");
    const head = SYNTHETIC_SECRET.slice(0, 16);

    expect(redactCommandText(`payload: ${base64}`)).not.toContain(base64);
    expect(redactCommandText(`token starts with ${head}...`)).not.toContain(head);
  });

  describe("candidate gate", () => {
    it("admits credential-shaped values", () => {
      expect(isRedactableSecretValue(SYNTHETIC_SECRET)).toBe(true);
      expect(isRedactableSecretValue("ghp_0123456789abcdefghijABCDEFGHIJ")).toBe(true);
    });

    it("rejects values that would blank ordinary log text", () => {
      // Short, low-entropy, repetitive, whitespace-bearing, and path- or URL-shaped
      // values all over-match: redacting them costs more diagnostics than the
      // leak they would prevent.
      expect(isRedactableSecretValue("hunter2")).toBe(false);
      expect(isRedactableSecretValue("aaaaaaaaaaaaaaaaaaaa")).toBe(false);
      expect(isRedactableSecretValue("correct horse battery staple")).toBe(false);
      expect(isRedactableSecretValue("/home/example/secrets/master.key")).toBe(false);
      expect(isRedactableSecretValue("https://api.example.com/v1/things")).toBe(false);
    });

    it("keeps a secret-named path readable in logs", () => {
      const keyFilePath = "/home/example/.paperclip/instances/default/secrets/master.key";
      registerSecretValueSource(() => [keyFilePath]);

      expect(redactCommandText(`reading key from ${keyFilePath}`)).toContain(keyFilePath);
    });
  });

  describe("candidate refresh", () => {
    it("picks up a secret-named env var set after the first redaction", () => {
      installProcessEnvSecretValueSource();
      const line = `emitted ${SYNTHETIC_SECRET} to stdout`;
      expect(redactCommandText(line)).toContain(SYNTHETIC_SECRET);

      process.env.PAPERCLIP_TEST_ONLY_API_KEY = SYNTHETIC_SECRET;
      invalidateSecretValueCandidates();
      try {
        expect(redactCommandText(line)).not.toContain(SYNTHETIC_SECRET);
      } finally {
        delete process.env.PAPERCLIP_TEST_ONLY_API_KEY;
      }

      invalidateSecretValueCandidates();
      expect(redactCommandText(line)).toContain(SYNTHETIC_SECRET);
    });

    it("survives a source that throws", () => {
      registerSecretValueSource(() => {
        throw new Error("secrets directory unreadable");
      });
      registerSecretValues([SYNTHETIC_SECRET]);

      expect(redactCommandText(`value ${SYNTHETIC_SECRET}`)).not.toContain(SYNTHETIC_SECRET);
    });
  });
});

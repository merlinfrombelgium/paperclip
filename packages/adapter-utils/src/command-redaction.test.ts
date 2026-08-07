import { describe, expect, it } from "vitest";

import { isSecretEnvVarName, redactCommandText } from "./command-redaction.js";

// Asserted by VALUE, never by field name. The ZIM-2114 leak passed every
// name-shaped assertion: the redactor ran, `***REDACTED***` was present
// elsewhere in the same chunk, and the signing secret still went through in
// clear because no rule anchored on the separator the reporter actually used.
const SENTINEL = "s3nt1nelvalue0123456789abcdefzzzz";

// The exact line `paperclip env` printed, minus the ANSI colouring.
function doctorLine(name: string, value: string) {
  return `${name} set     [environment] Set in process environment => '${value}'`;
}

describe("redactCommandText", () => {
  it("redacts the doctor/env-report shape where name and value share no operator", () => {
    const redacted = redactCommandText(doctorLine("PAPERCLIP_AGENT_JWT_SECRET", SENTINEL));
    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).toContain("***REDACTED***");
    expect(redacted).toContain("PAPERCLIP_AGENT_JWT_SECRET");
  });

  it("redacts the doctor shape through the ANSI colouring the CLI emits", () => {
    const colored = `[36mPAPERCLIP_AGENT_JWT_SECRET[39m [32mset[39m     [2m[environment] Set in process environment[22m [2m=>[22m [37m'${SENTINEL}'[39m`;
    expect(redactCommandText(colored)).not.toContain(SENTINEL);
  });

  it("redacts secret-adjacent values behind other operators and brackets", () => {
    for (const line of [
      `PAPERCLIP_AGENT_JWT_SECRET => "${SENTINEL}"`,
      `api_key resolved from vault: '${SENTINEL}'`,
      `GH_TOKEN set [file] loaded => [${SENTINEL}]`,
    ]) {
      expect(redactCommandText(line)).not.toContain(SENTINEL);
    }
  });

  it("still redacts the assignment and flag shapes (ZIM-2087)", () => {
    expect(redactCommandText(`API_KEY=${SENTINEL}`)).not.toContain(SENTINEL);
    expect(redactCommandText(`API_KEY='"'"'${SENTINEL}'"'"'`)).not.toContain(SENTINEL);
    expect(redactCommandText(`--api-key ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(redactCommandText(`Authorization: Bearer ${SENTINEL}`)).not.toContain(SENTINEL);
  });

  it("leaves paths, URLs and prose near a secret name readable", () => {
    const keyFile = `PAPERCLIP_SECRETS_MASTER_KEY_FILE set [default] key file => '/home/paperclip/.paperclip/instances/default/secrets.key'`;
    expect(redactCommandText(keyFile)).toContain("secrets.key");

    const registry = `npm ERR! authToken not found for "https://registry.npmjs.org/@paperclipai/adapter-utils"`;
    expect(redactCommandText(registry)).toContain("registry.npmjs.org");

    const note = `PAPERCLIP_SECRETS_STRICT_MODE set [default] '${"require secret refs".replaceAll(" ", "-")}'`;
    expect(redactCommandText(note)).toContain("require-secret-refs");
  });

  it("does not reach across lines to redact an unrelated value", () => {
    const twoLines = `PAPERCLIP_AGENT_JWT_SECRET set [missing]\nWORKSPACE_ID => '${SENTINEL}'`;
    expect(redactCommandText(twoLines)).toContain(SENTINEL);
  });
});

describe("isSecretEnvVarName", () => {
  it("recognises the env names whose values must never be printed", () => {
    for (const name of [
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_API_KEY",
      "GH_TOKEN",
      "AZURE_FOUNDRY_API_KEY",
    ]) {
      expect(isSecretEnvVarName(name)).toBe(true);
    }
  });

  it("leaves non-secret env names alone", () => {
    for (const name of ["PORT", "PAPERCLIP_STORAGE_PROVIDER", "DATABASE_URL", "PAPERCLIP_CONFIG"]) {
      expect(isSecretEnvVarName(name)).toBe(false);
    }
  });
});

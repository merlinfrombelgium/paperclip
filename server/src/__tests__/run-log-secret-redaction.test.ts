import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redactSensitiveText } from "../redaction.js";

// The sentinel is asserted by VALUE, never by field name. ZIM-2087 shipped a
// leak that a name-only assertion would have passed: the redactor ran on the
// chunk and still wrote the key in clear, because the value was wrapped in
// shell quote-escape soup the pattern could not parse.
const SENTINEL = "s3nt1nelvalue0123456789abcdefzzzz";

// How a secret actually reaches captured stdout: `ssh host bash -c "..."` with
// an inner single-quoted string, so every literal quote becomes '"'"'.
const SHELL_ESCAPED_QUOTE = `'\\"'\\"'`;

function envAssignment(name: string, value: string) {
  return `${name}=${SHELL_ESCAPED_QUOTE}${value}${SHELL_ESCAPED_QUOTE}`;
}

describe("secret redaction on the run-log write path", () => {
  let baseDir: string;
  let previousBasePath: string | undefined;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-redaction-"));
    previousBasePath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = baseDir;
  });

  afterAll(async () => {
    if (previousBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousBasePath;
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("keeps a shell-escaped secret value out of the persisted stream/chunk record", async () => {
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();

    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-redaction",
    });

    await store.append(handle, {
      stream: "stdout",
      ts: new Date().toISOString(),
      chunk: `env ${envAssignment("PAPERCLIP_API_KEY", SENTINEL)} node index.js\n`,
    });

    const persisted = await fs.readFile(path.join(baseDir, handle.logRef), "utf8");

    expect(persisted).not.toContain(SENTINEL);
    expect(persisted).toContain("***REDACTED***");
  });

  it("redacts the escaped-quote assignment shape that leaked keys to disk", () => {
    for (const name of ["PAPERCLIP_API_KEY", "GH_TOKEN", "AZURE_FOUNDRY_API_KEY"]) {
      const redacted = redactSensitiveText(envAssignment(name, SENTINEL));
      expect(redacted).not.toContain(SENTINEL);
      expect(redacted).toContain(`${name}=`);
    }
  });

  it("still redacts the plain and single-quoted assignment shapes", () => {
    expect(redactSensitiveText(`API_KEY=${SENTINEL}`)).not.toContain(SENTINEL);
    expect(redactSensitiveText(`API_KEY="${SENTINEL}"`)).not.toContain(SENTINEL);
    expect(redactSensitiveText(`API_KEY='${SENTINEL}'`)).not.toContain(SENTINEL);
    expect(redactSensitiveText(`--api-key ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(redactSensitiveText(`--api-key=${SHELL_ESCAPED_QUOTE}${SENTINEL}`)).not.toContain(SENTINEL);
  });

  it("leaves non-secret assignments intact", () => {
    const benign = `PAPERCLIP_API_BRIDGE_MODE=${SHELL_ESCAPED_QUOTE}queue_v1${SHELL_ESCAPED_QUOTE}`;
    expect(redactSensitiveText(benign)).toContain("queue_v1");
  });
});

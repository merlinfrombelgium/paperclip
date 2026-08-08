import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { invalidateSecretValueCandidates } from "@paperclipai/adapter-utils";

// ZIM-2174: the run-log write path must lose a value that is known to be secret
// on this host no matter what syntax surrounds it. Both shapes below print the
// value with no operator at all — once as a bare line under a file header, once
// echoed inside a fenced block. No `NAME=`, no `--flag`, no `Bearer`: nothing for
// a shape rule to anchor on.

// A synthetic key, never a real one. Long and high-entropy enough to clear the
// candidate gate.
const SYNTHETIC_MASTER_KEY = "Tq4Bz8Xn1Vd6Ls0Pw3Hm7Cj2Rk5Gy9F";

function fileHeaderDump(keyPath: string, value: string) {
  return `--- ${keyPath}\n${value}\n`;
}

function fencedToolResultEcho(value: string) {
  return ["Contents of the key file:", "```console", value, "```", ""].join("\n");
}

describe("value-based redaction on the run-log write path", () => {
  let baseDir: string;
  let secretsDir: string;
  let keyPath: string;
  let previousBasePath: string | undefined;
  let previousKeyFile: string | undefined;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-value-redaction-"));
    secretsDir = path.join(baseDir, "secrets");
    keyPath = path.join(secretsDir, "master.key");
    await fs.mkdir(secretsDir, { recursive: true });

    previousBasePath = process.env.RUN_LOG_BASE_PATH;
    previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.RUN_LOG_BASE_PATH = baseDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyPath;
  });

  afterAll(async () => {
    if (previousBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousBasePath;
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    invalidateSecretValueCandidates();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  async function persistChunk(runId: string, chunk: string) {
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-value-redaction",
      agentId: "agent-value-redaction",
      runId,
    });
    await store.append(handle, { stream: "stdout", ts: new Date().toISOString(), chunk });
    return fs.readFile(path.join(baseDir, handle.logRef), "utf8");
  }

  // Negative control first, with no key file on disk. A green result here proves
  // the assertions below are carried by the candidate set rather than by a shape
  // rule that happened to fire — the failure mode this cluster keeps hitting is a
  // test that would pass against a completely broken redactor.
  it("leaks both shapes while the value is not known to be secret", async () => {
    invalidateSecretValueCandidates();
    const persisted = await persistChunk(
      "run-value-redaction-control",
      `${fileHeaderDump(keyPath, SYNTHETIC_MASTER_KEY)}${fencedToolResultEcho(SYNTHETIC_MASTER_KEY)}`,
    );

    expect(persisted).toContain(SYNTHETIC_MASTER_KEY);
  });

  it("removes a value read from the instance secrets directory, whatever wraps it", async () => {
    await fs.writeFile(keyPath, `${SYNTHETIC_MASTER_KEY}\n`, "utf8");
    invalidateSecretValueCandidates();

    const persisted = await persistChunk(
      "run-value-redaction-bulk-dump",
      `${fileHeaderDump(keyPath, SYNTHETIC_MASTER_KEY)}${fencedToolResultEcho(SYNTHETIC_MASTER_KEY)}`,
    );

    expect(persisted).not.toContain(SYNTHETIC_MASTER_KEY);
    // Two emissions, two markers: a single replacement would leave the second in
    // clear while the chunk still looked redacted.
    expect(persisted.match(/\*\*\*REDACTED\*\*\*/g) ?? []).toHaveLength(2);
    // The surrounding diagnostics survive; redaction that eats the log is its own
    // outage.
    expect(persisted).toContain("Contents of the key file:");
  });

  it("leaves a clean chunk byte-for-byte intact", async () => {
    const clean = "run started\nGET /api/companies/abc/issues 200 in 41ms\nqueue_v1 drained 12\n";
    const persisted = await persistChunk("run-value-redaction-clean", clean);
    const record = JSON.parse(persisted.trim().split("\n").at(-1) ?? "{}") as { chunk?: string };

    expect(record.chunk).toBe(clean);
  });

  it("picks up a secret written after the first chunk was already redacted", async () => {
    const rotated = "Nf3Qs7Wd1Zx5Rv9Ub2Ky6Ta0Ml4Pc8E";
    const chunk = fencedToolResultEcho(rotated);

    invalidateSecretValueCandidates();
    expect(await persistChunk("run-value-redaction-rotate-before", chunk)).toContain(rotated);

    // The candidate set is polled, not snapshotted at boot: a secret created
    // mid-run has to become visible to it without a restart.
    await fs.writeFile(path.join(secretsDir, "rotated.key"), `${rotated}\n`, "utf8");
    invalidateSecretValueCandidates();

    expect(await persistChunk("run-value-redaction-rotate-after", chunk)).not.toContain(rotated);
  });
});

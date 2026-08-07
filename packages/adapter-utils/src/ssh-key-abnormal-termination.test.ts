import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression gate for the leak found while reviewing ZIM-2090.
 *
 * Every ssh staging path cleans up in a `finally`, and a `finally` never runs
 * when the process is killed mid-command. Observed on the live host: a
 * `paperclip-ssh-key-*` directory created at 12:02:45Z still held a complete
 * private key at 12:11:34Z, while sibling directories from runs that exited
 * normally were gone within a minute; /tmp retention there is 30 days, so
 * nothing reaps it sooner.
 *
 * The default path no longer writes a key file at all, but
 * `PAPERCLIP_SSH_ALLOW_ONDISK_KEY=1` re-enters exactly that code — so the opt-in
 * needs cleanup that survives abnormal termination, not just the `finally`.
 *
 * These tests are deliberately out-of-process: the mechanism under test is
 * `process.on('exit')` plus the termination signals, and the only honest way to
 * exercise it is to kill a real process that is holding a real staged key. The
 * child is bundled with esbuild because ssh.ts is TypeScript with `.js`
 * specifiers, which plain `node` cannot resolve.
 *
 * What is NOT covered, on purpose: SIGKILL and hard crashes. Nothing inside the
 * process can cover those, which is a large part of why the on-disk key is
 * opt-in only and the default keeps the key in agent memory (ZIM-2088).
 */

const BUILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

const sshModulePath = fileURLToPath(new URL("./ssh.ts", import.meta.url));

/**
 * Stages an ssh auth context, reports what it put on disk, and then dies the
 * way a killed run dies: without ever calling `cleanup()`.
 *
 * The key is read from a path outside the scanned TMPDIR: that file stands in
 * for the vault the key legitimately comes from, not for anything ssh.ts wrote.
 */
const CHILD_SOURCE = `
import { readFileSync } from "node:fs";
import { buildSshSpawnTarget } from ${JSON.stringify(sshModulePath)};

const mode = process.argv[2];

const spec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: readFileSync(process.env.PAPERCLIP_TEST_KEY_PATH, "utf8"),
  knownHosts: null,
  strictHostKeyChecking: false,
};

const target = await buildSshSpawnTarget({ spec, command: "claude", args: ["--print"], env: {} });

const identityIndex = target.args.indexOf("-i");
const identityFile = identityIndex >= 0 ? target.args[identityIndex + 1] : null;
const agentOption = target.args.find((entry) => entry.startsWith("IdentityAgent="));
const socketPath = agentOption ? agentOption.slice("IdentityAgent=".length) : null;

process.stdout.write(JSON.stringify({ identityFile, socketPath }) + "\\n");

if (mode === "exit") {
  // Terminated between staging and cleanup, with no chance to unwind.
  process.exit(0);
}

// Stay alive holding the staged credential until the test signals us.
setInterval(() => {}, 1_000);
`;

interface StagedChild {
  identityFile: string | null;
  socketPath: string | null;
  /** Resolves to the child's exit code / terminating signal. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal: NodeJS.Signals) => void;
  stderr: () => string;
}

describe("staged SSH credentials do not survive abnormal termination", () => {
  let bundlePath: string | null = null;
  let buildRoot: string | null = null;
  let unsupportedReason: string | null = null;
  let keyPath = "";
  let keySentinel = "";
  /** Whether the staged key is one ssh-agent will actually accept. */
  let keyIsReal = false;
  const scratchDirs: string[] = [];
  const running: StagedChild[] = [];

  beforeAll(async () => {
    buildRoot = await mkdtemp(path.join(os.tmpdir(), "zim2090-child-"));
    keyPath = path.join(buildRoot, "id_ed25519");
    const generated = await generateKey(keyPath);
    keyIsReal = generated !== null;
    const privateKey =
      generated ??
      [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "zim2090SentinelKeyMaterialThatMustNotSurviveAbnormalTermination",
        "-----END OPENSSH PRIVATE KEY-----",
      ].join("\n");
    if (!keyIsReal) await writeFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
    keySentinel = bodyLine(privateKey);

    const entryPath = path.join(buildRoot, "entry.ts");
    const outPath = path.join(buildRoot, "entry.mjs");
    await writeFile(entryPath, CHILD_SOURCE, "utf8");
    try {
      const esbuild = await import("esbuild");
      await esbuild.build({
        entryPoints: [entryPath],
        outfile: outPath,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        logLevel: "silent",
      });
      bundlePath = outPath;
    } catch (error) {
      unsupportedReason = error instanceof Error ? error.message : String(error);
    }
  }, BUILD_TIMEOUT_MS);

  afterEach(async () => {
    while (running.length > 0) {
      const child = running.pop();
      child?.kill("SIGKILL");
    }
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Scoped TMPDIR so os.tmpdir() in the child is exactly what we scan. */
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "zim2090-scan-"));
    scratchDirs.push(dir);
    return dir;
  }

  async function stageInChild(input: {
    mode: "exit" | "wait";
    tmpDir: string;
    onDiskKey: boolean;
  }): Promise<StagedChild | null> {
    if (!bundlePath) {
      console.warn(`Skipping: could not bundle the child harness (${unsupportedReason ?? "unknown"})`);
      return null;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: input.tmpDir,
      PAPERCLIP_TEST_KEY_PATH: keyPath,
    };
    if (input.onDiskKey) env.PAPERCLIP_SSH_ALLOW_ONDISK_KEY = "1";
    else delete env.PAPERCLIP_SSH_ALLOW_ONDISK_KEY;

    const child = spawn(process.execPath, [bundlePath, input.mode], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    const staged = await new Promise<{ identityFile: string | null; socketPath: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child never reported staging: ${stderr}`)), 20_000);
        const check = () => {
          const line = stdout.split("\n")[0];
          if (!stdout.includes("\n") || !line) return;
          clearTimeout(timer);
          resolve(JSON.parse(line));
        };
        child.stdout.on("data", check);
        child.on("close", () => {
          clearTimeout(timer);
          const line = stdout.split("\n")[0];
          if (line) resolve(JSON.parse(line));
          else reject(new Error(`child exited before staging: ${stderr}`));
        });
      },
    );

    const handle: StagedChild = {
      ...staged,
      done,
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      },
      stderr: () => stderr,
    };
    running.push(handle);
    return handle;
  }

  it(
    "removes the opt-in key file when the process is terminated mid-command",
    async () => {
      const tmpDir = await scratch();
      const child = await stageInChild({ mode: "wait", tmpDir, onDiskKey: true });
      if (!child) return;

      // Precondition: this is the pre-ZIM-2088 artifact, really on disk.
      expect(child.identityFile).toBeTruthy();
      expect(await readFile(child.identityFile!, "utf8")).toContain(keySentinel);

      child.kill("SIGTERM");
      const outcome = await child.done;

      // The process still dies from the signal — the handler re-raises rather
      // than swallowing SIGTERM and making the run unkillable.
      expect(outcome.signal, `child stderr: ${child.stderr()}`).toBe("SIGTERM");
      await expect(stat(child.identityFile!)).rejects.toThrow();
      expect(await findKeyMaterial(tmpDir, keySentinel)).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "removes the opt-in key file when the process exits without unwinding",
    async () => {
      const tmpDir = await scratch();
      const child = await stageInChild({ mode: "exit", tmpDir, onDiskKey: true });
      if (!child) return;

      const outcome = await child.done;
      expect(outcome.code, `child stderr: ${child.stderr()}`).toBe(0);
      expect(child.identityFile).toBeTruthy();
      expect(await findKeyMaterial(tmpDir, keySentinel)).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills the identity agent and removes its socket directory on termination",
    async () => {
      if (!keyIsReal) {
        console.warn("Skipping: ssh-keygen unavailable, cannot produce a loadable identity");
        return;
      }
      const tmpDir = await scratch();
      const child = await stageInChild({ mode: "wait", tmpDir, onDiskKey: false });
      if (!child) return;
      if (!child.socketPath) {
        // No ssh-agent on PATH: the default path fails closed, which its own
        // test covers. Nothing to assert about cleanup here.
        console.warn(`Skipping: default agent path unavailable (${child.stderr().trim()})`);
        return;
      }

      const socketDir = path.dirname(child.socketPath);
      expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
      const agentPids = await pidsMatching(child.socketPath);
      expect(agentPids.length).toBeGreaterThan(0);

      child.kill("SIGTERM");
      expect((await child.done).signal, `child stderr: ${child.stderr()}`).toBe("SIGTERM");

      // The agent holds the key in its own memory, so an orphaned agent would
      // outlive the only thing bounding the exposure.
      await expect(stat(socketDir)).rejects.toThrow();
      expect(await pidsMatching(child.socketPath)).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * A throwaway ed25519 key, or null if ssh-keygen is unavailable.
 *
 * The agent path needs material libcrypto will actually accept, so a made-up
 * sentinel string is not enough there.
 */
async function generateKey(target: string): Promise<string | null> {
  const generated = await new Promise<boolean>((resolve) => {
    execFile(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "zim2090-test", "-f", target],
      { timeout: 20_000 },
      (error) => resolve(!error),
    );
  });
  if (!generated) return null;
  return await readFile(target, "utf8").catch(() => null);
}

/** A verbatim body line of the key — what an attacker would grep for. */
function bodyLine(privateKey: string): string {
  const lines = privateKey
    .split("\n")
    .filter((line) => !line.startsWith("-----") && line.trim().length > 0);
  const sentinel = lines[1] ?? lines[0] ?? "";
  expect(sentinel.length).toBeGreaterThan(16);
  return sentinel;
}

/** pids whose argv mentions `needle` — how we spot an orphaned ssh-agent. */
async function pidsMatching(needle: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  const hits: string[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(String(entry))) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (cmdline.includes(needle) && cmdline.includes("ssh-agent")) hits.push(String(entry));
  }
  return hits;
}

/** Every file under `root` whose bytes contain the sentinel key material. */
async function findKeyMaterial(root: string, sentinel: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const contents = await readFile(full, "utf8").catch(() => "");
        if (contents.includes(sentinel)) hits.push(full);
      }
    }
  };
  await walk(root);
  return hits;
}

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
} from "./ssh.js";

/**
 * End-to-end verification gate for ZIM-2088, against the real `ssh_openbsd`
 * fixture: real sshd, real ssh-agent, real filesystem.
 *
 * The finding was that `createSshAuthArgs` wrote the remote-exec private key to
 * a 0600 temp file. Every agent on a Paperclip host runs as the same
 * `paperclip` uid, so 0600 is not a boundary against the actual adversary, and
 * `buildSshSpawnTarget`'s cleanup only fires once the long-lived remote process
 * exits — leaving the key readable for the whole agent session.
 *
 * The gate is literal: while every `createSshAuthArgs` call site runs, sample
 * the filesystem and every process's argv, and assert the key material is never
 * observable in either. Sampling (not just an after-the-fact check) is the
 * point — a key that exists for 200ms is still a key another agent can read.
 *
 * Scoping note: the test points `TMPDIR` at a scratch root for the duration, so
 * `os.tmpdir()` — the directory the ssh helpers actually stage into — is both
 * exhaustively walkable and cheap to poll. The fixture's own key store lives
 * outside that root on purpose: it stands in for the vault the key legitimately
 * comes from, not for anything the ssh helpers wrote.
 */

const SSH_FIXTURE_TEST_TIMEOUT_MS = 60_000;
const WATCH_INTERVAL_MS = 25;

interface LeakWatcher {
  /** Files under the scan root found to contain the key material. */
  fileHits: string[];
  /** `/proc/<pid>/cmdline` entries found to contain the key material. */
  argvHits: string[];
  /** Every `paperclip-ssh-agent-*` directory seen, with the mode it had. */
  agentDirs: Map<string, number>;
  /** Every `paperclip-ssh-key-*` directory seen — the pre-fix artifact. */
  keyFileDirs: string[];
  sweep: () => Promise<void>;
  stop: () => Promise<void>;
}

async function walkFiles(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}

function startLeakWatcher(input: { scanRoot: string; sentinel: string }): LeakWatcher {
  const fileHits: string[] = [];
  const argvHits: string[] = [];
  const agentDirs = new Map<string, number>();
  const keyFileDirs: string[] = [];
  let running = false;

  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await walkFiles(input.scanRoot, async (file) => {
        const contents = await readFile(file, "utf8").catch(() => "");
        if (contents.includes(input.sentinel) && !fileHits.includes(file)) fileHits.push(file);
      });

      for (const entry of await readdir(input.scanRoot, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const full = path.join(input.scanRoot, entry.name);
        if (entry.name.startsWith("paperclip-ssh-agent-")) {
          const mode = (await stat(full).catch(() => null))?.mode;
          if (mode != null) agentDirs.set(full, mode & 0o777);
        }
        if (entry.name.startsWith("paperclip-ssh-key-") && !keyFileDirs.includes(full)) {
          keyFileDirs.push(full);
        }
      }

      // The adversary's actual view: /proc/<pid>/cmdline is world readable, so
      // any key that reaches argv is one `ps` away from every other agent.
      if (process.platform === "linux") {
        for (const entry of await readdir("/proc").catch(() => [])) {
          if (!/^\d+$/.test(String(entry))) continue;
          const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
          if (cmdline.includes(input.sentinel)) {
            const hit = `pid ${entry}: ${cmdline.split("\0")[0] ?? ""}`;
            if (!argvHits.includes(hit)) argvHits.push(hit);
          }
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void sweep();
  }, WATCH_INTERVAL_MS);
  timer.unref?.();

  return {
    fileHits,
    argvHits,
    agentDirs,
    keyFileDirs,
    sweep,
    stop: async () => {
      clearInterval(timer);
      // Let an in-flight sweep settle, then take a final one.
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
      await sweep();
    },
  };
}

/**
 * A verbatim body line of the fixture's client private key.
 *
 * Using real key material rather than a made-up string is what makes the gate
 * meaningful: this is the exact byte sequence an attacker would grep for, and
 * it has to survive being loaded into ssh-agent and used for a real handshake.
 */
function keyMaterialSentinel(privateKey: string): string {
  const bodyLines = privateKey
    .split("\n")
    .filter((line) => !line.startsWith("-----") && line.trim().length > 0);
  const sentinel = bodyLines[1] ?? bodyLines[0] ?? "";
  expect(sentinel.length).toBeGreaterThan(32);
  expect(privateKey).toContain(sentinel);
  return sentinel;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function listAgentIdentities(socketPath: string): Promise<string> {
  return await new Promise((resolve) => {
    execFile(
      "ssh-add",
      ["-l"],
      { env: { ...process.env, SSH_AUTH_SOCK: socketPath }, timeout: 5_000 },
      (_error, stdout, stderr) => {
        resolve(`${stdout}${stderr}`);
      },
    );
  });
}

function identityAgentSocket(args: string[]): string {
  const option = args.find((entry) => entry.startsWith("IdentityAgent="));
  expect(option, "expected -o IdentityAgent=<sock> in the ssh argv").toBeDefined();
  return option!.slice("IdentityAgent=".length);
}

describe("ZIM-2088 gate: SSH key material never reaches disk or argv", () => {
  const cleanupDirs: string[] = [];
  const restoreTmpDir: Array<() => void> = [];
  let unsupportedReason: string | null = null;

  afterEach(async () => {
    while (restoreTmpDir.length > 0) restoreTmpDir.pop()?.();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /** Fixture root deliberately lives outside the scanned TMPDIR. See header. */
  async function startFixtureOrSkip(label: string) {
    if (unsupportedReason) {
      console.warn(`Skipping ${label}: ${unsupportedReason}`);
      return null;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      unsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping ${label}: ${unsupportedReason}`);
      return null;
    }
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(fixtureRoot);
    try {
      const started = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
      return { started, fixtureRoot };
    } catch (error) {
      unsupportedReason = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping ${label}: ${unsupportedReason}`);
      return null;
    }
  }

  /** Repoints os.tmpdir() at a fresh scratch root for the rest of the test. */
  async function useScopedTmpDir(): Promise<string> {
    const scanRoot = await mkdtemp(path.join(os.tmpdir(), "zim2088-scan-"));
    cleanupDirs.push(scanRoot);
    const previous = process.env.TMPDIR;
    restoreTmpDir.push(() => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    });
    process.env.TMPDIR = scanRoot;
    return scanRoot;
  }

  it("keeps key material unobservable across every createSshAuthArgs call site", async () => {
    const fixture = await startFixtureOrSkip("ZIM-2088 key-material gate");
    if (!fixture) return;
    const { started, fixtureRoot } = fixture;
    const config = await buildSshEnvLabFixtureConfig(started);
    const sentinel = keyMaterialSentinel(config.privateKey!);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    // Local git repo + sync sources live outside the scanned root: they are
    // test inputs, not artifacts of the code under test.
    const localRepo = path.join(fixtureRoot, "local-workspace");
    const overlayDir = path.join(fixtureRoot, "overlay");
    const restoreDir = path.join(fixtureRoot, "restored");
    await mkdir(overlayDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    await mkdir(localRepo, { recursive: true });
    await writeFile(path.join(overlayDir, "message.txt"), "hello from paperclip\n", "utf8");
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const scanRoot = await useScopedTmpDir();
    const watcher = startLeakWatcher({ scanRoot, sentinel });

    try {
      // 1. runSshCommand
      const echoed = await runSshCommand(config, "printf ok", { timeoutMs: 30_000 });
      expect(echoed.stdout.trim()).toBe("ok");

      // 2. buildSshSpawnTarget — the long-window call site the finding is about.
      const target = await buildSshSpawnTarget({
        spec,
        command: "printf",
        args: ["spawned"],
        env: { PAPERCLIP_MARKER: "spawn-target" },
      });
      await target.cleanup();

      // 3. syncDirectoryToSsh
      const remoteOverlay = path.posix.join(started.workspaceDir, "overlay");
      await syncDirectoryToSsh({ spec, localDir: overlayDir, remoteDir: remoteOverlay });

      // 4. syncDirectoryFromSsh
      await syncDirectoryFromSsh({ spec, remoteDir: remoteOverlay, localDir: restoreDir });
      expect(await readFile(path.join(restoreDir, "message.txt"), "utf8")).toBe("hello from paperclip\n");

      // 5. streamLocalFileToSsh, via the git-bundle import.
      await prepareWorkspaceForSshExecution({
        spec,
        localDir: localRepo,
        remoteDir: started.workspaceDir,
      });

      // 6. streamSshToLocalFile, via the git-bundle export.
      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: localRepo,
        remoteDir: started.workspaceDir,
      });
    } finally {
      await watcher.stop();
      await stopSshEnvLabFixture(path.join(fixtureRoot, "state.json")).catch(() => undefined);
    }

    // The gate itself: no readable private key material under any path the
    // shared uid can open, at any point during the run or after it.
    expect(watcher.fileHits).toEqual([]);
    expect(watcher.argvHits).toEqual([]);
    // The pre-fix artifact never appears at all.
    expect(watcher.keyFileDirs).toEqual([]);

    // The agent path actually ran, and its socket directory was 0700 every
    // time we looked and is gone now.
    expect(watcher.agentDirs.size).toBeGreaterThan(0);
    for (const [dir, mode] of watcher.agentDirs) {
      expect(`${dir}: ${mode.toString(8)}`).toBe(`${dir}: 700`);
      await expect(stat(dir)).rejects.toThrow();
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("removes the agent socket directory when the ssh call throws", async () => {
    const fixture = await startFixtureOrSkip("ZIM-2088 error-path cleanup");
    if (!fixture) return;
    const { started, fixtureRoot } = fixture;
    const config = await buildSshEnvLabFixtureConfig(started);
    const sentinel = keyMaterialSentinel(config.privateKey!);

    const scanRoot = await useScopedTmpDir();
    const watcher = startLeakWatcher({ scanRoot, sentinel });

    try {
      // Same host and key, but a port nothing is listening on: auth setup
      // succeeds, the connection fails.
      await expect(
        runSshCommand({ ...config, port: started.port + 1 }, "printf ok", { timeoutMs: 20_000 }),
      ).rejects.toThrow();
    } finally {
      await watcher.stop();
      await stopSshEnvLabFixture(path.join(fixtureRoot, "state.json")).catch(() => undefined);
    }

    expect(watcher.fileHits).toEqual([]);
    expect(watcher.argvHits).toEqual([]);
    expect(watcher.agentDirs.size).toBeGreaterThan(0);
    for (const dir of watcher.agentDirs.keys()) {
      await expect(stat(dir)).rejects.toThrow();
    }
    // Nothing at all is left behind under the scan root.
    expect(await readdir(scanRoot)).toEqual([]);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("expires the identity while an already-established session keeps running", async () => {
    const fixture = await startFixtureOrSkip("ZIM-2088 identity expiry");
    if (!fixture) return;
    const { started, fixtureRoot } = fixture;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const previousTtl = process.env.PAPERCLIP_SSH_AGENT_IDENTITY_TTL_SECONDS;
    process.env.PAPERCLIP_SSH_AGENT_IDENTITY_TTL_SECONDS = "1";

    let target: Awaited<ReturnType<typeof buildSshSpawnTarget>> | null = null;
    try {
      // `cat` echoes stdin back for as long as the session lives — a stand-in
      // for the hours-long agent process that resolveSpawnTarget starts.
      target = await buildSshSpawnTarget({ spec, command: "cat", args: [], env: {} });
      const socketPath = identityAgentSocket(target.args);

      const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"] });
      try {
        const readLine = async (): Promise<string> =>
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for remote echo")), 20_000);
            const onData = (chunk: Buffer) => {
              const text = String(chunk);
              if (!text.includes("\n")) return;
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve(text.trim());
            };
            child.stdout.on("data", onData);
            child.on("close", () => {
              clearTimeout(timer);
              reject(new Error("session closed before echoing"));
            });
          });

        child.stdin.write("before-expiry\n");
        expect(await readLine()).toBe("before-expiry");
        expect(await listAgentIdentities(socketPath)).toContain("ED25519");

        // Past the 1s lifetime.
        await new Promise((resolve) => setTimeout(resolve, 2_500));

        // The credential is no longer usable...
        expect(await listAgentIdentities(socketPath)).toContain("no identities");

        // ...but the session established while it was valid still works. That
        // is the whole basis for bounding the lifetime instead of trying to
        // detect "connection established".
        child.stdin.write("after-expiry\n");
        expect(await readLine()).toBe("after-expiry");
      } finally {
        child.stdin.end();
        child.kill("SIGTERM");
      }

      await target.cleanup();
      target = null;
      await expect(stat(path.dirname(socketPath))).rejects.toThrow();
    } finally {
      await target?.cleanup().catch(() => undefined);
      if (previousTtl === undefined) delete process.env.PAPERCLIP_SSH_AGENT_IDENTITY_TTL_SECONDS;
      else process.env.PAPERCLIP_SSH_AGENT_IDENTITY_TTL_SECONDS = previousTtl;
      await stopSshEnvLabFixture(path.join(fixtureRoot, "state.json")).catch(() => undefined);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
});

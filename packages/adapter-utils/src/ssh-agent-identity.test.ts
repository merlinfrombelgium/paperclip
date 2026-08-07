import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression gate for ZIM-2088.
 *
 * `createSshAuthArgs` used to write the remote-exec private key to a 0600 temp
 * file and pass it as `-i <path>`. Every agent on a Paperclip host runs as the
 * same `paperclip` uid, so 0600 is not a boundary against the actual adversary,
 * and `buildSshSpawnTarget` kept that file on disk for the whole agent session
 * (minutes to hours) because its cleanup only runs once the remote process
 * exits.
 *
 * The key now goes into a per-invocation ssh-agent over stdin. These tests pin
 * that: no key material on disk, none in argv, a 0700 socket directory that is
 * removed on both the success and the error path, and no silent fallback.
 *
 * The end-to-end version of the same gate — real sshd, real ssh-agent, real
 * filesystem sweep — lives in ssh-agent-identity-fixture.test.ts.
 */

const KEY_MATERIAL = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "zim2088SentinelPrivateKeyMaterialMustNeverTouchDiskOrArgv",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const KEY_SENTINEL = "zim2088SentinelPrivateKeyMaterialMustNeverTouchDiskOrArgv";

/** A pid that is not running, so the SIGKILL fallback stays a no-op. */
const FAKE_AGENT_PID = 4_194_303;

interface RecordedCall {
  file: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv | undefined;
}

const hoisted = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  missingCommands: new Set<string>(),
  failSshAdd: false,
  failSsh: false,
}));

vi.mock("node:child_process", () => {
  const COMMAND_PROBE = /^command -v '(.+)'$/;

  const resultFor = (file: string, args: string[]): { code: number; stdout: string; stderr: string } => {
    if (file === "sh" && args[0] === "-c") {
      const probe = String(args[1] ?? "").match(COMMAND_PROBE);
      if (probe) {
        const command = probe[1]!;
        return hoisted.missingCommands.has(command)
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: `/usr/bin/${command}\n`, stderr: "" };
      }
    }
    if (file === "ssh-agent" && args[0] === "-a") {
      const socketPath = args[1] ?? "";
      return {
        code: 0,
        stdout: [
          `SSH_AUTH_SOCK=${socketPath}; export SSH_AUTH_SOCK;`,
          `SSH_AGENT_PID=${FAKE_AGENT_PID}; export SSH_AGENT_PID;`,
          `echo Agent pid ${FAKE_AGENT_PID};`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (file === "ssh-add") {
      return hoisted.failSshAdd
        ? { code: 1, stdout: "", stderr: "Error loading key: incorrect passphrase supplied" }
        : { code: 0, stdout: "", stderr: "Identity added: (stdin)\n" };
    }
    if (file === "ssh" && hoisted.failSsh) {
      return { code: 255, stdout: "", stderr: "ssh: connect to host port 22: Connection refused" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    spawn: (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let stdin = "";
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = {
        destroyed: false,
        write: (chunk: unknown) => {
          stdin += String(chunk);
          return true;
        },
        end: (chunk?: unknown) => {
          if (chunk != null) stdin += String(chunk);
        },
      };
      child.killed = false;
      child.kill = () => true;

      setImmediate(() => {
        hoisted.calls.push({ file, args, stdin, env: options?.env });
        const result = resultFor(file, args);
        if (result.stdout) stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
        child.emit("close", result.code, null);
      });

      return child;
    },
    execFile: (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv } | undefined,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      hoisted.calls.push({ file, args, stdin: "", env: options?.env });
      const result = resultFor(file, args);
      setImmediate(() => {
        if (result.code !== 0) {
          callback(Object.assign(new Error(result.stderr || `exit ${result.code}`), { code: result.code }), result.stdout, result.stderr);
          return;
        }
        callback(null, result.stdout, result.stderr);
      });
      return new EventEmitter();
    },
  };
});

const { buildSshSpawnTarget, runSshCommand, SSH_AGENT_IDENTITY_LIFETIME_SECONDS } = await import("./ssh.js");

const SPEC = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: KEY_MATERIAL,
  knownHosts: null,
  strictHostKeyChecking: false,
};

let scratchDir: string;
let originalTmpDir: string | undefined;

function callsFor(file: string): RecordedCall[] {
  return hoisted.calls.filter((call) => call.file === file);
}

/** Every argv element handed to a locally spawned process, across all calls. */
function allSpawnedArgv(): string[] {
  return hoisted.calls.flatMap((call) => [call.file, ...call.args]);
}

/** Socket path the ssh invocation was pointed at, via `-o IdentityAgent=`. */
function identityAgentSocket(argv: string[]): string {
  const option = argv.find((entry) => entry.startsWith("IdentityAgent="));
  expect(option).toBeDefined();
  return option!.slice("IdentityAgent=".length);
}

describe("SSH key auth keeps private key material off disk and out of argv", () => {
  beforeEach(async () => {
    hoisted.calls.length = 0;
    hoisted.missingCommands.clear();
    hoisted.failSshAdd = false;
    hoisted.failSsh = false;
    originalTmpDir = process.env.TMPDIR;
    // Scope os.tmpdir() to a fresh directory so the sweep below is exact and
    // cheap: everything the ssh helpers stage lands here and nowhere else.
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "zim2088-scratch-"));
    process.env.TMPDIR = scratchDir;
    delete process.env.PAPERCLIP_SSH_ALLOW_ONDISK_KEY;
  });

  afterEach(async () => {
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    delete process.env.PAPERCLIP_SSH_ALLOW_ONDISK_KEY;
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("loads the key into a per-invocation agent over stdin, never a file or argv", async () => {
    await runSshCommand(SPEC, "printf hello");

    const sshAdd = callsFor("ssh-add");
    expect(sshAdd.length).toBe(1);
    // The material arrives on stdin only.
    expect(sshAdd[0]!.stdin).toContain(KEY_SENTINEL);
    expect(sshAdd[0]!.args).toEqual(["-t", String(SSH_AGENT_IDENTITY_LIFETIME_SECONDS), "-"]);
    // No argv element of any spawned process carries the key.
    expect(allSpawnedArgv().filter((entry) => entry.includes(KEY_SENTINEL))).toEqual([]);

    const sshCall = callsFor("ssh").at(-1)!;
    expect(identityAgentSocket(sshCall.args)).toContain("paperclip-ssh-agent-");
    // The on-disk identity file is gone for good.
    expect(sshCall.args).not.toContain("-i");
    // IdentitiesOnly=yes would suppress the agent identity and break auth.
    expect(sshCall.args.join(" ")).not.toContain("IdentitiesOnly");
  });

  it("pins the 120s identity lifetime that the long-lived spawn path relies on", async () => {
    // resolveSpawnTarget hands buildSshSpawnTarget's argv straight to spawn, so
    // the identity only has to outlive connection setup. If a future change
    // queues that spawn behind something slower, this fails loudly here rather
    // than intermittently in production.
    expect(SSH_AGENT_IDENTITY_LIFETIME_SECONDS).toBe(120);

    const target = await buildSshSpawnTarget({ spec: SPEC, command: "claude", args: ["--print"], env: {} });
    try {
      expect(callsFor("ssh-add")[0]!.args).toEqual(["-t", "120", "-"]);
      // The returned argv is what the long-lived agent process is spawned with.
      expect([target.command, ...target.args].filter((entry) => entry.includes(KEY_SENTINEL))).toEqual([]);
      expect(target.args).not.toContain("-i");
    } finally {
      await target.cleanup();
    }
  });

  it("holds the agent socket in a 0700 directory and removes it on cleanup", async () => {
    const target = await buildSshSpawnTarget({ spec: SPEC, command: "claude", args: ["--print"], env: {} });
    const socketPath = identityAgentSocket(target.args);
    const socketDir = path.dirname(socketPath);

    const dirStat = await stat(socketDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    await target.cleanup();

    await expect(stat(socketDir)).rejects.toThrow();
    // And the agent was asked to shut down, not just orphaned.
    const kill = callsFor("ssh-agent").filter((call) => call.args[0] === "-k");
    expect(kill.length).toBe(1);
    expect(kill[0]!.env?.SSH_AGENT_PID).toBe(String(FAKE_AGENT_PID));
    expect(kill[0]!.env?.SSH_AUTH_SOCK).toBe(socketPath);
  });

  it("tears the agent down when the ssh call itself throws", async () => {
    hoisted.failSsh = true;

    await expect(runSshCommand(SPEC, "printf hello")).rejects.toThrow();

    const socketPath = identityAgentSocket(callsFor("ssh").at(-1)!.args);
    await expect(stat(path.dirname(socketPath))).rejects.toThrow();
    expect(callsFor("ssh-agent").filter((call) => call.args[0] === "-k").length).toBe(1);
    await expectNoKeyMaterialUnderTmp();
  });

  it("tears the agent down when the key fails to load", async () => {
    hoisted.failSshAdd = true;

    await expect(runSshCommand(SPEC, "printf hello")).rejects.toThrow(/ssh-agent \(ZIM-2088\)/);

    // No ssh connection was attempted with a half-built agent.
    expect(callsFor("ssh").length).toBe(0);
    expect(callsFor("ssh-agent").filter((call) => call.args[0] === "-k").length).toBe(1);
    await expectNoKeyMaterialUnderTmp();
  });

  it("strips the askpass hooks so an encrypted key fails fast instead of hanging", async () => {
    process.env.DISPLAY = ":0";
    process.env.SSH_ASKPASS = "/usr/bin/ssh-askpass";
    try {
      await runSshCommand(SPEC, "printf hello");
      const sshAdd = callsFor("ssh-add")[0]!;
      expect(sshAdd.env?.DISPLAY).toBeUndefined();
      expect(sshAdd.env?.SSH_ASKPASS).toBeUndefined();
      expect(sshAdd.env?.SSH_AUTH_SOCK).toBeTruthy();
    } finally {
      delete process.env.DISPLAY;
      delete process.env.SSH_ASKPASS;
    }
  });

  it("fails closed when ssh-agent is unavailable rather than falling back to a key file", async () => {
    hoisted.missingCommands.add("ssh-agent");

    await expect(runSshCommand(SPEC, "printf hello")).rejects.toThrow(/ZIM-2088/);
    expect(callsFor("ssh").length).toBe(0);
    await expectNoKeyMaterialUnderTmp();
  });

  it("writes a key file only under the explicit opt-in, and says so loudly", async () => {
    process.env.PAPERCLIP_SSH_ALLOW_ONDISK_KEY = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runSshCommand(SPEC, "printf hello");

    expect(callsFor("ssh-add").length).toBe(0);
    const sshCall = callsFor("ssh").at(-1)!;
    expect(sshCall.args).toContain("-i");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ZIM-2088"));
    // Still no key in argv, and the file is removed once the call completes.
    expect(allSpawnedArgv().filter((entry) => entry.includes(KEY_SENTINEL))).toEqual([]);
    await expectNoKeyMaterialUnderTmp();
  });

  it("leaves no key material under tmpdir after a successful run", async () => {
    await runSshCommand(SPEC, "printf hello");
    await expectNoKeyMaterialUnderTmp();
  });

  async function expectNoKeyMaterialUnderTmp(): Promise<void> {
    const hits = await findKeyMaterial(scratchDir);
    expect(hits).toEqual([]);
  }
});

/** Every file under `root` whose bytes contain the sentinel key material. */
async function findKeyMaterial(root: string): Promise<string[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const contents = await readFile(full, "utf8").catch(() => "");
        if (contents.includes(KEY_SENTINEL)) hits.push(full);
      }
    }
  };
  await walk(root);
  return hits;
}

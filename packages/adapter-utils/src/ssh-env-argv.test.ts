import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression gate for ZIM-2069 / ZIM-2082.
 *
 * `/proc/<pid>/cmdline` is world readable and every agent on a Paperclip host
 * runs under the same shared uid, so any env value that reaches the local `ssh`
 * process's argv is readable by every other concurrently running agent with a
 * single `ps` call. For PAPERCLIP_API_KEY that is cross-agent impersonation
 * with audit-log attribution to the victim.
 *
 * These tests drive each Class A entry point with a sentinel env value and
 * assert the sentinel appears in NO argv element of any spawned process. The
 * assertions are on the *value*, never the key name — the key legitimately
 * appears in paths and file references.
 */

const SENTINEL = "sk-zim2082-sentinel-do-not-leak";
const SENTINEL_KEY = "PAPERCLIP_API_KEY";

const hoisted = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ file: string; args: string[]; stdin: string }>,
  execFileCalls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock("node:child_process", () => {
  const ENV_FILE_PATTERN = /paperclip-env-[0-9a-fA-F-]+/;

  // The env-file writer connection echoes back the remote path it used; the
  // real remote shell derives it from $TMPDIR, so mirror that here.
  const remoteEnvFilePath = (args: string[]): string => {
    const match = args.join(" ").match(ENV_FILE_PATTERN);
    return match ? `/tmp/${match[0]}` : "";
  };

  return {
    spawn: (file: string, args: string[]) => {
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
        hoisted.spawnCalls.push({ file, args, stdin });
        const echoed = remoteEnvFilePath(args);
        if (echoed) stdout.emit("data", Buffer.from(echoed));
        child.emit("close", 0, null);
      });

      return child;
    },
    execFile: (
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      hoisted.execFileCalls.push({ file, args });
      setImmediate(() => callback(null, "", ""));
      return new EventEmitter();
    },
  };
});

const { buildSshSpawnTarget, createSshCommandManagedRuntimeRunner, runSshCommand } = await import("./ssh.js");

const SPEC = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

/** Every argv element handed to a locally spawned process, across all calls. */
function allSpawnedArgv(): string[] {
  return [
    ...hoisted.spawnCalls.flatMap((call) => [call.file, ...call.args]),
    ...hoisted.execFileCalls.flatMap((call) => [call.file, ...call.args]),
  ];
}

function expectSentinelAbsentFromArgv(extraArgv: string[] = []): void {
  const argv = [...allSpawnedArgv(), ...extraArgv];
  expect(argv.length).toBeGreaterThan(0);
  const leaking = argv.filter((entry) => entry.includes(SENTINEL));
  expect(leaking).toEqual([]);
}

/** The value has to actually reach the remote — over the channel, not argv. */
function expectSentinelDeliveredOverChannel(): void {
  const carriers = hoisted.spawnCalls.filter((call) => call.stdin.includes(SENTINEL));
  expect(carriers.length).toBe(1);
  expect(carriers[0]!.stdin).toContain(`export ${SENTINEL_KEY}=`);
}

describe("SSH env delivery keeps secrets out of argv", () => {
  beforeEach(() => {
    hoisted.spawnCalls.length = 0;
    hoisted.execFileCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps env values out of argv for runSshCommand", async () => {
    await runSshCommand(SPEC, "printf hello", {
      env: { [SENTINEL_KEY]: SENTINEL },
    });

    expectSentinelAbsentFromArgv();
    expectSentinelDeliveredOverChannel();
  });

  it("keeps env values out of argv for runSshCommand when the caller owns stdin", async () => {
    await runSshCommand(SPEC, "cat > /tmp/out", {
      env: { [SENTINEL_KEY]: SENTINEL },
      stdin: "caller-supplied payload\n",
    });

    expectSentinelAbsentFromArgv();
    expectSentinelDeliveredOverChannel();
    // Caller stdin must still reach the command, unmixed with the env payload.
    const callerStdin = hoisted.spawnCalls.filter((call) => call.stdin.includes("caller-supplied payload"));
    expect(callerStdin.length).toBe(1);
    expect(callerStdin[0]!.stdin).not.toContain(SENTINEL);
  });

  it("keeps env values out of argv for buildSshSpawnTarget", async () => {
    const target = await buildSshSpawnTarget({
      spec: SPEC,
      command: "claude",
      args: ["--print"],
      env: { [SENTINEL_KEY]: SENTINEL },
    });

    // The returned argv is what the long-lived agent process is spawned with.
    expectSentinelAbsentFromArgv([target.command, ...target.args]);
    expectSentinelDeliveredOverChannel();
    await target.cleanup();
  });

  it("keeps env values out of argv for createSshCommandManagedRuntimeRunner", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: SPEC });

    const result = await runner.execute({
      command: "node",
      args: ["--version"],
      env: { [SENTINEL_KEY]: SENTINEL },
    });

    expect(result.exitCode).toBe(0);
    expectSentinelAbsentFromArgv();
    expectSentinelDeliveredOverChannel();
  });

  it("keeps env values out of argv for the runner's sh -c shape", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: SPEC });

    await runner.execute({
      command: "sh",
      args: ["-c", "printf hello"],
      env: { [SENTINEL_KEY]: SENTINEL },
    });

    expectSentinelAbsentFromArgv();
    expectSentinelDeliveredOverChannel();
  });

  it("does not open an env-file connection when no env is passed", async () => {
    await runSshCommand(SPEC, "printf hello");

    expect(hoisted.spawnCalls).toEqual([]);
    expect(hoisted.execFileCalls.length).toBe(1);
    expect(allSpawnedArgv().join(" ")).not.toContain("paperclip-env-");
  });
});

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";
import { mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
} from "./runtime-progress.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
}

export interface SshRemoteExecutionSpec extends SshConnectionConfig {
  remoteCwd: string;
}

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const env = Object.fromEntries(
        Object.entries(commandInput.env ?? {})
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      // Env is handed to runSshCommand rather than inlined here: baking
      // `env KEY=VAL` / `export KEY=VAL` into the remote command string puts
      // the values in the local ssh process's argv, where any agent sharing
      // this host's uid can read them out of /proc (ZIM-2069). runSshCommand
      // owns the single hardened delivery path.
      const commandScript = command === "sh" || command === "bash"
        ? (args[0] === "-c" || args[0] === "-lc") && typeof args[1] === "string"
          ? args[1]
          : `exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`
        : `exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `cd ${shellQuote(cwd)} && ${commandScript}`;

      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          env,
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export interface SshEnvLabSupport {
  supported: boolean;
  reason: string | null;
}

export interface SshEnvLabFixtureState {
  kind: "ssh_openbsd";
  bindHost: string;
  host: string;
  port: number;
  username: string;
  rootDir: string;
  workspaceDir: string;
  statePath: string;
  pid: number;
  createdAt: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  hostPrivateKeyPath: string;
  hostPublicKeyPath: string;
  authorizedKeysPath: string;
  knownHostsPath: string;
  sshdConfigPath: string;
  sshdLogPath: string;
}

interface LocalGitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseSshRemoteExecutionSpec(value: unknown): SshRemoteExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
  const remoteCwd = typeof parsed.remoteCwd === "string" ? parsed.remoteCwd.trim() : "";
  const portValue = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
  if (!host || !username || !remoteCwd || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return null;
  }

  return {
    host,
    port: portValue,
    username,
    remoteCwd,
    remoteWorkspacePath:
      typeof parsed.remoteWorkspacePath === "string" && parsed.remoteWorkspacePath.trim().length > 0
        ? parsed.remoteWorkspacePath.trim()
        : remoteCwd,
    privateKey: typeof parsed.privateKey === "string" && parsed.privateKey.length > 0 ? parsed.privateKey : null,
    knownHosts: typeof parsed.knownHosts === "string" && parsed.knownHosts.length > 0 ? parsed.knownHosts : null,
    strictHostKeyChecking:
      typeof parsed.strictHostKeyChecking === "boolean" ? parsed.strictHostKeyChecking : true,
  };
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await execFileText("git", ["-C", localDir, ...args], options);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-c", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Seconds the remote-exec private key stays loaded in its per-invocation agent.
 *
 * ssh only consults an identity during connection setup. Bounding the identity
 * lifetime therefore lets the long-lived session built by `buildSshSpawnTarget`
 * keep running for hours while the credential itself stops being usable about
 * two minutes in — which collapses the ZIM-2088 exposure window without having
 * to detect "connection established". `resolveSpawnTarget` (server-utils.ts)
 * hands the argv straight to spawn, so 120s is ample today; the pinned
 * assertion in ssh-agent-identity.test.ts makes a future change that queues
 * that spawn fail loudly instead of breaking connections intermittently.
 */
export const SSH_AGENT_IDENTITY_LIFETIME_SECONDS = 120;

/**
 * Explicit, loudly-logged opt-in back to the pre-ZIM-2088 on-disk key file.
 * There is deliberately no silent fallback: a quiet downgrade would reintroduce
 * the finding invisibly.
 */
const ON_DISK_KEY_ESCAPE_HATCH_ENV = "PAPERCLIP_SSH_ALLOW_ONDISK_KEY";

/** Test-only override for {@link SSH_AGENT_IDENTITY_LIFETIME_SECONDS}. */
const IDENTITY_LIFETIME_OVERRIDE_ENV = "PAPERCLIP_SSH_AGENT_IDENTITY_TTL_SECONDS";

const SSH_AGENT_COMMAND_TIMEOUT_MS = 5_000;

function resolveSshAgentIdentityLifetimeSeconds(): number {
  const raw = process.env[IDENTITY_LIFETIME_OVERRIDE_ENV]?.trim();
  if (!raw) return SSH_AGENT_IDENTITY_LIFETIME_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return SSH_AGENT_IDENTITY_LIFETIME_SECONDS;
  // Clamped: an unbounded identity would be the exact thing this replaces.
  return Math.min(parsed, 3_600);
}

function describeProcessError(error: unknown): string {
  const failure = error as { stderr?: unknown } | null;
  const stderr = typeof failure?.stderr === "string" ? failure.stderr.trim() : "";
  if (stderr) return stderr;
  return error instanceof Error ? error.message : String(error);
}

/** `SSH_AGENT_PID=12345; export SSH_AGENT_PID;` out of ssh-agent's shell preamble. */
function parseSshAgentPid(stdout: string): number | null {
  const match = stdout.match(/SSH_AGENT_PID=(\d+)/);
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

interface SshIdentityAgent {
  socketPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Starts a throwaway ssh-agent, loads `privateKey` into it over stdin, and
 * returns the socket path.
 *
 * The key material never touches a file and never touches argv: `ps` and
 * `/proc/<pid>/cmdline` see only the socket path, which is not secret, and the
 * only on-disk artefact is a 0700 directory holding an AF_UNIX socket. That
 * matters because every agent on a Paperclip host runs as the same `paperclip`
 * uid, so the old 0600 key file was not a boundary against the actual adversary
 * (ZIM-2088).
 */
async function startSshIdentityAgent(privateKey: string): Promise<SshIdentityAgent> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-agent-"));
  // mkdtemp already creates 0700, but this directory is the only thing standing
  // between the agent socket and every other process sharing this uid, so set
  // the mode explicitly instead of inheriting a platform default.
  await fs.chmod(dir, 0o700);
  // AF_UNIX sun_path caps at ~108 bytes and TMPDIR is already run-scoped and
  // long here, so keep the socket's leaf name to a single character.
  const socketPath = path.join(dir, "s");

  const removeDir = async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  let startOutput: SshCommandResult;
  try {
    startOutput = await execFileText("ssh-agent", ["-a", socketPath], {
      timeout: SSH_AGENT_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
  } catch (error) {
    await removeDir();
    throw new Error(
      `Failed to start ssh-agent for SSH key authentication (ZIM-2088): ${describeProcessError(error)}`,
    );
  }

  const agentPid = parseSshAgentPid(startOutput.stdout);
  const killAgent = async () => {
    if (agentPid == null) {
      // Unreachable with stock OpenSSH. If it ever happens we cannot reap the
      // process, but the identity is memory-only and self-expires, so degrade
      // rather than leaving the caller without a working connection.
      console.warn(
        "[ssh] ssh-agent did not report SSH_AGENT_PID; cannot kill it explicitly. " +
          `The loaded identity still expires after ${resolveSshAgentIdentityLifetimeSeconds()}s (ZIM-2088).`,
      );
      return;
    }
    await execFileText("ssh-agent", ["-k"], {
      timeout: SSH_AGENT_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      env: { ...process.env, SSH_AUTH_SOCK: socketPath, SSH_AGENT_PID: String(agentPid) },
    }).catch(() => undefined);
    if (await isPidRunning(agentPid)) {
      try {
        process.kill(agentPid, "SIGKILL");
      } catch {
        // Already gone between the check and the signal — fine.
      }
    }
  };

  try {
    await loadSshAgentIdentity({ socketPath, privateKey });
  } catch (error) {
    await killAgent();
    await removeDir();
    throw error;
  }

  return {
    socketPath,
    cleanup: async () => {
      await killAgent();
      await removeDir();
    },
  };
}

async function loadSshAgentIdentity(input: {
  socketPath: string;
  privateKey: string;
}): Promise<void> {
  const material = input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`;
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: input.socketPath };
  // An encrypted key would otherwise hang here forever waiting on a passphrase.
  // Dropping the askpass hooks and closing stdin right after the material (which
  // spawnText does) makes that case fail fast; the timeout below is the backstop.
  delete env.DISPLAY;
  delete env.SSH_ASKPASS;

  try {
    // `-` reads the key from stdin (OpenSSH >= 8.2): no file, no argv.
    await spawnText("ssh-add", ["-t", String(resolveSshAgentIdentityLifetimeSeconds()), "-"], {
      stdin: material,
      env,
      timeout: SSH_AGENT_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Failed to load the SSH private key into ssh-agent (ZIM-2088): ${describeProcessError(error)}`,
    );
  }
}

async function createSshKeyAuthArgs(
  privateKey: string,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  if (process.env[ON_DISK_KEY_ESCAPE_HATCH_ENV] === "1") {
    console.warn(
      `[ssh] ${ON_DISK_KEY_ESCAPE_HATCH_ENV}=1: writing the SSH private key to a temp file. ` +
        "Every agent on this host shares one uid, so 0600 is not a boundary and the key is readable by " +
        "any of them for as long as the connection lives (ZIM-2088). Unset this to use ssh-agent.",
    );
    const keyFile = await withTempFile("paperclip-ssh-key-", privateKey, 0o600);
    return { args: ["-i", keyFile.path], cleanup: keyFile.cleanup };
  }

  const missing: string[] = [];
  for (const command of ["ssh-agent", "ssh-add"]) {
    if (!(await commandExists(command))) missing.push(command);
  }
  if (missing.length > 0) {
    // Fail closed. These ship in the same openssh-client package as `ssh`
    // itself, so this is close to unreachable, and a silent fallback to the
    // on-disk key would reintroduce ZIM-2088 without anyone noticing.
    throw new Error(
      `SSH key authentication requires ${missing.join(" and ")} (openssh-client), not found on PATH. ` +
        "Paperclip no longer writes the private key to disk (ZIM-2088). Install openssh-client, or set " +
        `${ON_DISK_KEY_ESCAPE_HATCH_ENV}=1 to opt back into the on-disk key with its known exposure.`,
    );
  }

  const agent = await startSshIdentityAgent(privateKey);
  return {
    // IdentitiesOnly=yes is deliberately absent: it suppresses agent identities
    // and would leave the connection with no usable key. The socket path is not
    // secret, so unlike env values (ZIM-2069) it is fine in argv.
    args: ["-o", `IdentityAgent=${agent.socketPath}`],
    cleanup: agent.cleanup,
  };
}

async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const cleanups: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  const cleanup = async () => {
    await Promise.all(cleanups.map((entry) => entry()));
  };

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      cleanups.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    let keyAuth: { args: string[]; cleanup: () => Promise<void> };
    try {
      keyAuth = await createSshKeyAuthArgs(config.privateKey);
    } catch (error) {
      // Don't strand the known-hosts file when key setup fails.
      await cleanup();
      throw error;
    }
    cleanups.push(keyAuth.cleanup);
    sshArgs.push(...keyAuth.args);
  }

  return { args: sshArgs, cleanup };
}

export interface RemoteEnvFile {
  /** Absolute path of the staged file on the remote host. Safe to put in argv. */
  path: string;
  /** Shell fragment that loads the env then deletes the file. Contains no values. */
  sourceScript: string;
  /** Best-effort removal for the case where the consuming command never ran. */
  remove: () => Promise<void>;
}

/**
 * Stages `envEntries` in a 0600 file on the remote host and returns only the
 * path plus a shell fragment that sources it.
 *
 * Env values must never reach the local `ssh` argv. `/proc/<pid>/cmdline` is
 * world readable and every agent on a Paperclip host runs under the same shared
 * uid, so an inlined `env KEY=VAL` / `export KEY=VAL` leaks one agent's
 * PAPERCLIP_API_KEY to any other concurrently running agent via a single `ps`
 * call — cross-agent impersonation with audit attribution to the victim
 * (ZIM-2069). The values here travel over the encrypted ssh channel on stdin
 * instead; argv carries the non-secret path only.
 *
 * `SendEnv`/`AcceptEnv` is deliberately not used: it requires matching remote
 * `sshd_config`, which we do not control on arbitrary targets.
 */
async function writeRemoteEnvFile(input: {
  config: SshConnectionConfig;
  authArgs: string[];
  envEntries: Array<[string, string]>;
  timeoutMs?: number;
}): Promise<RemoteEnvFile> {
  const fileName = `paperclip-env-${randomUUID()}`;
  const target = `${input.config.username}@${input.config.host}`;
  const portArgs = ["-p", String(input.config.port)];

  // `umask 077` before the redirect so the file is never briefly world readable.
  // The remote shell resolves TMPDIR and echoes back the path it actually used,
  // so the consuming connection does not have to re-derive it.
  const writerScript = [
    "umask 077",
    'dir="${TMPDIR:-/tmp}"',
    `file="$dir/${fileName}"`,
    'cat > "$file"',
    'chmod 600 "$file"',
    'printf %s "$file"',
  ].join(" && ");

  const payload = `${input.envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n")}\n`;
  const written = await spawnText(
    "ssh",
    [...input.authArgs, ...portArgs, target, `sh -c ${shellQuote(writerScript)}`],
    {
      stdin: payload,
      timeout: input.timeoutMs ?? 15_000,
      maxBuffer: 64 * 1024,
    },
  );

  const remotePath = written.stdout.trim();
  if (!remotePath.startsWith("/") || !remotePath.endsWith(fileName)) {
    throw new Error("Failed to stage the SSH environment file on the remote host.");
  }

  const quotedPath = shellQuote(remotePath);
  return {
    path: remotePath,
    sourceScript: `. ${quotedPath} && rm -f ${quotedPath}`,
    remove: async () => {
      await execFileText(
        "ssh",
        [...input.authArgs, ...portArgs, target, `sh -c ${shellQuote(`rm -f ${quotedPath}`)}`],
        { timeout: 10_000, maxBuffer: 8 * 1024 },
      ).catch(() => undefined);
    },
  };
}

function tarExcludeArgs(exclude: string[] | undefined): string[] {
  const combined = ["._*", ...(exclude ?? [])];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

// Converts a tar `--exclude` pattern into a regexp for the local-size estimate.
// We only need approximate fidelity here (the estimate feeds a clamped percent),
// so we support the literal names and `*`/`?` globs used in practice.
function tarPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Walks `localDir` summing regular-file sizes, mirroring tar's `--exclude`
// handling (plus the implicit `._*`) and `followSymlinks` so the to-ssh upload
// can report an estimated total before tar finishes producing the stream.
async function estimateLocalDirSize(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map(tarPatternToRegExp);
  const isExcluded = (relPath: string, base: string) =>
    regexes.some((regex) => regex.test(relPath) || regex.test(base));

  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = await (input.followSymlinks ? fs.stat(full) : fs.lstat(full)).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(full, entryRelative);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };
  await walk(input.localDir, "");
  return total;
}

// Best-effort remote size probe for the from-ssh restore. `du -sk` is POSIX and
// available on the BSD/Linux remotes we target; it over-counts (block-rounded,
// includes excluded dirs) which keeps the reported percent safely below 100
// until the stream actually closes. Returns null when unavailable so the caller
// falls back to MB-received mode.
async function probeRemoteDirSize(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
}): Promise<number | null> {
  try {
    const result = await runSshScript(
      input.spec,
      `du -sk ${shellQuote(input.remoteDir)} 2>/dev/null | cut -f1`,
      { timeoutMs: 15_000, maxBuffer: 16 * 1024 },
    );
    const kilobytes = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

interface TransferProgress {
  // Backpressure-respecting counter to splice into a transport pipe.
  counter: Transform;
  // Last cumulative byte count observed by the counter.
  transferred: () => number;
  // Emit the terminal completion line. Idempotent.
  finish: () => Promise<void>;
  // Emit a terminal failure marker instead of a completion line. Idempotent.
  fail: () => Promise<void>;
}

// Wraps a throttled progress reporter behind a counting Transform so transports
// can `source.pipe(progress.counter).pipe(dest)`. When `totalBytes` is a known
// exact size (e.g. a git bundle) the reporter emits an exact percentage. When it
// is an estimate (tar upload / remote probe) we clamp the reported bytes to 99%
// of the estimate so an inaccurate total never shows a premature 100%; `finish`
// then emits the terminal 100% (or, in MB-only mode, the final MB) line.
//
// `totalBytes` may be a promise so an expensive size estimate (a local dir walk
// or a remote `du` probe) runs concurrently with the transfer instead of
// blocking the pipe from opening. Until it resolves the counter reports bytes in
// MB-only mode, then adopts the percentage once the total is known; `finish`
// awaits the estimate so the terminal 100% line is still guaranteed.
function createTransferProgress(input: {
  onProgress: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  direction: RuntimeProgressDirection;
  label?: string;
  totalBytes: number | null | Promise<number | null>;
  estimated: boolean;
}): TransferProgress {
  const reporter = createRuntimeProgressReporter({
    sink: input.onProgress,
    phase: input.phase,
    direction: input.direction,
    label: input.label,
    target: "ssh",
  });

  let total: number | null = null;
  let cap: number | null = null;
  const applyTotal = (value: number | null) => {
    total = value != null && value > 0 ? value : null;
    cap = total != null && input.estimated ? Math.floor(total * 0.99) : null;
  };
  const totalReady: Promise<void> =
    input.totalBytes != null && typeof (input.totalBytes as Promise<number | null>).then === "function"
      ? (input.totalBytes as Promise<number | null>).then(applyTotal, () => applyTotal(null))
      : (applyTotal(input.totalBytes as number | null), Promise.resolve());

  let transferred = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch(() => undefined);
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const reported = cap != null ? Math.min(transferred, cap) : transferred;
      const totalSnapshot = total;
      enqueue(() => reporter.report(reported, totalSnapshot));
      callback(null, chunk);
    },
  });

  return {
    counter,
    transferred: () => transferred,
    finish: async () => {
      await chain.catch(() => undefined);
      await totalReady.catch(() => undefined);
      await reporter.complete(total != null ? total : transferred, total).catch(() => undefined);
    },
    fail: async () => {
      await chain.catch(() => undefined);
      await reporter.fail(transferred, total).catch(() => undefined);
    },
  };
}

async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    script,
    options,
  );
}

async function clearLocalDirectory(
  localDir: string,
  preserveEntries: string[] = [],
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const preserve = new Set(preserveEntries);
  const entries = await fs.readdir(localDir);
  await Promise.all(
    entries
      .filter((entry) => !preserve.has(entry))
      .map((entry) => fs.rm(path.join(localDir, entry), { recursive: true, force: true })),
  );
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }));
}

async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      ssh.kill("SIGTERM");
      reject(error);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    if (input.progress) {
      input.progress.counter.on("error", fail);
      source.pipe(input.progress.counter).pipe(ssh.stdin ?? null);
    } else {
      source.pipe(ssh.stdin ?? null);
    }
    ssh.on("close", (code) => {
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = createWriteStream(input.localFile, { mode: 0o600 });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      ssh.kill("SIGTERM");
      sink.destroy();
      reject(error);
    };

    if (input.progress) {
      input.progress.counter.on("error", fail);
      ssh.stdout?.pipe(input.progress.counter).pipe(sink);
    } else {
      ssh.stdout?.pipe(sink);
    }
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    ssh.on("error", fail);
    sink.on("error", fail);
    ssh.on("close", (code) => {
      sink.end(() => {
        if (settled) return;
        settled = true;
        if ((code ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        resolve();
      });
    });
  }).finally(auth.cleanup);
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  // Per-import unique ref so concurrent imports against the same local repo
  // can't race on `update-ref` between this run's update and bundle create.
  const tempRef = `refs/paperclip/ssh-sync/import/${randomUUID()}`;

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
      // Drop the per-import ref on the remote side too so it can't accumulate.
      `git -C ${shellQuote(input.remoteDir)} update-ref -d ${shellQuote(tempRef)} >/dev/null 2>&1 || true`,
    ].join("\n");

    // The git bundle is a real local file of known size, so report an exact
    // percentage. No `workspace` label: the "Importing git history" phase is
    // already self-describing in the log line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Importing git history",
        direction: "to",
        totalBytes: (await fs.stat(bundlePath)).size,
        estimated: false,
      })
      : null;

    try {
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: remoteSetupScript,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  importedRef?: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = input.importedRef ?? `refs/paperclip/ssh-sync/imported/${randomUUID()}`;

  try {
    const exportScript = [
      "set -e",
      `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
      'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
      'trap cleanup EXIT',
      `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" refs/paperclip/ssh-sync/export >/dev/null`,
      'cat "$tmp_bundle"',
    ].join("\n");

    // The remote bundle size isn't known before streaming, so report bytes
    // received (MB mode) with a terminal completion line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Exporting git history",
        direction: "from",
        totalBytes: null,
        estimated: false,
      })
      : null;

    try {
      await streamSshToLocalFile({
        spec: input.spec,
        remoteScript: exportScript,
        localFile: bundlePath,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }

    await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    }
    const importedHead = await runLocalGit(input.localDir, ["rev-parse", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return importedHead.stdout.trim();
  } finally {
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => null);
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent SSH git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for SSH workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip SSH sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent SSH git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  if (process.platform === "darwin" && process.env.PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB !== "1") {
    return {
      supported: false,
      reason: "SSH env-lab fixture is disabled on macOS; set PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1 to opt in.",
    };
  }

  // ssh-agent/ssh-add are required because the fixture config always carries a
  // private key, and key auth now goes through a per-invocation agent (ZIM-2088).
  for (const command of ["ssh", "sshd", "ssh-keygen", "ssh-agent", "ssh-add"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    const envEntries = Object.entries(options.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    for (const [key] of envEntries) {
      if (!isValidShellEnvKey(key)) {
        throw new Error(`Invalid SSH environment variable key: ${key}`);
      }
    }

    // Env values are staged in a 0600 remote file rather than inlined into the
    // remote script, so no value reaches this process's argv (ZIM-2069). This
    // costs one extra ssh connection, but only when env is actually passed.
    const envFile = envEntries.length > 0
      ? await writeRemoteEnvFile({
          config,
          authArgs: auth.args,
          envEntries,
          timeoutMs: options.timeoutMs,
        })
      : null;

    // Mirror buildSshSpawnTarget: source login profiles first, then load the
    // staged env so user-supplied identity overrides win over anything a
    // profile re-exports. Without this, a remote profile that resets HOME
    // / NVM_DIR / etc. would silently undo the explicit env passed in here.
    const remoteScript = [
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      ...(envFile ? [envFile.sourceScript] : []),
      `exec sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -c ${shellQuote(remoteScript)}`,
    );

    try {
      return options.stdin != null
        ? await spawnText("ssh", sshArgs, {
            stdin: options.stdin,
            timeout: options.timeoutMs ?? 15_000,
            maxBuffer: options.maxBuffer ?? 1024 * 128,
          })
        : await execFileText("ssh", sshArgs, {
            timeout: options.timeoutMs ?? 15_000,
            maxBuffer: options.maxBuffer ?? 1024 * 128,
          });
    } catch (error) {
      // The remote script deletes the env file as soon as it sources it, so a
      // leftover only exists when the command never got that far.
      await envFile?.remove();
      throw error;
    }
  } finally {
    await cleanup();
  }
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
}> {
  for (const key of Object.keys(input.env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  const envEntries = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");

  // This target is a long-lived process whose stdin carries the agent protocol
  // stream, so env cannot be fed over stdin here. Stage it in a 0600 remote
  // file instead — the values never enter argv (ZIM-2069).
  const envFile = envEntries.length > 0
    ? await writeRemoteEnvFile({ config: input.spec, authArgs: auth.args, envEntries })
    : null;

  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  const remoteScript = [
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    ...(envFile ? [envFile.sourceScript] : []),
    `exec ${remoteCommandParts}`,
  ].join(" && ");

  sshArgs.push(
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteScript)}`,
  );

  return {
    command: "ssh",
    args: sshArgs,
    cleanup: async () => {
      // Runs after the remote process exits. The remote script already removed
      // the file when it sourced it; this covers the never-connected case.
      // Remove before dropping the temp key/known-hosts files it needs.
      await envFile?.remove();
      await auth.cleanup();
    },
  };
}

export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  // tar's archive size isn't known until tar finishes, so estimate it from the
  // local file sizes and clamp the reported percent to 99% until the pipe closes.
  // The estimate walk runs concurrently with the transfer so it never delays the
  // pipe from opening on large workspaces.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Syncing",
      direction: "to",
      label: input.progressLabel,
      totalBytes: estimateLocalDirSize({
        localDir: input.localDir,
        exclude: input.exclude,
        followSymlinks: input.followSymlinks,
      }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude),
      "-cf",
      "-",
      ".",
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if ((tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.kill("SIGTERM");
      ssh.kill("SIGTERM");
      reject(error);
    };

    if (progress) {
      progress.counter.on("error", fail);
      tar.stdout?.pipe(progress.counter).pipe(ssh.stdin ?? null);
    } else {
      tar.stdout?.pipe(ssh.stdin ?? null);
    }
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      maybeFinish();
    });
    }).finally(auth.cleanup);
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  }
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  // The remote archive below is built with `tar -cf - .`, so it carries a "./"
  // member whose mode tar restores onto the extraction target — resetting this
  // 0700 mkdtemp directory to the remote workspace's mode (typically 0755) and
  // leaving the whole restored checkout world-readable under /tmp for the rest
  // of the restore. Extract one level down instead: the 0700 root denies
  // traversal to every other uid regardless of what tar does to the directory
  // it extracts into, and that holds for GNU tar, bsdtar and busybox tar alike.
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const stagingDir = path.join(stagingRoot, "workspace");
  await fs.mkdir(stagingDir, { mode: 0o700 });
  const remoteTarScript = [
    `cd ${shellQuote(input.remoteDir)}`,
    `tar ${[...tarExcludeArgs(input.exclude).map(shellQuote), "-cf", "-", "."].join(" ")}`,
  ].join(" && ");
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteTarScript)}`,
  ];

  // The remote tar size isn't known locally, so probe the remote directory for
  // an estimate (clamped to 99%). The probe runs concurrently with the transfer
  // so its round-trip never delays the restore; when it is unavailable we report
  // bytes received in MB mode with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: probeRemoteDirSize({ spec: input.spec, remoteDir: input.remoteDir }),
      estimated: true,
    })
    : null;

  try {
    try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if ((sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        tar.kill("SIGTERM");
        reject(error);
      };

      if (progress) {
        progress.counter.on("error", fail);
        ssh.stdout?.pipe(progress.counter).pipe(tar.stdin ?? null);
      } else {
        ssh.stdout?.pipe(tar.stdin ?? null);
      }
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        maybeFinish();
      });
    });
    } finally {
      // Second line of defence behind the staging root: re-tighten the
      // directory tar just extracted into, on the failure path too, since a
      // partial extraction leaves the same widened directory behind. Only the
      // directory itself — the extracted contents keep their remote modes,
      // which the merge into localDir still needs.
      await fs.chmod(stagingDir, 0o700).catch(() => undefined);
    }
    await progress?.finish();

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}

export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  onProgress?: RuntimeProgressSink;
}): Promise<{ gitBacked: boolean }> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await importGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
      onProgress: input.onProgress,
    });
    await syncDirectoryToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      exclude: [".git", ".paperclip-runtime"],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    await removeDeletedPathsOnSsh({
      spec: input.spec,
      remoteDir,
      deletedPaths: gitSnapshot.deletedPaths,
    });
    return { gitBacked: true };
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [".paperclip-runtime"],
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
  return { gitBacked: false };
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  if (input.baselineSnapshot) {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const importedRef = input.restoreGitHistory
      ? `refs/paperclip/ssh-sync/imported/${randomUUID()}`
      : null;
    try {
      const importedHead = input.restoreGitHistory
        ? await exportGitWorkspaceFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          importedRef: importedRef ?? undefined,
          resetLocalWorkspace: false,
          onProgress: input.onProgress,
        })
        : null;
      await syncDirectoryFromSsh({
        spec: input.spec,
        remoteDir,
        localDir: stagingDir,
        exclude: input.baselineSnapshot.exclude,
        onProgress: input.onProgress,
        progressLabel: "workspace",
      });
      await mergeDirectoryWithBaseline({
        baseline: input.baselineSnapshot,
        sourceDir: stagingDir,
        targetDir: input.localDir,
        // Git history advances via integrateImportedGitHead; the working tree
        // still comes from the remote file snapshot so dirty remote edits win.
        beforeApply: importedHead
          ? async () => {
            await integrateImportedGitHead({
              localDir: input.localDir,
              importedHead,
            });
          }
          : undefined,
      });
    } finally {
      if (importedRef) {
        await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      onProgress: input.onProgress,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      exclude: [".git", ".paperclip-runtime"],
      preserveLocalEntries: [".git"],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime"],
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    return raw;
  } catch {
    return null;
  }
}

export async function stopSshEnvLabFixture(statePath: string): Promise<boolean> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) return false;

  if (await isSshEnvLabFixtureProcess(state)) {
    process.kill(state.pid, "SIGTERM");
    await waitForCondition(async () => {
      if (await isSshEnvLabFixtureProcess(state)) {
        throw new Error("SSH fixture process is still running.");
      }
    }, { timeoutMs: 5_000, intervalMs: 100 });
  }

  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
}): Promise<SshEnvLabFixtureState> {
  const existing = await readSshEnvLabFixtureState(input.statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(input.statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath: input.statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: 10_000, intervalMs: 250 });
    await fs.writeFile(input.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    if (await isPidRunning(state.pid)) {
      process.kill(state.pid, "SIGTERM");
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

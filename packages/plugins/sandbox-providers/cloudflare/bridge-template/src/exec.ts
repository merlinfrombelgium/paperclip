import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { shellQuote } from "./helpers.js";
import { isTimeoutError } from "./sandboxes.js";
import { cleanupTimedOutExecution, resolveExecutionTarget, type SessionStrategy } from "./sessions.js";

export interface BridgeExecuteParams {
  sandbox: CloudflareSandbox;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  sessionStrategy: SessionStrategy;
  sessionId?: string;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid.replace(/[^a-zA-Z0-9-]/g, "");
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Env delivery for bridge execs.
 *
 * Values must never be interpolated into the script. The script is passed to
 * the sandbox's `exec()` as a command string, so it becomes the container
 * process's argv — readable out of `/proc/<pid>/cmdline` by anything already
 * running in that sandbox (ZIM-2085). Instead the values are written to a file
 * inside a 0700 directory via `sandbox.writeFile` and the script sources that
 * file and deletes it; only the non-secret path appears in argv.
 *
 * This mirrors `writeRemoteEnvFile` in `packages/adapter-utils/src/ssh.ts`
 * (ZIM-2082). Residual risk, accepted: the file is readable by the sandbox user
 * itself for the life of the command.
 */
export function selectEnvEntries(env: Record<string, string> | undefined): Array<[string, string]> {
  const entries = env ?? {};
  for (const key of Object.keys(entries)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  return Object.entries(entries).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

/** The bytes written into the sandbox. The only place a value appears. */
export function buildEnvFilePayload(entries: Array<[string, string]>): string {
  return `${entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n")}\n`;
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  envFileDir?: string | null;
  stdinFile?: string | null;
}): string {
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const stdinRedirect = input.stdinFile ? ` < ${shellQuote(input.stdinFile)}` : "";
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  // Sourced after profile init so the caller's env still wins over anything the
  // profile exports, and the whole staging directory is removed immediately so
  // it does not outlive the command.
  if (input.envFileDir) {
    lines.push(
      `. ${shellQuote(`${input.envFileDir}/env`)} && rm -rf ${shellQuote(input.envFileDir)}`,
    );
  }
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(`exec ${commandParts}${stdinRedirect}`);
  return lines.join(" && ");
}

function coerceExecuteResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  return {
    exitCode:
      typeof result.exitCode === "number" || result.exitCode === null
        ? result.exitCode
        : result.success === false
          ? 1
          : 0,
    signal: null,
    timedOut: false,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function executeInSandbox(params: BridgeExecuteParams) {
  // The @cloudflare/sandbox SDK's exec() takes a single command string and a
  // narrow option set ({ cwd, env, timeout, ... }) — it does not accept `args`
  // or `stdin`. We compose the full shell command ourselves and stage stdin
  // through a temp file in the sandbox when the caller provides one.
  const stdinPayload = typeof params.stdin === "string" && params.stdin.length > 0
    ? params.stdin
    : null;
  const stdinFile = stdinPayload ? `/tmp/.paperclip-bridge-stdin-${randomToken()}` : null;

  if (stdinFile && stdinPayload) {
    await params.sandbox.writeFile(stdinFile, stdinPayload, { encoding: "utf8" });
  }

  // Key validation happens before anything is staged so an invalid key still
  // fails the call rather than leaving an orphaned env file behind.
  const envEntries = selectEnvEntries(params.env);
  const envFileDir = envEntries.length > 0 ? `/tmp/.paperclip-bridge-env-${randomToken()}` : null;
  const envFilePath = envFileDir ? `${envFileDir}/env` : null;

  if (envFileDir && envFilePath) {
    // `writeFile` creates intermediate directories but gives no control over
    // their mode, so tighten the directory before the value lands inside it.
    const stageDir = `umask 077 && mkdir -p ${shellQuote(envFileDir)} && chmod 700 ${shellQuote(envFileDir)}`;
    await params.sandbox.exec(`sh -c ${shellQuote(stageDir)}`);
    await params.sandbox.writeFile(envFilePath, buildEnvFilePayload(envEntries), { encoding: "utf8" });
  }

  // The script removes the staging directory itself once it reaches the source
  // line; the finally-block cleanup is only for the case where the command
  // never got that far.
  let sourced = false;

  try {
    const target = await resolveExecutionTarget(params.sandbox, {
      sessionStrategy: params.sessionStrategy,
      sessionId: params.sessionId,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      envFileDir,
      stdinFile,
    });
    const fullCommand = `sh -lc ${shellQuote(script)}`;
    const result = await target.exec(fullCommand, {
      cwd: "/",
      timeout: params.timeoutMs,
      ...(typeof params.onOutput === "function"
        ? {
            stream: true,
            onOutput: params.onOutput,
          }
        : {}),
    });
    sourced = true;
    return coerceExecuteResult(result);
  } catch (error) {
    if (isTimeoutError(error)) {
      await cleanupTimedOutExecution(params.sandbox, {
        sessionStrategy: params.sessionStrategy,
        sessionId: params.sessionId,
      });
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinFile) {
      await params.sandbox.deleteFile?.(stdinFile).catch(() => undefined);
    }
    if (envFileDir && !sourced) {
      await Promise.resolve(params.sandbox.exec(`sh -c ${shellQuote(`rm -rf ${shellQuote(envFileDir)}`)}`))
        .catch(() => undefined);
    }
  }
}

/**
 * Env delivery for in-pod execs, kept free of any `@kubernetes/client-node`
 * import so the command-shape logic stays unit testable on its own.
 *
 * The Kubernetes exec API has no env field, so the only way to give an exec'd
 * process extra env is through the shell it runs under. The obvious form —
 * `/bin/sh -c "export K=v; exec …"` — puts every value in the command string,
 * which then (a) becomes the pod process's argv, readable out of
 * `/proc/<pid>/cmdline` by anything already running in that sandbox, and (b)
 * transits the exec API, landing in kube-apiserver audit logs when exec
 * auditing is on (ZIM-2085).
 *
 * Instead the values are streamed over the exec channel's stdin into a 0600
 * file inside the pod, and the real command only ever carries that file's
 * path. This mirrors `writeRemoteEnvFile` in `packages/adapter-utils/src/ssh.ts`
 * (ZIM-2082).
 *
 * Residual risk, accepted: the file is readable by anything running as the
 * sandbox user for the life of the command. That is inherent to handing the
 * process the env at all; the gain is keeping values out of provider logs and
 * out of sibling-process argv.
 */

import { randomUUID } from "node:crypto";

// Single-quote a string for safe interpolation into a sh -c script. Wraps in
// '...' and escapes any embedded single quotes via '\'' (close, escape, reopen).
export function shQuote(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

/**
 * The env entries actually worth delivering. PATH is deliberately skipped (the
 * caller's PATH is the orchestrator's, not the sandbox image's, and overriding
 * it would break command resolution), and only valid shell identifiers pass.
 */
export function selectExecEnvEntries(
  env: Record<string, string> | undefined | null,
): Array<[string, string]> {
  return Object.entries(env && typeof env === "object" ? env : {}).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string"
      && entry[0] !== "PATH"
      && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]),
  );
}

/** Absolute in-pod path for a staged env file. Non-secret; safe in argv. */
export function buildEnvFilePath(): string {
  return `/tmp/paperclip-env-${randomUUID()}`;
}

/**
 * The bytes streamed over stdin into the staged file. This is the ONLY place a
 * value appears, and it never becomes part of any command string.
 */
export function buildEnvFilePayload(entries: Array<[string, string]>): string {
  return `${entries.map(([key, value]) => `export ${key}=${shQuote(value)}`).join("\n")}\n`;
}

/**
 * Command for the staging exec. `umask 077` precedes the redirect so the file
 * is never briefly world readable; the explicit `chmod` covers shells that
 * ignore umask on an existing inode. Run with the payload as stdin — execInPod
 * bounds it with `head -c <N>`, so the bytes arrive over the WebSocket data
 * channel rather than in argv.
 */
export function buildEnvFileStagingCommand(envFilePath: string): string[] {
  const quoted = shQuote(envFilePath);
  return ["/bin/sh", "-c", `umask 077 && cat > ${quoted} && chmod 600 ${quoted}`];
}

/** Best-effort cleanup for the case where the consuming exec never ran. */
export function buildEnvFileRemovalCommand(envFilePath: string): string[] {
  return ["/bin/sh", "-c", `rm -f ${shQuote(envFilePath)}`];
}

/**
 * Wrap a command so it sources the staged env file, deletes it, then `exec`s
 * the real command. Returns the command unchanged when there is nothing staged.
 *
 * The `&&` chain is deliberate: if the file went missing, fail loudly instead
 * of silently running the command without the env it was promised.
 */
export function wrapCommandWithEnvFile(
  command: string[],
  envFilePath: string | null,
): string[] {
  if (!envFilePath) return command;
  const quoted = shQuote(envFilePath);
  return [
    "/bin/sh",
    "-c",
    `. ${quoted} && rm -f ${quoted} && exec ${command.map(shQuote).join(" ")}`,
  ];
}

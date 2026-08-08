import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { registerSecretValueSource, registerSecretValues } from "@paperclipai/adapter-utils";

import { resolveDefaultSecretsKeyFilePath, resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Host-side sources for value-based redaction (ZIM-2174).
 *
 * The redactor's candidate set is only as good as what it knows to be secret, and
 * the material most worth keeping out of a log is exactly the material this
 * instance stores on disk. Reading it in means an emission with no anchoring
 * syntax at all — a value under a file header, a value echoed inside a fenced
 * block — is covered without anyone having to predict the framing first.
 *
 * These sources are polled, not snapshotted: the registry calls them on its own
 * TTL, so a secret written mid-run is picked up without a restart.
 */

/** Key material is small; anything larger is a data file, not a credential. */
const MAX_SECRET_FILE_BYTES = 4096;
/** Bound on how much of the secrets directory a single rebuild will read. */
const MAX_SECRET_FILES = 32;

function resolveMasterKeyFilePath(): string {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return resolveDefaultSecretsKeyFilePath();
}

function resolveSecretsDir(): string {
  const masterKeyPath = resolveMasterKeyFilePath();
  if (masterKeyPath) return path.dirname(masterKeyPath);
  return path.resolve(resolvePaperclipInstanceRoot(), "secrets");
}

function readSecretFileValues(filePath: string): string[] {
  let contents: string;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_SECRET_FILE_BYTES) return [];
    contents = readFileSync(filePath, "utf8");
  } catch {
    // Unreadable or absent: contribute nothing rather than failing the rebuild.
    return [];
  }

  const values = [contents.trim()];
  // A key file is a single line, but a secrets directory can hold multi-entry
  // files too; admitting each line costs nothing and the candidate gate discards
  // comments and prose (both carry whitespace).
  if (contents.includes("\n")) {
    for (const line of contents.split(/\r?\n/)) values.push(line.trim());
  }
  return values.filter(Boolean);
}

function* instanceSecretFileValues(): Iterable<string> {
  const secretsDir = resolveSecretsDir();
  let entries: string[];
  try {
    entries = readdirSync(secretsDir);
  } catch {
    // No secrets directory on this host (fresh install, or a provider-backed
    // deployment): the env and pinned sources still apply.
    return;
  }

  let read = 0;
  for (const entry of entries) {
    if (read >= MAX_SECRET_FILES) break;
    read += 1;
    yield* readSecretFileValues(path.join(secretsDir, entry));
  }
}

/**
 * Pin a secret value the server resolved for a run. Binding values live only in
 * flight — no source can poll for them — so the resolver hands them over here as
 * it produces them.
 */
export function registerResolvedSecretValue(value: string): void {
  if (!value) return;
  registerSecretValues([value]);
}

/** Idempotent — the registry keys sources by identity — so any redacting module may call it. */
export function installKnownSecretValueSources(): void {
  registerSecretValueSource(instanceSecretFileValues);
}

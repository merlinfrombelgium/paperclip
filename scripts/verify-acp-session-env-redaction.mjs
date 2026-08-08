#!/usr/bin/env node
// Gate for ZIM-2118 / ZIM-2113: assert that ACP per-session records carry no
// secret-valued env under `acpx.session_options.env`.
//
// The ACP engine persists the agent environment block into per-session JSON so
// that acpx can respawn the agent on a cold turn (acpx reads the stored env back
// via `sessionOptionsFromRecord` -> `buildAgentSpawnOptions`). That makes the
// stored env load-bearing, so "is it redacted?" cannot be answered by reading
// the code alone -- it has to be checked against files on disk after a real run.
//
// Usage:
//   node scripts/verify-acp-session-env-redaction.mjs [options]
//
//   --root <dir>        ACP engine agents dir. Defaults to the local instance.
//   --since <ISO|@file> Only check records written at/after this time. This is
//                       the AC#2 form: trigger a fresh session, then check only
//                       what that run wrote. `@file` reads the file's mtime.
//   --self-test         Positive control: run the detector over a synthetic
//                       record that DOES contain secrets and fail if it comes
//                       back clean. A zero from a detector that cannot fire is
//                       worthless; run this before trusting a pass.
//   --json              Emit machine-readable JSON instead of text.
//
// Exit codes: 0 clean, 1 secrets found, 2 bad usage / nothing checked.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Names the ZIM-2118 acceptance criteria call out by hand, plus the generic
// shapes. Kept explicit so a rename upstream shows up as a miss, not a silent pass.
const NAMED_SECRETS = [
  "GH_TOKEN",
  "AZURE_FOUNDRY_API_KEY",
  "ZIMI_DATABASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "PAPERCLIP_API_KEY",
];

// Secure-by-default: anything not matched here is treated as potentially secret
// when its value also looks secret. This is an allowlist of names known to carry
// non-sensitive values (ids, paths, modes, urls without credentials).
const NON_SECRET_NAMES = new Set([
  "AGENT_HOME",
  "CODEX_HOME",
  "CODEX_CONFIG",
  "ANTHROPIC_MODEL",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_ISSUE_WORK_MODE",
  "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_RUN_SCRATCH_DIR",
  "PAPERCLIP_SCRATCH_DIR",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_TASK_SCRATCH_DIR",
  "PAPERCLIP_TMPDIR",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|_KEY|APIKEY|SESSION_ID)$/i;
// A redacted value is fine; these are the markers the run-log redactor emits.
const REDACTED_RE = /^(\*{3}REDACTED\*{3}|\[REDACTED\]|<redacted>|REDACTED)$/i;

function looksSecretValue(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || REDACTED_RE.test(v)) return false;
  if (/^(true|false|null|\d+)$/i.test(v)) return false;
  // A connection string with an inline credential.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)) return true;
  if (/^(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abprs]-|AKIA)/.test(v)) return true;
  // JWT.
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
  // Long opaque high-entropy blob.
  if (v.length >= 24 && /^[A-Za-z0-9_\-+/=.]+$/.test(v) && !v.includes(" ")) return true;
  return false;
}

// PAPERCLIP_API_KEY is a short-TTL JWT. An expired one is not a live credential,
// so report it separately rather than letting ~1000 dead tokens bury the signal.
function jwtExpiry(value) {
  if (typeof value !== "string" || value.split(".").length !== 3) return null;
  try {
    const raw = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

function inspectRecord(env, nowSec) {
  const findings = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (REDACTED_RE.test(value.trim())) continue;
    const named = NAMED_SECRETS.includes(name);
    const suspicious = named || SECRET_NAME_RE.test(name) || !NON_SECRET_NAMES.has(name);
    if (!suspicious) continue;
    if (!named && !looksSecretValue(value)) continue;
    const exp = jwtExpiry(value);
    findings.push({
      name,
      kind: named ? "named" : "heuristic",
      // Never emit the value itself -- this script runs in agent logs.
      bytes: value.length,
      expired: exp === null ? null : exp <= nowSec,
    });
  }
  return findings;
}

function defaultRoot() {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instance = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  const companies = path.join(home, "instances", instance, "companies");
  if (!fs.existsSync(companies)) return null;
  for (const company of fs.readdirSync(companies)) {
    const agents = path.join(companies, company, "acp-engine", "agents");
    if (fs.existsSync(agents)) return agents;
  }
  return null;
}

function* sessionFiles(root) {
  for (const agent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const dir = path.join(root, agent.name, "sessions");
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".json")) yield path.join(dir, entry);
    }
  }
}

function parseArgs(argv) {
  const opts = { root: null, since: null, selfTest: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--json") opts.json = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function resolveSince(since) {
  if (!since) return null;
  if (since.startsWith("@")) {
    const target = since.slice(1);
    if (!fs.existsSync(target)) {
      console.error(`--since @${target} does not exist`);
      process.exit(2);
    }
    return fs.statSync(target).mtimeMs;
  }
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) {
    console.error(`--since must be an ISO timestamp or @file, got: ${since}`);
    process.exit(2);
  }
  return ms;
}

// Positive control. A detector that cannot fire makes a clean run meaningless,
// so prove it fires on a known-bad record before trusting any zero.
function selfTest() {
  const nowSec = Math.floor(Date.now() / 1000);
  const bad = {
    PAPERCLIP_AGENT_ID: "1151084d-c064-460d-9750-a50886255508",
    TMPDIR: "/tmp",
    GH_TOKEN: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
    ZIMI_DATABASE_URL: "postgresql://user:hunter2@db.internal:5432/zimi",
  };
  const good = { PAPERCLIP_AGENT_ID: "abc", TMPDIR: "/tmp", GH_TOKEN: "***REDACTED***" };
  const hits = inspectRecord(bad, nowSec).map((f) => f.name).sort();
  const clean = inspectRecord(good, nowSec);
  const expected = ["GH_TOKEN", "ZIMI_DATABASE_URL"];
  const ok = expected.every((n) => hits.includes(n)) && clean.length === 0;
  console.log(`positive control: detector fired on ${hits.join(", ") || "(nothing)"}`);
  console.log(`negative control: redacted record produced ${clean.length} finding(s)`);
  console.log(ok ? "SELF-TEST PASS" : "SELF-TEST FAIL");
  return ok ? 0 : 1;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) process.exit(selfTest());

  const root = opts.root ?? defaultRoot();
  if (!root || !fs.existsSync(root)) {
    console.error("Could not locate the ACP engine agents directory; pass --root.");
    process.exit(2);
  }
  const sinceMs = resolveSince(opts.since);
  const nowSec = Math.floor(Date.now() / 1000);

  let checked = 0;
  let skipped = 0;
  const offenders = [];
  const byName = new Map();

  for (const file of sessionFiles(root)) {
    if (sinceMs !== null && fs.statSync(file).mtimeMs < sinceMs) {
      skipped += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    checked += 1;
    const env = record?.acpx?.session_options?.env;
    if (!env || typeof env !== "object") continue;
    const findings = inspectRecord(env, nowSec);
    if (findings.length === 0) continue;
    offenders.push({ file, closed: Boolean(record.closed), findings });
    for (const f of findings) {
      const cur = byName.get(f.name) ?? { total: 0, live: 0 };
      cur.total += 1;
      if (f.expired !== true) cur.live += 1;
      byName.set(f.name, cur);
    }
  }

  // A run that checked nothing is not a pass.
  if (checked === 0) {
    console.error(`No session records checked under ${root}${sinceMs !== null ? " matching --since" : ""}.`);
    process.exit(2);
  }

  const live = offenders.filter((o) => o.findings.some((f) => f.expired !== true));
  if (opts.json) {
    console.log(JSON.stringify({
      root, checked, skipped,
      offendingFiles: offenders.length,
      filesWithLiveSecret: live.length,
      byName: Object.fromEntries(byName),
    }, null, 2));
  } else {
    console.log(`root:    ${root}`);
    console.log(`checked: ${checked} record(s)${skipped ? `, skipped ${skipped} older than --since` : ""}`);
    if (offenders.length === 0) {
      console.log("PASS: no secret-valued env under acpx.session_options.env");
    } else {
      console.log(`FAIL: ${offenders.length} record(s) carry secret-valued env (${live.length} with a non-expired value)`);
      for (const [name, counts] of [...byName].sort((a, b) => b[1].total - a[1].total)) {
        console.log(`  ${name}: ${counts.total} record(s), ${counts.live} live`);
      }
    }
  }
  process.exit(offenders.length === 0 ? 0 : 1);
}

main();

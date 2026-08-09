#!/usr/bin/env node
// Compares the paperclipai version installed on the host against the fork's
// known security fixes, and flags fixes the host cannot possibly have yet.
//
// This script does not reach the host itself (no SSH, no privileged access).
// The host version/commit must be supplied by whoever is running it (an
// operator or agent with a sanctioned read-only path to the host). See
// ZIM-2150 for why: the fork and the upstream-published `paperclipai`
// package are different repos, and merging to the fork's master does not
// ship anything (ZIM-2110).
//
// Usage:
//   node scripts/fork-host-drift-check.mjs --host-version 2026.807.0-canary.7
//   node scripts/fork-host-drift-check.mjs --host-version 2026.807.0-canary.7 --post
//
// `--post` requires PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and
// FORK_HOST_DRIFT_ISSUE_ID (or PAPERCLIP_TASK_ID) in the environment, and
// posts the human-readable report as an issue comment.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = join(__dirname, "fork-host-drift-fixes.json");

const VERSION_PATTERN = /^(\d{4})\.(\d{3,4})\.(\d+)(?:-canary\.(\d+))?$/;

export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) {
    throw new Error(`Unrecognized paperclipai version format: ${version}`);
  }
  const [, yearStr, mdd, patchStr, canaryBuildStr] = match;
  const year = Number(yearStr);
  const month = Number(mdd.slice(0, -2));
  const day = Number(mdd.slice(-2));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unrecognized paperclipai version date: ${version}`);
  }
  return {
    raw: version,
    year,
    month,
    day,
    patch: Number(patchStr),
    canaryBuild: canaryBuildStr === undefined ? null : Number(canaryBuildStr),
    date,
  };
}

export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

// A fix can only be on the host once it has been contributed upstream
// (ZIM-2148) AND the host has installed a build published on or after that.
// While upstreamMergedAt is null, the fix exists only in the fork and the
// host cannot have it, full stop.
export function evaluateFix(fix, hostDate) {
  if (!fix.upstreamMergedAt) {
    return {
      issueId: fix.issueId,
      title: fix.title,
      drift: true,
      reason: "fork-only fix, not yet contributed upstream (see ZIM-2148)",
    };
  }
  const upstreamDate = new Date(`${fix.upstreamMergedAt}T00:00:00Z`);
  const drift = hostDate < upstreamDate;
  return {
    issueId: fix.issueId,
    title: fix.title,
    drift,
    reason: drift
      ? `upstream merge (${fix.upstreamMergedAt}) postdates installed host build`
      : `host build postdates upstream merge (${fix.upstreamMergedAt})`,
  };
}

export function buildReport(hostVersionString, manifest = loadManifest()) {
  const hostVersion = parseVersion(hostVersionString);
  const results = manifest.map((fix) => evaluateFix(fix, hostVersion.date));
  const drifted = results.filter((r) => r.drift);
  return { hostVersion, results, drifted };
}

export function formatReport(report) {
  const { hostVersion, results, drifted } = report;
  const lines = [];
  lines.push(`Fork-to-host drift check — host paperclipai ${hostVersion.raw} (built ${hostVersion.date.toISOString().slice(0, 10)})`);
  if (drifted.length === 0) {
    lines.push("No drift: every tracked fix is either absent from the fork or already reachable on the host.");
  } else {
    lines.push(`${drifted.length} tracked fix(es) merged into the fork but not yet verified on the host:`);
    for (const r of drifted) {
      lines.push(`- ${r.issueId} — ${r.title} (${r.reason})`);
    }
  }
  const clean = results.filter((r) => !r.drift);
  if (clean.length > 0) {
    lines.push("Resolved (host build reaches these):");
    for (const r of clean) {
      lines.push(`- ${r.issueId} — ${r.title}`);
    }
  }
  return lines.join("\n");
}

async function postComment(body) {
  const apiBase = (process.env.PAPERCLIP_API_URL || "").replace(/\/$/, "").replace(/\/api$/, "");
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const issueId = process.env.FORK_HOST_DRIFT_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
  if (!apiBase || !apiKey || !issueId) {
    throw new Error("--post requires PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and FORK_HOST_DRIFT_ISSUE_ID/PAPERCLIP_TASK_ID");
  }
  const res = await fetch(`${apiBase}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post drift report comment: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const hostVersionIndex = args.indexOf("--host-version");
  const hostVersion = hostVersionIndex >= 0 ? args[hostVersionIndex + 1] : process.env.HOST_PAPERCLIPAI_VERSION;
  const shouldPost = args.includes("--post");

  if (!hostVersion) {
    console.error("Missing host version. Pass --host-version <ver> or set HOST_PAPERCLIPAI_VERSION.");
    process.exitCode = 2;
    return;
  }

  const report = buildReport(hostVersion);
  const text = formatReport(report);
  console.log(text);

  if (shouldPost) {
    await postComment(text);
  }

  process.exitCode = report.drifted.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

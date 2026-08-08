import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVersion,
  evaluateFix,
  buildReport,
  formatReport,
} from "./fork-host-drift-check.mjs";

test("parseVersion reads stable and canary version strings", () => {
  const canary = parseVersion("2026.807.0-canary.7");
  assert.equal(canary.year, 2026);
  assert.equal(canary.month, 8);
  assert.equal(canary.day, 7);
  assert.equal(canary.patch, 0);
  assert.equal(canary.canaryBuild, 7);
  assert.equal(canary.date.toISOString().slice(0, 10), "2026-08-07");

  const stable = parseVersion("2026.1203.1");
  assert.equal(stable.month, 12);
  assert.equal(stable.day, 3);
  assert.equal(stable.canaryBuild, null);
});

test("parseVersion rejects unrecognized formats", () => {
  assert.throws(() => parseVersion("not-a-version"));
});

test("evaluateFix flags a fork-only fix as drift regardless of host date", () => {
  const fix = { issueId: "ZIM-9999", title: "x", upstreamMergedAt: null };
  const result = evaluateFix(fix, new Date("2099-01-01T00:00:00Z"));
  assert.equal(result.drift, true);
  assert.match(result.reason, /not yet contributed upstream/);
});

test("evaluateFix clears once the host build postdates the upstream merge", () => {
  const fix = { issueId: "ZIM-9999", title: "x", upstreamMergedAt: "2026-08-10" };
  assert.equal(evaluateFix(fix, new Date("2026-08-09T00:00:00Z")).drift, true);
  assert.equal(evaluateFix(fix, new Date("2026-08-10T00:00:00Z")).drift, false);
  assert.equal(evaluateFix(fix, new Date("2026-08-11T00:00:00Z")).drift, false);
});

test("buildReport flags all fork-only manifest entries against a same-day host build", () => {
  const manifest = [
    { issueId: "ZIM-2082", title: "a", upstreamMergedAt: null },
    { issueId: "ZIM-2087", title: "b", upstreamMergedAt: null },
    { issueId: "ZIM-2090", title: "c", upstreamMergedAt: null },
  ];
  const report = buildReport("2026.807.0-canary.7", manifest);
  assert.equal(report.drifted.length, 3);
  assert.deepEqual(
    report.drifted.map((r) => r.issueId),
    ["ZIM-2082", "ZIM-2087", "ZIM-2090"],
  );
});

test("buildReport clears an entry once upstreamMergedAt predates the host build", () => {
  const manifest = [
    { issueId: "ZIM-1000", title: "shipped", upstreamMergedAt: "2026-08-01" },
    { issueId: "ZIM-2000", title: "pending", upstreamMergedAt: null },
  ];
  const report = buildReport("2026.807.0-canary.7", manifest);
  assert.equal(report.drifted.length, 1);
  assert.equal(report.drifted[0].issueId, "ZIM-2000");
});

test("formatReport renders drifted and clean sections", () => {
  const manifest = [
    { issueId: "ZIM-1000", title: "shipped", upstreamMergedAt: "2026-08-01" },
    { issueId: "ZIM-2000", title: "pending", upstreamMergedAt: null },
  ];
  const report = buildReport("2026.807.0-canary.7", manifest);
  const text = formatReport(report);
  assert.match(text, /1 tracked fix\(es\)/);
  assert.match(text, /ZIM-2000/);
  assert.match(text, /Resolved/);
  assert.match(text, /ZIM-1000/);
});

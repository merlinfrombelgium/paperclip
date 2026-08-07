import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOurSshAgentProcess } from "./ssh.js";

/**
 * Guard on the SIGKILL fallback that reaps a per-invocation ssh-agent.
 *
 * The agent pid is registered for an emergency kill and the run holding that
 * registration lives for hours, so the pid can be recycled onto an unrelated
 * process before the kill fires — and on a Paperclip host every agent shares
 * one uid, so `process.kill` would succeed against whatever now owns it. The
 * pid alone is therefore not sufficient authority to SIGKILL; the pid paired
 * with our own per-invocation socket path is.
 */

const REQUIRE_GATE_ENV = "PAPERCLIP_REQUIRE_SSH_GATE";

function skipOrFail(reason: string): void {
  if (process.env[REQUIRE_GATE_ENV] === "1") {
    expect.fail(`${REQUIRE_GATE_ENV}=1, but the gate could not run: ${reason}`);
  }
  console.warn(`Skipping: ${reason}`);
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile("which", [command], (error) => resolve(!error));
  });
}

/** `SSH_AGENT_PID=12345; export SSH_AGENT_PID;` out of ssh-agent's preamble. */
function parsePid(stdout: string): number | null {
  const match = stdout.match(/SSH_AGENT_PID=(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

describe("ssh-agent pid guard", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("only claims a pid that is really our agent for that socket", async () => {
    if (!(await commandExists("ssh-agent"))) {
      skipOrFail("ssh-agent not on PATH");
      return;
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), "zim2090-pidguard-"));
    cleanups.push(async () => await rm(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, "s");

    const started = await new Promise<string>((resolve, reject) => {
      execFile("ssh-agent", ["-a", socketPath], { timeout: 5_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const agentPid = parsePid(started);
    expect(agentPid, "ssh-agent did not report SSH_AGENT_PID").not.toBeNull();
    cleanups.push(() => {
      try {
        process.kill(agentPid!, "SIGKILL");
      } catch {
        // Already reaped by the assertions below.
      }
    });

    // Our agent, our socket: the one case where the SIGKILL is authorised.
    expect(isOurSshAgentProcess(agentPid!, socketPath)).toBe(true);

    // Right pid, but a socket path that is not the one we started it for —
    // which is what a recycled pid that happens to be some other ssh-agent
    // looks like. Another run's agent must not be collateral.
    expect(isOurSshAgentProcess(agentPid!, path.join(dir, "not-our-socket"))).toBe(false);

    // A live process that is not an ssh-agent at all: the recycled-pid case.
    // `sleep` stands in for whatever unrelated thing inherited the number.
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => bystander.kill("SIGKILL"));
    expect(bystander.pid).toBeGreaterThan(0);
    expect(isOurSshAgentProcess(bystander.pid!, socketPath)).toBe(false);

    // The test runner itself — a pid that is definitely alive and definitely
    // not ours to kill.
    expect(isOurSshAgentProcess(process.pid, socketPath)).toBe(false);

    // Once the agent is gone the pid stops being claimable, so a later
    // emergency sweep cannot fire at a number that has been handed on.
    process.kill(agentPid!, "SIGKILL");
    await expect
      .poll(() => isOurSshAgentProcess(agentPid!, socketPath), { timeout: 5_000 })
      .toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import manifest from "./manifest.js";

const mockSandboxConnect = vi.hoisted(() => vi.fn());
const mockSandboxCreate = vi.hoisted(() => vi.fn());

vi.mock("novita-sandbox", () => ({
  Sandbox: {
    connect: mockSandboxConnect,
    create: mockSandboxCreate,
  },
}));

import plugin, { buildShellCommand, parseNovitaDriverConfig } from "./plugin.js";

describe("Novita sandbox provider plugin", () => {
  it("declares a sandbox provider environment driver", () => {
    expect(manifest.capabilities).toContain("environment.drivers.register");
    expect(manifest.environmentDrivers).toHaveLength(1);
    expect(manifest.environmentDrivers?.[0]).toMatchObject({
      driverKey: "novita",
      kind: "sandbox_provider",
      displayName: "Novita Agent Sandbox",
    });
  });

  it("parses defaults", () => {
    expect(parseNovitaDriverConfig({})).toMatchObject({
      apiKey: null,
      domain: null,
      template: null,
      requestedCwd: "/home/user/paperclip-workspace",
      timeoutMs: 300_000,
      requestTimeoutMs: 30_000,
      secure: null,
      autoPause: false,
      reuseLease: false,
    });
  });

  it("parses configured values", () => {
    expect(parseNovitaDriverConfig({
      apiKey: "sk-test",
      domain: "https://sandbox.example.test",
      template: "paperclip-template",
      requestedCwd: "/workspace",
      timeoutMs: 600000,
      requestTimeoutMs: 45000,
      secure: true,
      autoPause: true,
      reuseLease: true,
    })).toMatchObject({
      apiKey: "sk-test",
      domain: "https://sandbox.example.test",
      template: "paperclip-template",
      requestedCwd: "/workspace",
      timeoutMs: 600_000,
      requestTimeoutMs: 45_000,
      secure: true,
      autoPause: true,
      reuseLease: true,
    });
  });

  it("builds a quoted shell command with cwd, args, and stdin", () => {
    const { command } = buildShellCommand({
      command: "node",
      args: ["-e", "console.log(process.env.MESSAGE)"],
      cwd: "/workspace/project",
      env: { MESSAGE: "hello world" },
      stdin: "input body",
    });

    expect(command).toContain("cd '/workspace/project'");
    expect(command).toContain("'node' '-e' 'console.log(process.env.MESSAGE)'");
    expect(command).toContain("printf '%s' 'input body' > '/tmp/.paperclip-stdin-");
    expect(command).toMatch(/< '\/tmp\/\.paperclip-stdin-[^']+'/);
    expect(command).toMatch(/rm -f '\/tmp\/\.paperclip-stdin-[^']+'/);
    expect(command).toContain("exit $status");
  });

  /**
   * Regression gate for ZIM-2085 (sentinel shape borrowed from
   * packages/adapter-utils/src/ssh-env-argv.test.ts).
   *
   * The script becomes the sandbox process's argv and transits the Novita API,
   * so no env VALUE may appear in it. Key names are fine.
   */
  it("keeps env values out of the transmitted command string", () => {
    const SENTINEL = "sk-zim2085-sentinel-do-not-leak";
    const { command, envs } = buildShellCommand({
      command: "node",
      args: ["-e", "console.log(1)"],
      cwd: "/workspace/project",
      env: { ANTHROPIC_API_KEY: SENTINEL },
    });

    expect(command).not.toContain(SENTINEL);
    expect(command).not.toContain("export ANTHROPIC_API_KEY");
    // …and it still gets delivered, via the structured field.
    expect(envs).toEqual({ ANTHROPIC_API_KEY: SENTINEL });
  });

  it("returns no envs when there is nothing to pass", () => {
    expect(buildShellCommand({ command: "true" }).envs).toEqual({});
    expect(buildShellCommand({ command: "true", env: {} }).envs).toEqual({});
  });

  it("does not use a heredoc delimiter for stdin", () => {
    const { command } = buildShellCommand({
      command: "cat",
      stdin: "before\nPAPERCLIP_STDIN\nafter",
    });

    expect(command).toContain("before\nPAPERCLIP_STDIN\nafter");
    expect(command).not.toContain("<<");
  });

  it("uses a unique stdin path for each command", () => {
    const { command: first } = buildShellCommand({
      command: "cat",
      stdin: "first",
    });
    const { command: second } = buildShellCommand({
      command: "cat",
      stdin: "second",
    });
    const firstPath = first.match(/\/tmp\/\.paperclip-stdin-[^']+/)?.[0];
    const secondPath = second.match(/\/tmp\/\.paperclip-stdin-[^']+/)?.[0];

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(firstPath).not.toBe(secondPath);
    expect(first).not.toContain("/tmp/.paperclip-stdin <<");
    expect(second).not.toContain("/tmp/.paperclip-stdin <<");
  });

  it("rejects unsafe environment variable keys", () => {
    expect(() => buildShellCommand({
      command: "env",
      env: { "BAD-KEY": "value" },
    })).toThrow("Invalid sandbox environment variable key");
  });

  it("returns a command failure when execute is called for an expired sandbox lease", async () => {
    mockSandboxConnect.mockRejectedValueOnce(new Error("sandbox not found"));

    const result = await plugin.definition.onEnvironmentExecute?.({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      runId: "run-1",
      config: { apiKey: "sk-test" },
      lease: { providerLeaseId: "sb-expired", metadata: {} },
      command: "true",
    });

    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Novita sandbox lease is no longer available.\n",
      metadata: {
        provider: "novita",
        sandboxId: "sb-expired",
        expired: true,
      },
    });
  });
});

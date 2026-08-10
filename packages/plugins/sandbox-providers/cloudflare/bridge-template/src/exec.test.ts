import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

import { executeInSandbox, selectEnvEntries } from "./exec.js";

describe("bridge exec", () => {
  it("invokes target.exec with a single shell command string and no args option", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "claude 1.0.0\n",
      stderr: "",
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    // The env-file staging and cleanup execs run on the sandbox itself, not the
    // named session, so the sandbox needs its own exec.
    const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      exec: sandboxExec,
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile,
      deleteFile: vi.fn(),
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "claude",
      args: ["--version"],
      cwd: "/workspace/paperclip",
      env: { PAPERCLIP_TEST_FLAG: "1" },
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 12_345,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const [commandArg, optionsArg] = exec.mock.calls[0] ?? [];
    expect(typeof commandArg).toBe("string");
    expect(commandArg).toMatch(/^sh -lc /);
    expect(optionsArg).toEqual({ cwd: "/", timeout: 12_345 });
    expect(optionsArg).not.toHaveProperty("args");
    expect(optionsArg).not.toHaveProperty("stdin");
    expect(commandArg).toContain('. /etc/profile');
    expect(commandArg).toContain("cd ");
    expect(commandArg).toContain("/workspace/paperclip");
    expect(commandArg).toContain("claude");
    expect(commandArg).toContain("--version");

    // Env is staged in a file under a 0700 directory and sourced, never
    // interpolated (ZIM-2084). The command carries only the path.
    expect(commandArg).not.toContain("PAPERCLIP_TEST_FLAG");
    const [envPath, envPayload] = writeFile.mock.calls[0] ?? [];
    expect(envPath).toMatch(/^\/tmp\/\.paperclip-bridge-env-.*\/env$/);
    expect(envPayload).toBe("export PAPERCLIP_TEST_FLAG='1'\n");
    // The script is nested inside `sh -lc '...'`, so its inner quotes are
    // shell-escaped; match on the path and the delete, not the quoting.
    expect(commandArg).toContain(String(envPath));
    expect(commandArg).toContain("rm -rf ");
    expect(String(commandArg).indexOf("nvm.sh")).toBeLessThan(String(commandArg).indexOf(String(envPath)));
    expect(sandboxExec.mock.calls[0]?.[0]).toMatch(
      /^sh -c 'umask 077 && mkdir -p '"'"'\/tmp\/\.paperclip-bridge-env-[^']+'"'"' && chmod 700 /,
    );
  });

  /**
   * Regression gate for ZIM-2084 (Class B of ZIM-2069).
   *
   * The script is passed to the sandbox's `exec()` as a command string, so it
   * becomes the container process's argv, readable out of `/proc/<pid>/cmdline`
   * by anything else running in that sandbox. No env value may appear in any
   * command string handed to the SDK.
   *
   * The assertion is on the *value*, never the key name — the key legitimately
   * appears in the staged env file.
   */
  it("keeps env values out of every command string handed to the SDK", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      exec: sandboxExec,
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile,
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as const;
    const SENTINEL = "sk-zim2084-cloudflare-sentinel-do-not-leak";

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "claude",
      args: ["--print"],
      cwd: "/workspace/paperclip",
      env: { PAPERCLIP_API_KEY: SENTINEL },
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
    });

    for (const call of [...exec.mock.calls, ...sandboxExec.mock.calls]) {
      expect(String(call[0])).not.toContain(SENTINEL);
    }
    // The value still has to reach the sandbox — over writeFile, not argv.
    const carriers = writeFile.mock.calls.filter((call) => String(call[1]).includes(SENTINEL));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.[1]).toBe(`export PAPERCLIP_API_KEY='${SENTINEL}'\n`);
  });

  it("requests streaming callbacks when bridge output forwarding is enabled", async () => {
    const exec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return {
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    } as const;
    const onOutput = vi.fn();

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "echo",
      args: ["hello"],
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
      onOutput,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/",
      timeout: 5_000,
      stream: true,
      onOutput: expect.any(Function),
    });
    expect(onOutput).toHaveBeenCalledWith("stdout", "hello\n");
  });

  it("stages stdin through a sandbox temp file and redirects from it", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    // sessionStrategy: "default" routes through the sandbox itself (no
    // getSession wrapper), so exec must live directly on the sandbox.
    const sandbox = {
      exec,
      getSession: vi.fn(),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "cat",
      args: [],
      sessionStrategy: "default",
      timeoutMs: 5_000,
      stdin: "payload-bytes",
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [stdinPath, stdinPayload] = writeFile.mock.calls[0] ?? [];
    expect(typeof stdinPath).toBe("string");
    expect(stdinPath).toMatch(/^\/tmp\/\.paperclip-bridge-stdin-/);
    expect(stdinPayload).toBe("payload-bytes");

    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).toContain(stdinPath);
    expect(commandArg).toMatch(/<\s*['"]/);

    expect(deleteFile).toHaveBeenCalledWith(stdinPath);
  });

  it("does not write a stdin file or redirect when stdin is empty", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn();
    const deleteFile = vi.fn();
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "pwd",
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
      stdin: null,
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).not.toContain("<");
  });

  it("rejects invalid environment variable keys before staging the env file", async () => {
    expect(() => selectEnvEntries({ "bad-key": "1" }))
      .toThrow("Invalid sandbox environment variable key: bad-key");

    // The rejection must happen before anything is written, so a bad key cannot
    // leave an orphaned env file behind.
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      getSession: vi.fn().mockResolvedValue({ exec: vi.fn() }),
      writeFile,
      deleteFile: vi.fn(),
    } as const;

    await expect(executeInSandbox({
      sandbox: sandbox as never,
      command: "pwd",
      args: [],
      env: { "bad-key": "1" },
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
    })).rejects.toThrow("Invalid sandbox environment variable key: bad-key");
    expect(writeFile).not.toHaveBeenCalled();
  });
});

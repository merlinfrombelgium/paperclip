import { describe, expect, it } from "vitest";
import {
  buildEnvFilePath,
  buildEnvFilePayload,
  buildEnvFileRemovalCommand,
  buildEnvFileStagingCommand,
  selectExecEnvEntries,
  wrapCommandWithEnvFile,
} from "../../src/pod-exec-env.js";

/**
 * Regression gate for ZIM-2085 (sentinel shape borrowed from
 * packages/adapter-utils/src/ssh-env-argv.test.ts).
 *
 * Env values must never be interpolated into the command string handed to the
 * Kubernetes exec API: that string becomes the pod process's argv (readable via
 * /proc/<pid>/cmdline by anything already running in the sandbox) and transits
 * kube-apiserver audit logs. Assertions are on the *value*, never the key name —
 * the key legitimately appears in the staged file and in nothing else.
 */
const SENTINEL = "sk-zim2085-sentinel-do-not-leak";
const SENTINEL_KEY = "ANTHROPIC_API_KEY";

describe("selectExecEnvEntries", () => {
  it("returns nothing for absent or empty env", () => {
    expect(selectExecEnvEntries(undefined)).toEqual([]);
    expect(selectExecEnvEntries(null)).toEqual([]);
    expect(selectExecEnvEntries({})).toEqual([]);
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    expect(selectExecEnvEntries({ PATH: "/server/bin", XDG_CONFIG_HOME: "/c" })).toEqual([
      ["XDG_CONFIG_HOME", "/c"],
    ]);
  });

  it("skips invalid identifiers and non-string values", () => {
    const entries = selectExecEnvEntries({
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    expect(entries).toEqual([["GOOD_KEY", "y"]]);
  });
});

describe("buildEnvFilePayload", () => {
  it("emits one export per entry and shell-escapes single quotes", () => {
    expect(buildEnvFilePayload([["XDG_CONFIG_HOME", "/tmp/cfg"], ["V", "a'b"]])).toBe(
      "export XDG_CONFIG_HOME='/tmp/cfg'\nexport V='a'\\''b'\n",
    );
  });
});

describe("buildEnvFilePath", () => {
  it("is absolute and unique per call", () => {
    const first = buildEnvFilePath();
    const second = buildEnvFilePath();
    expect(first).toMatch(/^\/tmp\/paperclip-env-[0-9a-fA-F-]+$/);
    expect(first).not.toBe(second);
  });
});

describe("buildEnvFileStagingCommand", () => {
  it("reads the payload from stdin under a restrictive umask", () => {
    const out = buildEnvFileStagingCommand("/tmp/paperclip-env-abc");
    expect(out[0]).toBe("/bin/sh");
    expect(out[1]).toBe("-c");
    expect(out[2]).toBe(
      "umask 077 && cat > '/tmp/paperclip-env-abc' && chmod 600 '/tmp/paperclip-env-abc'",
    );
  });
});

describe("wrapCommandWithEnvFile", () => {
  it("returns the command unchanged when nothing was staged", () => {
    expect(wrapCommandWithEnvFile(["opencode", "run"], null)).toEqual(["opencode", "run"]);
  });

  it("sources the staged file, removes it, then execs the original command", () => {
    const out = wrapCommandWithEnvFile(
      ["opencode", "run", "--model", "anthropic/x"],
      "/tmp/paperclip-env-abc",
    );
    expect(out[0]).toBe("/bin/sh");
    expect(out[1]).toBe("-c");
    expect(out[2]).toBe(
      ". '/tmp/paperclip-env-abc' && rm -f '/tmp/paperclip-env-abc'"
      + " && exec 'opencode' 'run' '--model' 'anthropic/x'",
    );
  });

  it("fails rather than running the command without the env it was promised", () => {
    const out = wrapCommandWithEnvFile(["opencode"], "/tmp/paperclip-env-abc");
    // `&&`, not `;` — a missing file must not silently degrade to a bare exec.
    expect(out[2]).not.toContain(";");
  });
});

describe("no env value reaches a transmitted command string", () => {
  const env = { [SENTINEL_KEY]: SENTINEL, XDG_CONFIG_HOME: "/tmp/cfg" };
  const entries = selectExecEnvEntries(env);
  const envFilePath = buildEnvFilePath();

  it("keeps the value out of the staging command", () => {
    expect(buildEnvFileStagingCommand(envFilePath).join(" ")).not.toContain(SENTINEL);
  });

  it("keeps the value out of the wrapped exec command", () => {
    const wrapped = wrapCommandWithEnvFile(["opencode", "run"], envFilePath);
    expect(wrapped.join(" ")).not.toContain(SENTINEL);
    // The key name is fine to carry; only the value is secret.
    expect(wrapped.join(" ")).toContain(envFilePath);
  });

  it("keeps the value out of the removal command", () => {
    expect(buildEnvFileRemovalCommand(envFilePath).join(" ")).not.toContain(SENTINEL);
  });

  it("still delivers the value — over the exec stdin channel", () => {
    const payload = buildEnvFilePayload(entries);
    expect(payload).toContain(SENTINEL);
    expect(payload).toContain(`export ${SENTINEL_KEY}=`);
  });
});

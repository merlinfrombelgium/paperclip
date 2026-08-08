import { describe, expect, it, vi } from "vitest";
import {
  isTransientDbConflictError,
  readPostgresErrorCode,
  withTransientDbConflictRetry,
} from "../db-retry.ts";

/** Shape a driver error the way postgres.js + drizzle actually deliver it: code on the wrapped cause. */
function drizzleWrapped(code: string, message = "boom") {
  const driverError = Object.assign(new Error(message), { code });
  return Object.assign(new Error(`DrizzleQueryError: ${message}`), { cause: driverError });
}

const noSleep = async () => {};

describe("readPostgresErrorCode", () => {
  it("reads a code off the error itself", () => {
    expect(readPostgresErrorCode(Object.assign(new Error("x"), { code: "40P01" }))).toBe("40P01");
  });

  it("walks the cause chain to find a wrapped driver code", () => {
    expect(readPostgresErrorCode(drizzleWrapped("40001"))).toBe("40001");
  });

  it("stops walking instead of looping forever on a self-referencing cause", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(readPostgresErrorCode(looped)).toBeNull();
  });

  it("returns null for plain errors and non-objects", () => {
    expect(readPostgresErrorCode(new Error("plain"))).toBeNull();
    expect(readPostgresErrorCode("40P01")).toBeNull();
    expect(readPostgresErrorCode(null)).toBeNull();
  });
});

describe("isTransientDbConflictError", () => {
  it("matches deadlock_detected and serialization_failure", () => {
    expect(isTransientDbConflictError(drizzleWrapped("40P01"))).toBe(true);
    expect(isTransientDbConflictError(drizzleWrapped("40001"))).toBe(true);
  });

  it("does not match errors that must not be replayed", () => {
    // 23503 foreign_key_violation, 23505 unique_violation, 57014 query_canceled:
    // replaying any of these is either pointless or actively wrong.
    expect(isTransientDbConflictError(drizzleWrapped("23503"))).toBe(false);
    expect(isTransientDbConflictError(drizzleWrapped("23505"))).toBe(false);
    expect(isTransientDbConflictError(drizzleWrapped("57014"))).toBe(false);
    expect(isTransientDbConflictError(new Error("no code at all"))).toBe(false);
  });
});

describe("withTransientDbConflictRetry", () => {
  it("returns the first-attempt value without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const operation = vi.fn(async () => "ok");
    await expect(withTransientDbConflictRetry(operation, { sleep })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a deadlock and returns the eventual success", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw drizzleWrapped("40P01", "deadlock detected");
      return `succeeded on attempt ${calls}`;
    });

    await expect(
      withTransientDbConflictRetry(operation, { sleep: noSleep, onRetry }),
    ).resolves.toBe("succeeded on attempt 3");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2]);
  });

  it("rethrows the conflict once attempts are exhausted", async () => {
    const error = drizzleWrapped("40001", "could not serialize access");
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(
      withTransientDbConflictRetry(operation, { attempts: 3, sleep: noSleep }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error that is not a transient conflict", async () => {
    const error = drizzleWrapped("23503", "violates foreign key constraint");
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(withTransientDbConflictRetry(operation, { sleep: noSleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("backs off with a bounded, jittered delay", async () => {
    const delays: number[] = [];
    const operation = vi.fn(async () => {
      throw drizzleWrapped("40P01");
    });

    await expect(
      withTransientDbConflictRetry(operation, {
        attempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(delays).toHaveLength(4);
    // Jitter keeps each wait in [backoff/2, backoff]; the cap clamps the tail.
    const expectedBackoffs = [100, 200, 250, 250];
    delays.forEach((delay, index) => {
      const backoff = expectedBackoffs[index]!;
      expect(delay).toBeGreaterThanOrEqual(Math.floor(backoff / 2));
      expect(delay).toBeLessThanOrEqual(backoff);
    });
    // Non-constant jitter is the point: identical waits would resynchronize victims.
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});

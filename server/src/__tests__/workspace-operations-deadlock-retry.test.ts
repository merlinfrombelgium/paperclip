import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the FK-lock deadlock that killed a heartbeat mid-finalize:
 *
 *   DrizzleQueryError: insert into "workspace_operations" (...)
 *   caused by: PostgresError: deadlock detected
 *     at recordOperation (server/src/services/workspace-operations.ts)
 *     at recordWorkspaceFinalize (server/src/services/heartbeat.ts)
 *
 * `workspace_operations.issue_id` references `issues.id`, so the insert takes a
 * FOR KEY SHARE lock on the issue row that a concurrent `PATCH /api/issues/{id}`
 * wants to UPDATE. Postgres kills one of them; before the retry it was the run.
 *
 * These tests drive the real service against a stub db that fails on demand, so
 * the assertions are on *attempt counts* — a service that quietly stopped
 * retrying would still resolve, but with the wrong count.
 */

const logWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.ts", () => ({
  logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/instance-settings.ts", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/workspace-operation-log-store.ts", () => ({
  getWorkspaceOperationLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "company/op.ndjson" }),
    append: async () => {},
    finalize: async () => ({ bytes: 12, sha256: "abc", compressed: false }),
    read: async () => ({ content: "", offset: 0, nextOffset: 0, eof: true }),
  }),
}));

const { workspaceOperationService } = await import("../services/workspace-operations.ts");

/** postgres.js puts the SQLSTATE on the driver error; drizzle wraps it as `cause`. */
function deadlockError(message = "deadlock detected") {
  const driverError = Object.assign(new Error(message), { code: "40P01" });
  return Object.assign(new Error('insert into "workspace_operations" ...'), { cause: driverError });
}

function foreignKeyViolation() {
  const driverError = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
  return Object.assign(new Error('insert into "workspace_operations" ...'), { cause: driverError });
}

interface StubDbOptions {
  /** Errors to throw on successive insert attempts; `null` means "succeed". */
  insertFailures?: (unknown | null)[];
  /** Errors to throw on successive update attempts; `null` means "succeed". */
  updateFailures?: (unknown | null)[];
}

function createStubDb(options: StubDbOptions = {}) {
  const insertFailures = [...(options.insertFailures ?? [])];
  const updateFailures = [...(options.updateFailures ?? [])];
  const state = { insertAttempts: 0, updateAttempts: 0, lastInsertedValues: null as any };

  /** Drizzle's update builder is thenable *and* exposes `.returning()`; mimic both. */
  function updateResult() {
    const rows = Promise.resolve([
      {
        id: state.lastInsertedValues?.id ?? "op-id",
        companyId: "company-1",
        executionWorkspaceId: null,
        heartbeatRunId: "run-1",
        issueId: "issue-1",
        phase: "workspace_finalize",
        command: null,
        cwd: null,
        status: "succeeded",
        exitCode: 0,
        logStore: "local_file",
        logRef: "company/op.ndjson",
        logBytes: 12,
        logSha256: "abc",
        logCompressed: false,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        metadata: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    return {
      returning: () => rows,
      then: rows.then.bind(rows),
      catch: rows.catch.bind(rows),
      finally: rows.finally.bind(rows),
    };
  }

  const db = {
    insert: () => ({
      values: async (values: any) => {
        const failure = insertFailures[state.insertAttempts] ?? null;
        state.insertAttempts += 1;
        if (failure) throw failure;
        state.lastInsertedValues = values;
        return undefined;
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          const failure = updateFailures[state.updateAttempts] ?? null;
          state.updateAttempts += 1;
          if (failure) {
            const rejected = Promise.reject(failure);
            // Swallow the unhandled-rejection warning for the branch the caller doesn't take.
            rejected.catch(() => {});
            return {
              returning: () => rejected,
              then: rejected.then.bind(rejected),
              catch: rejected.catch.bind(rejected),
              finally: rejected.finally.bind(rejected),
            };
          }
          return updateResult();
        },
      }),
    }),
  };

  return { db, state };
}

function createRecorder(db: unknown) {
  return workspaceOperationService(db as any).createRecorder({
    companyId: "company-1",
    heartbeatRunId: "run-1",
    issueId: "issue-1",
  });
}

describe("recordOperation transient-conflict retry", () => {
  beforeEach(() => {
    logWarn.mockClear();
  });

  it("retries a deadlocked insert and still runs the operation", async () => {
    const { db, state } = createStubDb({
      insertFailures: [deadlockError(), deadlockError()],
    });
    const run = vi.fn(async () => ({ status: "succeeded" as const, exitCode: 0 }));

    const operation = await createRecorder(db).recordOperation({
      phase: "workspace_finalize",
      run,
    });

    expect(state.insertAttempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(operation.status).toBe("succeeded");
    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn.mock.calls[0]![0]).toMatchObject({ statement: "insert", attempt: 1 });
  });

  it("retries a deadlocked finalize update", async () => {
    const { db, state } = createStubDb({
      updateFailures: [deadlockError("deadlock detected")],
    });

    const operation = await createRecorder(db).recordOperation({
      phase: "workspace_finalize",
      run: async () => ({ status: "succeeded" as const, exitCode: 0 }),
    });

    expect(state.updateAttempts).toBe(2);
    expect(operation.id).toBeTruthy();
    expect(logWarn.mock.calls[0]![0]).toMatchObject({ statement: "update:finish" });
  });

  it("gives up after the bounded attempt budget and never runs the operation", async () => {
    const failures = [deadlockError(), deadlockError(), deadlockError(), deadlockError()];
    const { db, state } = createStubDb({ insertFailures: failures });
    const run = vi.fn(async () => ({ status: "succeeded" as const }));

    await expect(
      createRecorder(db).recordOperation({ phase: "workspace_finalize", run }),
    ).rejects.toBe(failures[3]);

    // 4 attempts total, not unbounded: a wedged lock must surface, not spin.
    expect(state.insertAttempts).toBe(4);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not retry an insert error that is not a transient conflict", async () => {
    const violation = foreignKeyViolation();
    const { db, state } = createStubDb({ insertFailures: [violation] });

    await expect(
      createRecorder(db).recordOperation({
        phase: "workspace_finalize",
        run: async () => ({ status: "succeeded" as const }),
      }),
    ).rejects.toBe(violation);

    expect(state.insertAttempts).toBe(1);
    expect(logWarn).not.toHaveBeenCalled();
  });
});

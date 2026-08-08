/**
 * Retry helper for PostgreSQL transient conflict errors.
 *
 * Two server errors mean "your transaction lost a race, nothing was written,
 * run it again":
 *   - 40P01 deadlock_detected     — the deadlock detector picked us as victim
 *   - 40001 serialization_failure — a concurrent update invalidated our snapshot
 *
 * Both abort the whole transaction, so a statement that failed this way left no
 * partial state behind and is safe to replay verbatim — provided the statement
 * itself is idempotent when re-run (client-supplied primary keys, updates keyed
 * by id). Callers must not wrap statements that read-then-write derived values.
 *
 * The concrete case this was written for: `workspace_operations.issue_id` has an
 * FK to `issues.id`, so inserting an operation row takes a FOR KEY SHARE lock on
 * the referenced issue row while a concurrent `PATCH /api/issues/{id}` takes an
 * UPDATE lock on the same row. A heartbeat finalizing its workspace while its
 * issue is being PATCHed can lose that race and, without a retry, lose the run.
 */

const TRANSIENT_CONFLICT_CODES = new Set(["40P01", "40001"]);

/** Postgres driver errors reach us wrapped (e.g. DrizzleQueryError.cause), so walk the chain. */
export function readPostgresErrorCode(error: unknown, maxDepth = 6): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string" && record.code.length > 0) return record.code;
    current = record.cause;
  }
  return null;
}

export function isTransientDbConflictError(error: unknown): boolean {
  const code = readPostgresErrorCode(error);
  return code !== null && TRANSIENT_CONFLICT_CODES.has(code);
}

export interface TransientDbConflictRetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  /** Base backoff; attempt N waits roughly baseDelayMs * 2^(N-1), plus jitter. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff wait. */
  maxDelayMs?: number;
  /** Called before each retry — used for logging and for asserting the retry path in tests. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable sleep so tests don't have to burn wall-clock on backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying it on 40P01/40001 with bounded exponential backoff.
 * Any other error — and the last attempt's conflict error — propagates unchanged.
 */
export async function withTransientDbConflictRetry<T>(
  operation: () => Promise<T>,
  options: TransientDbConflictRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 25);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 500);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbConflictError(error)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Jitter so concurrent victims of the same deadlock don't retry in lockstep
      // and immediately deadlock again.
      const delayMs = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

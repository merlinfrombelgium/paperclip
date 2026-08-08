# Board Doctor: checkpoint + resume

A board health sweep routinely wants to make more writes than the cross-issue influence
cap allows in one run. Without checkpointing, hitting the cap mid-sweep leaves the board
half-repaired with no record of what was intended — the worst possible state, because
neither a human nor the next heartbeat can tell repaired targets from unrepaired ones.

## The cap, as verified

Verified against the shipped enforcement code (ZIM-2068, 2026-08-07). Three properties
shape the whole design:

- **20 cross-issue writes per _heartbeat run_** — not per source issue. The count predicate
  is `companyId + runId + action`, so **budget resets every heartbeat**. This is exactly
  what makes converge-across-heartbeats work, rather than merely tolerable.
- **Writes to your own issue are free and uncounted.** The checkpoint document and the
  closing status comment both live on the source issue, so the safety mechanism costs
  nothing from the budget it protects.
- **Updates and comments share one counter.** Count both.

The refusal is clean and catchable: `HTTP 429` with
`details.code === "cross_issue_influence_cap_exceeded"`, returned **before** the mutation —
no partial write, no run abort. Branch on the code, not the prose. A rejected attempt does
not consume budget, so the counter freezes at the cap and retries are counter-safe.

There is **no per-class, per-source, or per-company override hook**; the limit is a
hard-coded constant. Checkpoint + resume is the only fix, which is why this exists.

This protocol makes a sweep of any size safe at any cap.

Engine: `skills/paperclip/scripts/board_doctor_sweep.py`
Tests: `skills/paperclip/scripts/test_board_doctor_sweep.py`

## The two properties that matter

**1. Verify before write — this, not bookkeeping, is what prevents duplicate writes.**

Every work item carries a `verify` predicate describing the state the target should be in
once the repair lands. Before writing, the engine re-reads the target and skips the item if
the predicate already holds. So even if the checkpoint is stale, lost, or was never
flushed, no target is ever written twice. The persisted worklist is an optimisation that
saves a heartbeat; correctness does not depend on it.

An item with an empty `verify` cannot be checked against the target (a comment, say). Those
are written at most once per sweep and rely on the checkpoint alone — prefer verifiable ops
where you can.

**2. Budget before refusal — stop on your own count, don't lean on catching the "no".**

The engine counts its own target writes and stops at `cap - reserve`, so it normally never
reaches the boundary at all. The refusal path is a backstop, not the mechanism.

The reserve is now only a margin against miscounting a write the engine failed to attribute
— since same-issue writes are free, the checkpoint no longer needs paying for. Set it to 0
for full budget.

If a refusal does arrive, it is deferred without burning a retry attempt: a budget problem
is not the item's fault, and retrying in the same heartbeat cannot help because the counter
has already frozen at the cap.

The suite still exercises convergence under all three originally-plausible refusal modes
(clean error, silent no-op, mid-run abort). Only the first is real, but the other two cost
nothing to keep and pin down behaviour if the contract ever shifts.

## Lifecycle

```
plan   -> build the FULL worklist, persist it, THEN start writing
apply  -> for each item: verify -> skip or write -> stop at budget -> checkpoint
resume -> next heartbeat reloads the worklist and continues; repeat until complete
```

The whole worklist is persisted **before the first repair**. A run that dies immediately
after planning still leaves a complete resume point.

## Durable state

An issue document on the sweep's *source* issue, key `board-doctor-worklist`. The body is a
human-readable progress table plus a fenced JSON block holding the machine-readable resume
point. Both render from the same state, so the summary cannot drift from reality.

Document writes go to the source issue, not to sweep targets. Same-issue writes are exempt
from the cap entirely, so checkpointing is free.

**Document updates are revision-guarded.** `PUT /api/issues/{id}/documents/{key}` returns
`409 Document update requires baseRevisionId` unless the caller passes the current
`latestRevisionId` (omit it when creating). A dropped checkpoint is silent progress loss, so
on 409 the engine reloads, merges, and retries once. The merge is monotonic — an item only
moves from pending toward terminal, so a terminal state on either side wins and the result
is order-independent.

## Item states

| State | Meaning |
| - | - |
| `pending` | not yet applied; this is the resume point |
| `done` | write landed this sweep |
| `skipped` | target already satisfied — repaired externally or by a lost heartbeat |
| `failed_permanent` | parked after `MAX_ATTEMPTS` (3) heartbeats; surfaced for board action |

Parking matters: one poison target (deleted issue, permission wall) must never strand every
other repair. A parked item is reported, not retried forever.

## Usage

```bash
# 1. Build the worklist as JSON, one entry per intended write.
cat > "$PAPERCLIP_RUN_SCRATCH_DIR/items.json" <<'JSON'
[
  {
    "key": "ZIM-1234:status:blocked",
    "target_issue_id": "<uuid>",
    "target_identifier": "ZIM-1234",
    "op": "patch_issue",
    "payload": {"status": "blocked"},
    "verify": {"status": "blocked"}
  }
]
JSON

# 2. Persist it before touching anything.
python3 skills/paperclip/scripts/board_doctor_sweep.py \
  --source-issue "$PAPERCLIP_TASK_ID" \
  plan "$PAPERCLIP_RUN_SCRATCH_DIR/items.json" --sweep-id "sweep-$(date -u +%Y-%m-%d)"

# 3. Apply within budget. Re-run each heartbeat until it prints "complete".
python3 skills/paperclip/scripts/board_doctor_sweep.py --source-issue "$PAPERCLIP_TASK_ID" apply

# Inspect the resume point at any time.
python3 skills/paperclip/scripts/board_doctor_sweep.py --source-issue "$PAPERCLIP_TASK_ID" status
```

`key` must be **deterministic** for a given (target, repair) pair, so that replanning the
same board condition produces the same key and cannot double-apply.

`plan` refuses to clobber a sweep that still has pending items — resume it, or pass
`--force` if you genuinely mean to abandon it.

An unfinished sweep is the **expected steady state**, not a failure. `apply` exits 0 while
converging. Report progress as `N/M items, K remaining` and keep the issue on a live
continuation path until the worklist is empty.

## What a write costs

The counter counts **gated writes, not work items**. Read off `routes/issues.js` in the
shipped build, there are exactly three gated surfaces:

| Surface | Charged as |
| - | - |
| `PATCH /api/issues/:id` — any field change | one `update` |
| `PATCH /api/issues/:id` — a `comment` field on that same request | one *additional* `comment` |
| `POST /api/issues/:id/comments` | one `comment` |

So **folding a per-card note into the PATCH does not save budget** — it is two counter
trips either way. Issue documents and issue creation are not gated at all.

`WorkItem.cost` encodes this, and the budget gate charges in cap units. A sweep of
patch-plus-comment items therefore clears half as many cards a heartbeat.

**Rule: one gated write per card.** Patch the fields, and say everything else in a single
summary comment on the sweep's source issue — self-writes are free, so the whole narrative
costs nothing. Reserve per-card comments for repairs whose note is the entire point and
cannot be inferred from the field change. This is the biggest lever on convergence speed:
the worst observed pass (78 writes / 77 targets) takes ~8 heartbeats at 2 writes per card
and ~4 at one.

There is also a sharp edge at the boundary. Both guards run **before** any mutation, so a
2-cost PATCH that clears the `update` guard and then trips the `comment` guard is charged
for the update and still writes nothing — budget burned, card untouched. Combining is
therefore strictly *worse* than splitting at the cap edge. The engine never straddles it,
because the budget gate stops before any item it cannot fully afford; hand-rolled sweep
writes outside the engine can.

An item that costs more than a whole heartbeat's budget is parked as `failed_permanent`
rather than re-tripping the gate forever.

## Ordered pairs: unblock-and-close is two writes, not one

Observed live on ZIM-1880 (2026-08-07). This is refused:

```
PATCH {blockedByIssueIds: [], status: "done"}
  409 Issue follow-up blocked by unresolved blockers
  details.unresolvedBlockerIssueIds: ["db3df841-..."]
```

The status transition is validated against the blocker set **as it stood before the
request**, not the set in the same body. Clearing and closing must be two ordered PATCHes.

This matters more than it looks, because unblock-and-close is the *commonest* repair the
sweep performs. Planned as one item it is costed at 1 and would 409 anyway; a 10-target
zombie pass budgeted at 10 units really wants 20 writes. Use the helper:

```python
from board_doctor_sweep import unblock_and_close
items = unblock_and_close(issue_id, "ZIM-1880", key_prefix="ZIM-1880:zombie")  # 2 items
```

Three mechanisms back it, each with a negative-control test proving it is load-bearing:

- **`payload_defect`** rejects a combined blocker-clear + status PATCH at *plan* time, so
  the sweep never spends an attempt discovering the 409 at the boundary.
- **`WorkItem.depends_on`** stops the close from being attempted before the unblock has
  actually landed, and parks it immediately if the unblock parks — rather than burning
  three doomed attempts on a write that cannot succeed.
- **Chain admission** charges the budget gate for the item *plus everything still waiting
  on it* (`SweepState.chain_cost`). A pair is admitted only if both halves fit in the
  remaining budget.

That last one is the point. Without it the sweep will happily spend its final unit
clearing a card's blockers and then stop for budget, leaving the target **blockers cleared
but still `blocked`** — a half-repaired state persisting until the next heartbeat, which
is precisely what this engine promises cannot happen. The convergence test asserts the
"fully repaired or entirely untouched" invariant at *every* intermediate checkpoint, not
just at the end.

## The refusal is not observable before 2026-08-11

The shipped code derives `mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" :
"log_only"` and, while `log_only`, returns `allowed: true` no matter how far past the cap
the count has gone. Every write still lands and is still logged with its true `count`.

Two consequences:

- **A sweep that overshoots today does so silently.** The only signal is the
  `issue.cross_issue_influence_observed` activity rows showing `count > cap`. This is how
  the 78-write sweep on run `7f0de392` went unnoticed.
- **The refusal path cannot be exercised against the live control plane until the
  enforcement date.** Until then it is covered by the fake board in the test suite only.

This is why the budget gate, not the refusal handler, is the load-bearing mechanism.

## Supported ops

- `patch_issue` — `PATCH /api/issues/{id}` with `payload`; verifiable
- `comment` — `POST /api/issues/{id}/comments` with `payload.body`; not verifiable

Add new ops in `Sweeper._apply_one`, and give them a `verify` shape wherever the repair is
observable on the target.

## Other refusals

Cap budget is not the only reason a write fails. A foreign-issue mutation can still be
refused — by visibility scoping, a run lock, or an issue that has since been deleted. None
of those are cap-shaped, so they burn attempts and park after three heartbeats. That is the
right outcome: no number of retries fixes a permission wall. Parked items belong in the scan
comment as board reassignment / manual-action cards.

Do not assume a blanket ownership wall on cross-agent writes. That model (ZIM-1838) was
replaced with visibility-scoped default-open writes; verify against live behaviour rather
than planning around the old guarantee.

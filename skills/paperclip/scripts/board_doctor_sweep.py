#!/usr/bin/env python3
"""Board Doctor sweep engine: checkpoint + resume so a cap can never leave a partial repair.

The board health sweep wants to make more writes than the platform's cross-issue
influence cap allows in one run. This module makes that safe by splitting a sweep
into a durable *worklist* that survives the run:

    plan   -> build every intended write up front, persist it as an issue document
    apply  -> verify-then-write each item, stopping before the cap is reached
    resume -> next heartbeat reloads the worklist and continues where it stopped

Two properties do the real work:

1. **Verify before write.** Every item carries a predicate describing the state the
   target should be in once the repair lands. Before writing, the engine re-reads the
   target and skips the item if the predicate already holds. Duplicate writes are
   therefore impossible even if the checkpoint is stale, lost, or was never flushed --
   the bookkeeping is an optimisation, not the safety mechanism.

2. **Budget before refusal.** The engine counts its own target-issue writes and stops
   at ``cap - reserve``, rather than relying on catching the platform's refusal. The
   refusal behaviour at write N+1 is unverified (it may be a clean per-write error, a
   silent no-op, or a hard abort of the run), so the engine never gets close enough to
   depend on which one it is. The reserve keeps enough budget to flush the checkpoint
   and post the status comment.

Run as a CLI (``plan``/``apply``/``status``/``reset``) or import ``Sweeper`` directly.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional

STATE_VERSION = 1
DOCUMENT_KEY = "board-doctor-worklist"
DOCUMENT_TITLE = "Board Doctor sweep worklist"

# Verified against the shipped enforcement code (ZIM-2068, 2026-08-07):
#   * The cap is 20 cross-issue writes **per heartbeat run**, not per source issue. The
#     count predicate is companyId + runId + action, so budget resets every heartbeat --
#     which is exactly what makes converge-across-heartbeats work.
#   * Updates and comments share one counter.
#   * Writes to your own issue are free and uncounted, so the checkpoint flush and the
#     closing status comment (both on the source issue) cost nothing.
# RESERVE is therefore no longer needed to pay for the checkpoint. It is kept as a small
# margin against miscounting a write we failed to attribute; set it to 0 for full budget.
DEFAULT_CAP = 20
DEFAULT_RESERVE = 1

# The refusal is clean and catchable: HTTP 429 with this code, returned *before* the
# mutation, so there is no partial write and no run abort. Branch on the code, not prose.
CAP_REFUSAL_CODE = "cross_issue_influence_cap_exceeded"

# A single item that keeps failing must not wedge the sweep forever. After this many
# heartbeats it is parked as failed_permanent and surfaced for board action.
MAX_ATTEMPTS = 3

PENDING = "pending"
DONE = "done"
SKIPPED = "skipped"
FAILED_PERMANENT = "failed_permanent"

TERMINAL_STATES = frozenset({DONE, SKIPPED, FAILED_PERMANENT})


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------------------


@dataclass
class WorkItem:
    """One intended write, plus how to tell whether it already landed.

    ``key`` must be deterministic for a given (target, repair) pair so that replanning
    the same board condition produces the same key and cannot double-apply.

    ``verify`` is a mapping of issue-field -> expected value, evaluated against the live
    target issue. An empty mapping means "cannot be verified by reading the target"; such
    items are written at most once per sweep and rely on ``state`` alone.
    """

    key: str
    target_issue_id: str
    target_identifier: str
    op: str
    payload: dict[str, Any] = field(default_factory=dict)
    verify: dict[str, Any] = field(default_factory=dict)
    state: str = PENDING
    attempts: int = 0
    last_error: Optional[str] = None
    applied_at: Optional[str] = None
    note: Optional[str] = None

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def satisfied_by(self, issue: dict[str, Any]) -> bool:
        """True when the live target already shows the repaired state."""
        if not self.verify:
            return False
        return all(issue.get(k) == v for k, v in self.verify.items())


@dataclass
class SweepState:
    sweep_id: str
    source_issue_id: str
    items: list[WorkItem] = field(default_factory=list)
    cap: int = DEFAULT_CAP
    reserve: int = DEFAULT_RESERVE
    version: int = STATE_VERSION
    created_at: str = field(default_factory=_utcnow)
    updated_at: str = field(default_factory=_utcnow)
    heartbeats: int = 0
    completed_at: Optional[str] = None

    # -- budget ------------------------------------------------------------------

    @property
    def budget(self) -> int:
        """Target-issue writes allowed in a single heartbeat."""
        return max(0, self.cap - self.reserve)

    # -- progress ----------------------------------------------------------------

    @property
    def pending(self) -> list[WorkItem]:
        return [i for i in self.items if not i.terminal]

    @property
    def complete(self) -> bool:
        return all(i.terminal for i in self.items)

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for item in self.items:
            out[item.state] = out.get(item.state, 0) + 1
        return out

    # -- serialisation -----------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["items"] = [asdict(i) for i in self.items]
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "SweepState":
        raw_items = data.get("items") or []
        known = {f for f in WorkItem.__dataclass_fields__}
        items = [WorkItem(**{k: v for k, v in raw.items() if k in known}) for raw in raw_items]
        fields = {f for f in cls.__dataclass_fields__} - {"items"}
        kwargs = {k: v for k, v in data.items() if k in fields}
        return cls(items=items, **kwargs)

    def to_document(self) -> str:
        """Render as a markdown document body with an embedded machine-readable block.

        Humans read the table; the next heartbeat reads the JSON. Both come from the same
        state, so the rendered summary can never drift from the resume point.
        """
        counts = self.counts()
        done = counts.get(DONE, 0) + counts.get(SKIPPED, 0)
        lines = [
            f"# {DOCUMENT_TITLE}",
            "",
            f"- Sweep: `{self.sweep_id}`",
            f"- Progress: **{done}/{len(self.items)}** terminal "
            f"({counts.get(PENDING, 0)} pending, {counts.get(FAILED_PERMANENT, 0)} parked)",
            f"- Heartbeats: {self.heartbeats}",
            f"- Per-heartbeat write budget: {self.budget} (cap {self.cap}, reserve {self.reserve})",
            f"- Updated: {self.updated_at}",
        ]
        if self.completed_at:
            lines.append(f"- Completed: {self.completed_at}")
        lines += ["", "| # | Target | Op | State | Attempts | Note |", "| - | - | - | - | - | - |"]
        for n, item in enumerate(self.items, 1):
            note = item.note or item.last_error or ""
            lines.append(
                f"| {n} | {item.target_identifier} | {item.op} | {item.state} | "
                f"{item.attempts} | {note[:80].replace('|', '/')} |"
            )
        lines += [
            "",
            "<!-- Machine-readable resume point. Do not hand-edit; the next heartbeat parses it. -->",
            "",
            "```json",
            json.dumps(self.to_json(), indent=2, sort_keys=True),
            "```",
            "",
        ]
        return "\n".join(lines)

    @classmethod
    def from_document(cls, body: str) -> Optional["SweepState"]:
        """Recover state from a document body, tolerating surrounding prose."""
        if not body:
            return None
        marker = "```json"
        start = body.find(marker)
        if start == -1:
            return None
        start += len(marker)
        end = body.find("```", start)
        if end == -1:
            return None
        try:
            return cls.from_json(json.loads(body[start:end]))
        except (ValueError, TypeError):
            return None


# --------------------------------------------------------------------------------------
# Control-plane client
# --------------------------------------------------------------------------------------


class WriteRefused(Exception):
    """A target write was refused or failed. Carries whether it looked cap-shaped."""

    def __init__(self, message: str, cap_shaped: bool = False):
        super().__init__(message)
        self.cap_shaped = cap_shaped


class PaperclipClient:
    """Minimal control-plane client. Injectable so the engine is testable offline."""

    def __init__(self, base_url: str, api_key: str, run_id: Optional[str] = None, timeout: int = 30):
        self.base = base_url.rstrip("/")
        if self.base.endswith("/api"):
            self.base = self.base[: -len("/api")]
        self.api_key = api_key
        self.run_id = run_id
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.api_key}")
        req.add_header("Content-Type", "application/json")
        if self.run_id:
            req.add_header("X-Paperclip-Run-Id", self.run_id)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:400]
            # Prefer the structured code over the prose, which is free to change.
            code = None
            try:
                code = (json.loads(detail).get("details") or {}).get("code")
            except (ValueError, AttributeError):
                pass
            cap_shaped = code == CAP_REFUSAL_CODE or (code is None and exc.code == 429)
            raise WriteRefused(f"HTTP {exc.code} {method} {path}: {detail}", cap_shaped) from exc
        except urllib.error.URLError as exc:
            raise WriteRefused(f"network error {method} {path}: {exc.reason}") from exc
        return json.loads(raw) if raw else None

    def get_issue(self, issue_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/issues/{issue_id}")

    def get_document(self, issue_id: str, key: str) -> Optional[dict[str, Any]]:
        try:
            return self._request("GET", f"/api/issues/{issue_id}/documents/{key}")
        except WriteRefused:
            return None

    def put_document(self, issue_id: str, key: str, body: str, change_summary: str,
                     base_revision_id: Optional[str] = None) -> Any:
        payload: dict[str, Any] = {
            "title": DOCUMENT_TITLE,
            "format": "markdown",
            "body": body,
            "changeSummary": change_summary[:500],
        }
        # Updates to an existing document are guarded by optimistic concurrency; the API
        # rejects a blind overwrite with 409. Creates must omit the field entirely.
        if base_revision_id:
            payload["baseRevisionId"] = base_revision_id
        return self._request("PUT", f"/api/issues/{issue_id}/documents/{key}", payload)

    def patch_issue(self, issue_id: str, patch: dict[str, Any]) -> Any:
        return self._request("PATCH", f"/api/issues/{issue_id}", patch)

    def comment(self, issue_id: str, body: str) -> Any:
        return self._request("POST", f"/api/issues/{issue_id}/comments", {"body": body})


# --------------------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------------------


def _merge_states(local: SweepState, remote: SweepState) -> SweepState:
    """Union two views of the same sweep, never losing recorded progress.

    Progress is monotonic -- an item only ever moves from pending toward terminal -- so a
    terminal state on either side wins. That makes the merge order-independent and safe to
    apply whichever writer lands second.
    """
    by_key = {item.key: item for item in remote.items}
    merged: list[WorkItem] = []
    for item in local.items:
        other = by_key.pop(item.key, None)
        if other is None:
            merged.append(item)
            continue
        if item.terminal:
            winner = item
        elif other.terminal:
            winner = other
        else:
            winner = item
            winner.attempts = max(item.attempts, other.attempts)
        merged.append(winner)
    merged.extend(by_key.values())  # items only the other writer knew about
    local.items = merged
    local.heartbeats = max(local.heartbeats, remote.heartbeats)
    return local


@dataclass
class SweepResult:
    applied: int = 0
    skipped: int = 0
    failed: int = 0
    parked: int = 0
    writes_used: int = 0
    stopped_for_budget: bool = False
    complete: bool = False
    remaining: int = 0
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        bits = [
            f"applied={self.applied}",
            f"already-satisfied={self.skipped}",
            f"failed={self.failed}",
            f"parked={self.parked}",
            f"writes={self.writes_used}",
            f"remaining={self.remaining}",
        ]
        if self.stopped_for_budget:
            bits.append("stopped=budget")
        if self.complete:
            bits.append("complete")
        return " ".join(bits)


class Sweeper:
    """Applies a persisted worklist idempotently, within budget, resuming across heartbeats."""

    def __init__(self, client: PaperclipClient, source_issue_id: str, document_key: str = DOCUMENT_KEY):
        self.client = client
        self.source_issue_id = source_issue_id
        self.document_key = document_key
        self._base_revision_id: Optional[str] = None

    # -- durable state -----------------------------------------------------------

    def load(self) -> Optional[SweepState]:
        doc = self.client.get_document(self.source_issue_id, self.document_key)
        if not doc:
            self._base_revision_id = None
            return None
        self._base_revision_id = doc.get("latestRevisionId") if isinstance(doc, dict) else None
        body = doc.get("body") if isinstance(doc, dict) else None
        return SweepState.from_document(body or "")

    def save(self, state: SweepState, change_summary: str) -> None:
        """Checkpoint the worklist, resolving a concurrent-writer conflict by merging.

        Losing a checkpoint to a 409 would be silent data loss: the writes already landed
        on the board but the record of them would not, so the next heartbeat would replan
        work that is already done. Verification would still prevent duplicate writes, but
        the sweep would waste a heartbeat rediscovering that.
        """
        state.updated_at = _utcnow()
        try:
            doc = self.client.put_document(
                self.source_issue_id, self.document_key, state.to_document(),
                change_summary, self._base_revision_id,
            )
        except WriteRefused as exc:
            if "requires baseRevisionId" not in str(exc) and "409" not in str(exc):
                raise
            remote = self.load()  # refreshes self._base_revision_id
            merged = _merge_states(state, remote) if remote else state
            state.items = merged.items
            state.heartbeats = merged.heartbeats
            doc = self.client.put_document(
                self.source_issue_id, self.document_key, state.to_document(),
                f"{change_summary} (merged concurrent edit)", self._base_revision_id,
            )
        if isinstance(doc, dict):
            self._base_revision_id = doc.get("latestRevisionId") or self._base_revision_id

    def plan(self, sweep_id: str, items: Iterable[WorkItem], cap: int = DEFAULT_CAP,
             reserve: int = DEFAULT_RESERVE, force: bool = False) -> SweepState:
        """Persist a new worklist. Refuses to clobber a sweep still in progress.

        The whole worklist is written *before* any repair, so a run that dies immediately
        after planning still leaves a complete resume point rather than a half-repaired
        board with no record of what was intended.
        """
        existing = self.load()
        if existing and not existing.complete and not force:
            raise RuntimeError(
                f"sweep {existing.sweep_id} still has {len(existing.pending)} pending items; "
                "resume it or pass force=True"
            )
        state = SweepState(
            sweep_id=sweep_id,
            source_issue_id=self.source_issue_id,
            items=list(items),
            cap=cap,
            reserve=reserve,
        )
        self.save(state, f"plan sweep {sweep_id}: {len(state.items)} intended writes")
        return state

    # -- application -------------------------------------------------------------

    def _apply_one(self, item: WorkItem) -> None:
        if item.op == "patch_issue":
            self.client.patch_issue(item.target_issue_id, item.payload)
        elif item.op == "comment":
            self.client.comment(item.target_issue_id, item.payload.get("body", ""))
        else:
            raise WriteRefused(f"unsupported op {item.op!r}")

    def run(self, state: Optional[SweepState] = None,
            on_progress: Optional[Callable[[WorkItem, str], None]] = None) -> tuple[SweepState, SweepResult]:
        """Apply as much of the worklist as the budget allows, then checkpoint and exit.

        Never raises for an individual write failure: a bad item is recorded and the sweep
        moves on, because the alternative is one poison target stranding every other repair.
        """
        state = state or self.load()
        result = SweepResult()
        if state is None:
            result.errors.append("no persisted worklist; nothing to resume")
            return SweepState(sweep_id="none", source_issue_id=self.source_issue_id), result

        state.heartbeats += 1
        budget = state.budget
        dirty = False

        for item in state.items:
            if item.terminal:
                continue

            # Verify first: if the repair already landed (previous heartbeat wrote it but
            # died before checkpointing), record it without spending a write.
            if item.verify:
                try:
                    live = self.client.get_issue(item.target_issue_id)
                except WriteRefused as exc:
                    item.attempts += 1
                    item.last_error = f"read failed: {exc}"
                    result.failed += 1
                    result.errors.append(f"{item.target_identifier}: {item.last_error}")
                    dirty = True
                    if item.attempts >= MAX_ATTEMPTS:
                        item.state = FAILED_PERMANENT
                        result.parked += 1
                    continue
                if item.satisfied_by(live):
                    item.state = SKIPPED
                    item.note = "already satisfied on target"
                    item.applied_at = _utcnow()
                    result.skipped += 1
                    dirty = True
                    if on_progress:
                        on_progress(item, SKIPPED)
                    continue

            # Budget gate: stop *before* the write that would trip the cap, not after.
            if result.writes_used >= budget:
                result.stopped_for_budget = True
                break

            try:
                self._apply_one(item)
            except WriteRefused as exc:
                item.last_error = str(exc)
                dirty = True
                if exc.cap_shaped:
                    # Budget problem, not a bad item. A rejected attempt does not consume
                    # budget (it is logged under a separate _cap_rejected action that the
                    # counter ignores), so do not charge it here -- but the counter is
                    # already at the cap, so retrying this heartbeat cannot succeed.
                    # Checkpoint and let the next heartbeat start with a fresh allowance.
                    item.note = "deferred: cap refusal"
                    result.stopped_for_budget = True
                    result.errors.append(f"{item.target_identifier}: {exc}")
                    break
                # Any other failure did reach the mutation path; assume it was charged,
                # since the cap charges before the write and never refunds.
                result.writes_used += 1
                item.attempts += 1
                result.failed += 1
                result.errors.append(f"{item.target_identifier}: {exc}")
                if item.attempts >= MAX_ATTEMPTS:
                    item.state = FAILED_PERMANENT
                    item.note = f"parked after {item.attempts} attempts"
                    result.parked += 1
                    if on_progress:
                        on_progress(item, FAILED_PERMANENT)
                continue

            result.writes_used += 1
            item.state = DONE
            item.applied_at = _utcnow()
            item.last_error = None
            dirty = True
            result.applied += 1
            if on_progress:
                on_progress(item, DONE)

        result.remaining = len(state.pending)
        result.complete = state.complete
        if result.complete and not state.completed_at:
            state.completed_at = _utcnow()
            dirty = True

        # Always checkpoint when anything moved. This is the reserve budget's job.
        if dirty:
            self.save(state, f"heartbeat {state.heartbeats}: {result.summary()}")
        return state, result


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def _client_from_env(args: argparse.Namespace) -> PaperclipClient:
    base = args.api_url or os.environ.get("PAPERCLIP_API_URL")
    key = os.environ.get("PAPERCLIP_API_KEY")
    if not base or not key:
        print("PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set", file=sys.stderr)
        raise SystemExit(2)
    return PaperclipClient(base, key, os.environ.get("PAPERCLIP_RUN_ID"))


def _items_from_file(path: str) -> list[WorkItem]:
    with open(path) as fh:
        raw = json.load(fh)
    known = {f for f in WorkItem.__dataclass_fields__}
    return [WorkItem(**{k: v for k, v in entry.items() if k in known}) for entry in raw]


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api-url")
    parser.add_argument("--source-issue", default=os.environ.get("PAPERCLIP_TASK_ID"),
                        help="issue holding the durable worklist document")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_plan = sub.add_parser("plan", help="persist a new worklist from a JSON file")
    p_plan.add_argument("items_file")
    p_plan.add_argument("--sweep-id", required=True)
    p_plan.add_argument("--cap", type=int, default=DEFAULT_CAP)
    p_plan.add_argument("--reserve", type=int, default=DEFAULT_RESERVE)
    p_plan.add_argument("--force", action="store_true")

    sub.add_parser("apply", help="apply/resume the persisted worklist within budget")
    sub.add_parser("status", help="print the current resume point")
    sub.add_parser("reset", help="clear the worklist (marks the sweep complete)")

    args = parser.parse_args(argv)
    if not args.source_issue:
        print("--source-issue (or PAPERCLIP_TASK_ID) is required", file=sys.stderr)
        return 2

    sweeper = Sweeper(_client_from_env(args), args.source_issue)

    if args.cmd == "plan":
        state = sweeper.plan(args.sweep_id, _items_from_file(args.items_file),
                             cap=args.cap, reserve=args.reserve, force=args.force)
        print(f"planned {len(state.items)} items for sweep {state.sweep_id} "
              f"(budget {state.budget}/heartbeat)")
        return 0

    if args.cmd == "apply":
        state, result = sweeper.run()
        print(result.summary())
        for err in result.errors:
            print(f"  ! {err}", file=sys.stderr)
        # Exit 0 while converging: an unfinished sweep is the expected steady state, not
        # a failure. Only a missing worklist is an error.
        return 1 if not state.items and result.errors else 0

    if args.cmd == "status":
        state = sweeper.load()
        if not state:
            print("no worklist")
            return 0
        print(f"sweep {state.sweep_id}: {state.counts()} "
              f"(heartbeats={state.heartbeats}, budget={state.budget})")
        for item in state.pending:
            print(f"  pending {item.target_identifier} {item.op} attempts={item.attempts}")
        return 0

    if args.cmd == "reset":
        state = sweeper.load()
        if not state:
            print("no worklist")
            return 0
        state.completed_at = _utcnow()
        for item in state.pending:
            item.state = SKIPPED
            item.note = "cleared by reset"
        sweeper.save(state, "reset worklist")
        print("worklist cleared")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())

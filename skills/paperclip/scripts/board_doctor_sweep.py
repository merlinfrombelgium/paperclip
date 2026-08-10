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
   refusal is now known to be a clean, catchable per-write 429 (see the constants
   below), but staying inside the budget is still the primary mechanism: a refusal
   costs a wasted round trip and, before the enforcement date, is not even observable.

   Counting is per *gated write*, not per work item -- see ``WorkItem.cost``. A
   ``patch_issue`` that carries a ``comment`` field trips the counter twice.

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
#
# Note it cannot be *observed* before CAP_ENFORCE_AT: the shipped code derives
# ``mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only"`` and returns
# ``allowed: true`` unconditionally while log_only. Overshooting the cap today is silent;
# on 2026-08-11 the same sweep starts losing every write past the 20th. So the budget
# gate, not the refusal handler, is what has to be right.
CAP_REFUSAL_CODE = "cross_issue_influence_cap_exceeded"
CAP_ENFORCE_AT = "2026-08-11T00:00:00.000Z"

# Gated write surfaces, read off routes/issues.js in the shipped build. There are exactly
# three, and PATCH accounts for two of them:
#   PATCH /api/issues/:id  -> "update" when any field changes, AND a separate "comment"
#                             observation when the body carries a `comment` field
#   POST  /api/issues/:id/comments -> "comment"
# So folding a per-card note into the PATCH does not save budget -- it is two counter
# trips either way. Issue documents and issue creation are not gated at all.
COST_UPDATE = 1
COST_COMMENT = 1

# The blocker set is not a plain field: a status transition is validated against the
# blocker set as it was *before* the request, so clearing blockers and closing the issue
# cannot share a PATCH. See ``payload_defect`` and ``unblock_and_close``.
BLOCKER_FIELD = "blockedByIssueIds"

# A single item that keeps failing must not wedge the sweep forever. After this many
# heartbeats it is parked as failed_permanent and surfaced for board action.
MAX_ATTEMPTS = 3

# Enumerating the board is the first thing a mass-repair planner gets wrong, and it fails
# silently. Verified live against the shipped API (2026-08-08, ZIM-2072):
#   * `limit` is capped server-side at 1000. `?limit=3000` returns exactly 1000 rows with
#     no field, header or envelope saying anything was withheld.
#   * `offset` works and pages are disjoint. `cursor` is silently ignored -- `?cursor=500`
#     returns page 1 again, with a 200.
#   * On the board at the time: one max-limit request saw 1000 of 2131 issues, and 110 of
#     183 `blocked` cards. A planner that scans once sees 60% of the population it is
#     reasoning about and has no way to tell from the response.
# Rows are returned newest-touched first, so a target updated mid-walk can move to an
# earlier page and be skipped by the walk entirely. Dedupe fixes duplicates; nothing fixes
# skips. That is why the sweep re-plans from a fresh scan every heartbeat and why
# "absent from the worklist" never means "nothing to repair here".
LIST_PAGE_SIZE = 500
LIST_MAX_PAGES = 40

# A repair predicate that matches most of the population it was run over is a broken
# detector, not a backlog. Observed on ZIM-2072 (2026-08-07): reading the *write* key
# ``blockedByIssueIds`` returns None for every issue -- the read key is ``blockedBy`` --
# so a zombie-blocker planner scored 73 of 73 blocked cards as repairable and would have
# planned a 146-unit sweep of live, correctly-blocked work. Every other safety mechanism
# here would have let it through: the items were well-formed, individually verifiable and
# properly budgeted. Only their diagnosis was wrong.
DEFAULT_MAX_TARGET_FRACTION = 0.5
GUARD_MIN_TARGETS = 5

# The other way a well-formed worklist is wrong: the state it calls stale was set on
# purpose, minutes ago, by somebody else. Observed on ZIM-2072 (2026-08-08): a scan found
# 58 blocked cards with no blocker edge -- 116 cap units, comfortably >budget and only 32%
# of the bucket, so the fraction guard admits it. Roughly 40 of them had been moved to
# `blocked` that same morning by another agent's ZIM-2112 aging-rule sweep, each with a
# deliberate board-gated wait. Sweeping them would have reverted a hours-old decision at
# scale, and raced the agent still working the bucket.
#
# Drift worth repairing is old. A cool-off costs a heartbeat or two of latency on genuine
# drift and buys immunity to every concurrent writer on the board.
DEFAULT_COOLOFF_HOURS = 24

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

    ``depends_on`` names another item's ``key`` that must reach a terminal, non-failed
    state first. It exists because some repairs are only legal as an ordered pair -- see
    ``unblock_and_close`` -- and the second half must never be attempted before the first
    half has actually landed.
    """

    key: str
    target_issue_id: str
    target_identifier: str
    op: str
    payload: dict[str, Any] = field(default_factory=dict)
    verify: dict[str, Any] = field(default_factory=dict)
    depends_on: Optional[str] = None
    state: str = PENDING
    attempts: int = 0
    last_error: Optional[str] = None
    applied_at: Optional[str] = None
    note: Optional[str] = None

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def cost(self) -> int:
        """How many cap units applying this item consumes.

        The counter is per gated write, not per item. A ``patch_issue`` whose payload
        carries a ``comment`` passes through two separate cap checks on the same request
        -- one for the field update, one for the comment -- so it costs 2. Counting it as
        1 would let a 20-item sweep attempt 40 writes and silently lose half of them once
        enforcement is live.
        """
        if self.op == "patch_issue":
            fields = {k: v for k, v in self.payload.items() if k != "comment"}
            cost = COST_UPDATE if fields else 0
            if self.payload.get("comment"):
                cost += COST_COMMENT
            return max(1, cost)
        return COST_COMMENT if self.op == "comment" else 1

    def satisfied_by(self, issue: dict[str, Any]) -> bool:
        """True when the live target already shows the repaired state."""
        if not self.verify:
            return False
        return all(issue.get(k) == v for k, v in self.verify.items())


def payload_defect(op: str, payload: dict[str, Any]) -> Optional[str]:
    """Describe why a payload cannot land as a single write, or None if it is fine.

    Observed live on ZIM-1880 (2026-08-07): a ``PATCH`` that both clears the blocker set
    and moves the status is refused with ``Issue follow-up blocked by unresolved
    blockers``, because the transition is validated against the *pre-existing* blocker
    set rather than the set in the same request body. It has to be two ordered writes.
    """
    if op != "patch_issue":
        return None
    if BLOCKER_FIELD in payload and "status" in payload:
        return (
            f"a single PATCH cannot clear {BLOCKER_FIELD} and set status in one request: "
            "the transition is validated against the pre-existing blocker set. "
            "Use unblock_and_close() to emit the two ordered writes."
        )
    return None


def detector_fault(items: Iterable["WorkItem"], population: Optional[int],
                   max_fraction: float = DEFAULT_MAX_TARGET_FRACTION,
                   min_targets: int = GUARD_MIN_TARGETS) -> Optional[str]:
    """Describe why a worklist looks like a broken predicate, or None if it looks sane.

    Verify-before-write cannot catch this class of error. It asks "has this repair already
    landed?", never "should this repair happen at all" -- so a worklist built from a
    predicate that is simply wrong passes every check and lands every write.

    The population-fraction heuristic is the cheapest available proxy: real drift on a
    tended board is a minority of any bucket, so a predicate claiming most of what it
    scanned is far more likely to be reading the wrong field than to have found that the
    board is mostly broken. Pass ``population=None`` to opt out (and lose the guard).
    """
    targets = {i.target_issue_id for i in items}
    if population is None or population <= 0 or len(targets) < min_targets:
        return None
    fraction = len(targets) / population
    if fraction <= max_fraction:
        return None
    return (
        f"worklist covers {len(targets)} of {population} scanned cards "
        f"({fraction:.0%} > {max_fraction:.0%} threshold). A predicate that matches most "
        "of its population is far more likely to be reading the wrong field than to have "
        "found a board that is mostly broken -- re-check the detector against a handful "
        "of targets by hand before sweeping. Pass force=True to override."
    )


def _parse_ts(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def apply_cooloff(candidates: Iterable[dict[str, Any]],
                  min_age_hours: float = DEFAULT_COOLOFF_HOURS,
                  now: Optional[datetime] = None,
                  field_name: str = "updatedAt") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split scanned candidates into ``(sweepable, too_fresh)`` by last-touched age.

    Call this on the scan output *before* building work items. A card someone else wrote
    minutes ago is not drift -- it is a decision, or an agent mid-sweep -- and repairing it
    races a live writer. Candidates with no parseable timestamp are treated as too fresh:
    the safe reading of "I cannot tell how old this is" is "do not mass-write it".

    Returns both halves on purpose. Report what was withheld; a guard that silently shrinks
    a worklist reads exactly like a board that had nothing wrong with it.
    """
    now = now or datetime.now(timezone.utc)
    sweepable: list[dict[str, Any]] = []
    too_fresh: list[dict[str, Any]] = []
    for issue in candidates:
        touched = _parse_ts(issue.get(field_name))
        if touched is None or (now - touched).total_seconds() < min_age_hours * 3600:
            too_fresh.append(issue)
        else:
            sweepable.append(issue)
    return sweepable, too_fresh


def unblock_and_close(target_issue_id: str, target_identifier: str, key_prefix: str,
                      status: str = "done") -> list[WorkItem]:
    """The canonical zombie-blocker repair, as the two ordered writes it actually is.

    This is a **2 cap unit** repair, not 1. Planning it as one item under-counts the
    commonest thing the sweep does: a 10-target zombie pass budgeted at 10 units would
    attempt 20 writes and, once enforcement is live, silently lose everything past the
    cap -- the exact half-repaired state this engine exists to prevent.

    Both halves verify against the *final* status, so a target someone else already
    closed costs no writes at all.
    """
    verify = {"status": status}
    clear = WorkItem(
        key=f"{key_prefix}:unblock",
        target_issue_id=target_issue_id,
        target_identifier=target_identifier,
        op="patch_issue",
        payload={BLOCKER_FIELD: []},
        verify=verify,
    )
    close = WorkItem(
        key=f"{key_prefix}:close",
        target_issue_id=target_issue_id,
        target_identifier=target_identifier,
        op="patch_issue",
        payload={"status": status},
        verify=verify,
        depends_on=clear.key,
    )
    return [clear, close]


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
    # How many cards the planner scanned to produce this worklist. Recorded so a reader of
    # the document can see the denominator the detector-fault guard was checked against.
    population: Optional[int] = None

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

    # -- dependencies --------------------------------------------------------------

    def by_key(self, key: str) -> Optional[WorkItem]:
        for item in self.items:
            if item.key == key:
                return item
        return None

    def pending_dependents(self, key: str) -> list[WorkItem]:
        """Every still-pending item that transitively waits on ``key``."""
        out: list[WorkItem] = []
        frontier = {key}
        while frontier:
            nxt: set[str] = set()
            for item in self.items:
                if item.terminal or item in out:
                    continue
                if item.depends_on in frontier:
                    out.append(item)
                    nxt.add(item.key)
            frontier = nxt
        return out

    def chain_cost(self, item: WorkItem) -> int:
        """Cost of applying ``item`` *and* everything still waiting on it.

        Admission is charged against the whole chain so an ordered pair can never be
        split across a budget boundary. Stopping between "blockers cleared" and "status
        closed" would leave exactly the half-repaired target this engine promises not to.
        """
        return item.cost + sum(d.cost for d in self.pending_dependents(item.key))

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
        if self.population:
            targets = len({i.target_issue_id for i in self.items})
            lines.append(
                f"- Targets: {targets} of {self.population} scanned "
                f"({targets / self.population:.0%} of population)"
            )
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

    def list_issues(self, company_id: str, page_size: int = LIST_PAGE_SIZE,
                    max_pages: int = LIST_MAX_PAGES) -> list[dict[str, Any]]:
        """Every issue on the board, walked with ``offset`` until a short page.

        Never raise the page size to "just get them all" -- the server caps ``limit`` at
        1000 and says nothing when it truncates, so a single big request quietly returns a
        partial board that a planner then treats as the whole population. See the
        LIST_PAGE_SIZE notes above for the measured shortfall.
        """
        out: dict[str, dict[str, Any]] = {}
        for page in range(max_pages):
            offset = page * page_size
            raw = self._request(
                "GET",
                f"/api/companies/{company_id}/issues?limit={page_size}&offset={offset}",
            )
            rows = raw.get("issues", []) if isinstance(raw, dict) else (raw or [])
            for row in rows:
                key = row.get("id") or row.get("identifier")
                if key:
                    out[key] = row
            if len(rows) < page_size:
                return list(out.values())
        raise WriteRefused(
            f"issue list did not terminate within {max_pages} pages of {page_size}; "
            "refusing to plan against a population that is known to be truncated"
        )

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
             reserve: int = DEFAULT_RESERVE, force: bool = False,
             population: Optional[int] = None,
             max_target_fraction: float = DEFAULT_MAX_TARGET_FRACTION) -> SweepState:
        """Persist a new worklist. Refuses to clobber a sweep still in progress.

        The whole worklist is written *before* any repair, so a run that dies immediately
        after planning still leaves a complete resume point rather than a half-repaired
        board with no record of what was intended.

        ``population`` is how many cards the planner scanned to build ``items``; passing it
        turns on the detector-fault guard, which is the only check here that questions the
        diagnosis rather than the mechanics of a write.
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
            population=population,
        )
        if not force:
            fault = detector_fault(state.items, population, max_target_fraction)
            if fault:
                raise ValueError(f"sweep {sweep_id} refused: {fault}")
        # Reject writes the platform is known to refuse at plan time rather than
        # discovering it at the boundary, where it costs an attempt and a round trip.
        for item in state.items:
            defect = payload_defect(item.op, item.payload)
            if defect:
                raise ValueError(f"{item.target_identifier} ({item.key}): {defect}")
            if item.depends_on and state.by_key(item.depends_on) is None:
                raise ValueError(
                    f"{item.target_identifier} ({item.key}): depends_on "
                    f"{item.depends_on!r} is not in the worklist"
                )
        self.save(state, f"plan sweep {sweep_id}: {len(state.items)} intended writes")
        return state

    # -- application -------------------------------------------------------------

    def _apply_one(self, item: WorkItem) -> None:
        # Also guarded at plan time; repeated here because a worklist can arrive from a
        # persisted document written by an older build.
        defect = payload_defect(item.op, item.payload)
        if defect:
            raise WriteRefused(defect)
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

            # Ordered pairs: never attempt the second half before the first has landed.
            if item.depends_on:
                prereq = state.by_key(item.depends_on)
                if prereq is None or prereq.state == FAILED_PERMANENT:
                    reason = "missing" if prereq is None else "failed"
                    item.state = FAILED_PERMANENT
                    item.note = f"prerequisite {item.depends_on} {reason}"
                    item.last_error = item.note
                    result.parked += 1
                    dirty = True
                    if on_progress:
                        on_progress(item, FAILED_PERMANENT)
                    continue
                if not prereq.terminal:
                    # Prerequisite is earlier in the list, so it was tried and failed
                    # transiently this pass. It parks after MAX_ATTEMPTS, so this converges.
                    continue

            # An item costing more than a whole heartbeat's budget can never be applied,
            # and would otherwise re-trip the gate forever without converging. Park it,
            # along with anything waiting on it, which is equally unreachable.
            chain = state.chain_cost(item)
            if chain > budget:
                for doomed in [item] + state.pending_dependents(item.key):
                    doomed.state = FAILED_PERMANENT
                    doomed.note = f"chain costs {chain} cap units, budget is {budget}"
                    doomed.last_error = doomed.note
                    result.parked += 1
                    if on_progress:
                        on_progress(doomed, FAILED_PERMANENT)
                dirty = True
                continue

            # Budget gate: stop *before* the write that would trip the cap, not after.
            # Charged in cap units over the whole dependent chain, so a patch-plus-comment
            # item needs two free and an unblock-and-close pair needs both halves free.
            if result.writes_used + chain > budget:
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
                result.writes_used += item.cost
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

            result.writes_used += item.cost
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
    p_plan.add_argument("--population", type=int, default=None,
                        help="cards scanned to build this worklist; enables the "
                             "detector-fault guard")
    p_plan.add_argument("--max-target-fraction", type=float,
                        default=DEFAULT_MAX_TARGET_FRACTION)

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
                             cap=args.cap, reserve=args.reserve, force=args.force,
                             population=args.population,
                             max_target_fraction=args.max_target_fraction)
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

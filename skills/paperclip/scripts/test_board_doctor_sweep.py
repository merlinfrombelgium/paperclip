#!/usr/bin/env python3
"""Tests for the Board Doctor checkpoint + resume sweep engine.

Run: python3 -m unittest skills.paperclip.scripts.test_board_doctor_sweep -v
     (or: python3 skills/paperclip/scripts/test_board_doctor_sweep.py)

The fake board below is the point of the exercise: it enforces a hard write cap with a
selectable refusal mode. The real contract is now known (429 +
details.code=cross_issue_influence_cap_exceeded, returned before the mutation), but the
suite keeps the silent-no-op and mid-run-abort modes too -- they cost nothing and pin down
behaviour if the contract ever shifts.
"""

from __future__ import annotations

import os
import sys
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from board_doctor_sweep import (  # noqa: E402
    DONE,
    FAILED_PERMANENT,
    MAX_ATTEMPTS,
    PENDING,
    SKIPPED,
    SweepState,
    Sweeper,
    WorkItem,
    WriteRefused,
)


class FakeBoard:
    """In-memory control plane with a hard per-heartbeat write cap.

    ``refusal`` selects what happens on the write that exceeds the cap:
      "error"  -- clean per-write error (cap-shaped)
      "silent" -- accepted by the API but not actually applied
      "abort"  -- the whole run dies mid-sweep
    """

    def __init__(self, issues: dict, cap: int = 10, refusal: str = "error"):
        self.issues = issues
        # key -> {"body": str, "rev": str}; mirrors the real API's optimistic concurrency
        self.docs: dict[tuple[str, str], dict] = {}
        self.cap = cap
        self.refusal = refusal
        self.writes = 0
        self.write_log: list[tuple[str, str]] = []  # (issue_id, op) -- target writes only
        self.doc_writes = 0
        self._rev = 0

    # -- reads (never capped) ----------------------------------------------------

    def get_issue(self, issue_id):
        if issue_id not in self.issues:
            raise WriteRefused(f"HTTP 404 GET {issue_id}")
        return dict(self.issues[issue_id])

    def get_document(self, issue_id, key):
        doc = self.docs.get((issue_id, key))
        if doc is None:
            return None
        return {"body": doc["body"], "latestRevisionId": doc["rev"]}

    # -- writes ------------------------------------------------------------------

    def put_document(self, issue_id, key, body, change_summary, base_revision_id=None):
        # Same-issue document writes are the checkpoint channel; they are not
        # cross-issue influence and so are not capped here. They *are* revision-guarded,
        # exactly as the real endpoint is.
        existing = self.docs.get((issue_id, key))
        if existing is not None and base_revision_id != existing["rev"]:
            raise WriteRefused(
                f'HTTP 409 PUT: {{"error":"Document update requires baseRevisionId",'
                f'"details":{{"currentRevisionId":"{existing["rev"]}"}}}}'
            )
        self._rev += 1
        rev = f"rev-{self._rev}"
        self.docs[(issue_id, key)] = {"body": body, "rev": rev}
        self.doc_writes += 1
        return {"latestRevisionId": rev}

    def _spend(self, issue_id, op):
        self.writes += 1
        if self.writes > self.cap:
            if self.refusal == "error":
                raise WriteRefused("HTTP 429 cross-issue influence cap exceeded", cap_shaped=True)
            if self.refusal == "abort":
                raise SystemExit("run aborted by control plane")
            if self.refusal == "silent":
                return False  # accepted, not applied
        self.write_log.append((issue_id, op))
        return True

    def patch_issue(self, issue_id, patch):
        # Mirrors the shipped route: the field update and the optional `comment` on the
        # same PATCH are two separate cap observations, both taken before any mutation.
        fields = {k: v for k, v in patch.items() if k != "comment"}
        applied = True
        if fields:
            applied = self._spend(issue_id, "patch")
        if patch.get("comment"):
            applied = self._spend(issue_id, "comment") and applied
        if applied and fields:
            self.issues.setdefault(issue_id, {}).update(fields)
        return {"ok": True}

    def comment(self, issue_id, body):
        self._spend(issue_id, "comment")
        return {"ok": True}


def make_items(n, start=1):
    return [
        WorkItem(
            key=f"ZIM-{start + i}:status:blocked",
            target_issue_id=f"issue-{start + i}",
            target_identifier=f"ZIM-{start + i}",
            op="patch_issue",
            payload={"status": "blocked"},
            verify={"status": "blocked"},
        )
        for i in range(n)
    ]


def make_board(n, cap=10, refusal="error", start=1):
    issues = {f"issue-{start + i}": {"id": f"issue-{start + i}", "status": "in_progress"} for i in range(n)}
    issues["source"] = {"id": "source", "status": "in_progress"}
    return FakeBoard(issues, cap=cap, refusal=refusal)


class StateSerialisationTests(unittest.TestCase):
    def test_document_round_trip_preserves_resume_point(self):
        state = SweepState(sweep_id="s1", source_issue_id="source", items=make_items(3))
        state.items[0].state = DONE
        state.items[1].attempts = 2
        state.items[1].last_error = "HTTP 500"
        state.heartbeats = 4

        restored = SweepState.from_document(state.to_document())

        self.assertIsNotNone(restored)
        self.assertEqual(restored.sweep_id, "s1")
        self.assertEqual(restored.heartbeats, 4)
        self.assertEqual([i.state for i in restored.items], [DONE, PENDING, PENDING])
        self.assertEqual(restored.items[1].attempts, 2)
        self.assertEqual(restored.items[1].last_error, "HTTP 500")
        self.assertEqual(len(restored.pending), 2)

    def test_document_is_human_readable_and_machine_readable(self):
        body = SweepState(sweep_id="s1", source_issue_id="source", items=make_items(2)).to_document()
        self.assertIn("| ZIM-1 | patch_issue | pending |", body)
        self.assertIn("```json", body)

    def test_corrupt_or_missing_block_returns_none(self):
        self.assertIsNone(SweepState.from_document("no json here"))
        self.assertIsNone(SweepState.from_document("```json\n{not valid}\n```"))
        self.assertIsNone(SweepState.from_document(""))

    def test_unknown_fields_are_ignored_on_load(self):
        """Forward compatibility: a newer writer's extra fields must not crash an older reader."""
        state = SweepState.from_json({
            "sweep_id": "s1", "source_issue_id": "source", "future_field": 1,
            "items": [{"key": "k", "target_issue_id": "i", "target_identifier": "ZIM-1",
                       "op": "patch_issue", "unexpected": True}],
        })
        self.assertEqual(state.sweep_id, "s1")
        self.assertEqual(len(state.items), 1)


class BudgetTests(unittest.TestCase):
    def test_stops_before_reaching_the_cap(self):
        board = make_board(30, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(30), cap=20, reserve=2)

        _, result = sweeper.run()

        self.assertTrue(result.stopped_for_budget)
        self.assertEqual(result.applied, 18)  # cap 20 - reserve 2
        self.assertLess(board.writes, board.cap, "must stop below the cap, not at it")

    def test_reserve_leaves_room_for_the_checkpoint(self):
        board = make_board(30, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(30), cap=20, reserve=2)
        sweeper.run()

        # The checkpoint landed and reflects the real resume point.
        restored = sweeper.load()
        self.assertIsNotNone(restored)
        self.assertEqual(len(restored.pending), 12)
        self.assertEqual(board.cap - board.writes, 2, "reserve must remain unspent")


class WriteCostTests(unittest.TestCase):
    """A PATCH carrying a comment trips the cap counter twice, so it must cost two.

    Counting it as one is the failure that matters: the engine would think it had spent
    18 of 20 while the control plane had actually seen 36, and every write past the 20th
    would be lost once enforcement is live.
    """

    @staticmethod
    def _patch_with_comment(n, start=1):
        items = make_items(n, start=start)
        for it in items:
            it.payload = {"status": "blocked", "comment": "repaired by Board Doctor"}
        return items

    def test_cost_reflects_the_gated_surfaces(self):
        plain, = make_items(1)
        self.assertEqual(plain.cost, 1)

        with_comment, = self._patch_with_comment(1)
        self.assertEqual(with_comment.cost, 2)

        comment_only = WorkItem(key="k", target_issue_id="i", target_identifier="ZIM-1",
                                op="comment", payload={"body": "hi"})
        self.assertEqual(comment_only.cost, 1)

        # A PATCH carrying only a comment is a single comment observation, not two.
        bare = WorkItem(key="k", target_issue_id="i", target_identifier="ZIM-1",
                        op="patch_issue", payload={"comment": "hi"})
        self.assertEqual(bare.cost, 1)

    def test_budget_is_charged_in_cap_units_not_items(self):
        board = make_board(30, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", self._patch_with_comment(30), cap=20, reserve=2)

        _, result = sweeper.run()

        # 18 units of budget at 2 units per item = 9 items, 18 real writes.
        self.assertEqual(result.applied, 9)
        self.assertEqual(result.writes_used, 18)
        self.assertEqual(board.writes, 18, "engine's count must match the control plane's")
        self.assertLess(board.writes, board.cap)

    def test_converges_and_writes_each_target_once_at_two_units_per_item(self):
        board = make_board(25, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", self._patch_with_comment(25), cap=20, reserve=2)

        for _ in range(10):
            state, result = sweeper.run()
            board.writes = 0  # new heartbeat, fresh allowance
            if result.complete:
                break

        self.assertTrue(result.complete)
        self.assertEqual(len(state.pending), 0)
        patched = [e for e in board.write_log if e[1] == "patch"]
        self.assertEqual(len(patched), 25)
        self.assertEqual(len(set(patched)), 25, "no target may be patched twice")

    def test_item_costing_more_than_the_budget_is_parked_not_looped(self):
        board = make_board(2, cap=1)
        sweeper = Sweeper(board, "source")
        # budget 1, item cost 2 -- unapplicable, and must not wedge the sweep.
        sweeper.plan("s1", self._patch_with_comment(2), cap=1, reserve=0)

        state, result = sweeper.run()

        self.assertEqual(result.parked, 2)
        self.assertTrue(state.complete)
        self.assertTrue(all(i.state == FAILED_PERMANENT for i in state.items))
        self.assertEqual(board.writes, 0)


class ConvergenceTests(unittest.TestCase):
    """The headline acceptance criterion: a sweep larger than the cap converges."""

    def _converge(self, refusal):
        total = 50
        board = make_board(total, cap=20, refusal=refusal)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(total), cap=20, reserve=2)

        heartbeats = 0
        while heartbeats < 20:
            heartbeats += 1
            board.writes = 0  # each heartbeat gets a fresh allowance
            try:
                state, result = sweeper.run()
            except SystemExit:
                # "abort" mode: the run died mid-sweep. The next heartbeat must recover
                # from whatever the last checkpoint captured.
                continue
            if result.complete:
                return board, heartbeats, sweeper.load()
        self.fail(f"did not converge in {heartbeats} heartbeats (refusal={refusal})")

    def test_converges_under_clean_per_write_error(self):
        board, heartbeats, state = self._converge("error")
        self.assertTrue(state.complete)
        self.assertGreater(heartbeats, 1, "a 50-item sweep must span multiple heartbeats")
        self.assertEqual(len([i for i in state.items if i.terminal]), 50)

    def test_converges_under_silent_failure(self):
        """A silently-dropped write must be caught by verification, not trusted."""
        board, _, state = self._converge("silent")
        self.assertTrue(state.complete)
        for issue_id, issue in board.issues.items():
            if issue_id != "source":
                self.assertEqual(issue["status"], "blocked", f"{issue_id} left unrepaired")

    def test_converges_under_mid_sweep_abort(self):
        board, _, state = self._converge("abort")
        self.assertTrue(state.complete)

    def test_no_duplicate_writes_across_heartbeats(self):
        total = 50
        board = make_board(total, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(total), cap=20, reserve=2)

        for _ in range(20):
            board.writes = 0
            _, result = sweeper.run()
            if result.complete:
                break

        targets = [issue_id for issue_id, _ in board.write_log]
        self.assertEqual(len(targets), len(set(targets)), "a target was written more than once")
        self.assertEqual(len(set(targets)), total)

    def test_every_target_ends_repaired(self):
        total = 35
        board = make_board(total, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(total), cap=20, reserve=2)
        for _ in range(20):
            board.writes = 0
            _, result = sweeper.run()
            if result.complete:
                break
        for i in range(1, total + 1):
            self.assertEqual(board.issues[f"issue-{i}"]["status"], "blocked")


class IdempotencyTests(unittest.TestCase):
    def test_lost_checkpoint_does_not_cause_duplicate_writes(self):
        """The worst case: writes land, then the checkpoint is lost entirely."""
        board = make_board(5, cap=100)
        sweeper = Sweeper(board, "source")
        state = sweeper.plan("s1", make_items(5), cap=100, reserve=2)
        sweeper.run(state)
        self.assertEqual(len(board.write_log), 5)

        # Roll the document back to the freshly-planned state, as if the checkpoint
        # never flushed, and resume.
        board.docs[("source", "board-doctor-worklist")] = {
            "body": SweepState(sweep_id="s1", source_issue_id="source",
                               items=make_items(5)).to_document(),
            "rev": board.docs[("source", "board-doctor-worklist")]["rev"],
        }

        _, result = sweeper.run()

        self.assertEqual(len(board.write_log), 5, "stale checkpoint caused duplicate writes")
        self.assertEqual(result.skipped, 5)
        self.assertEqual(result.applied, 0)
        self.assertTrue(result.complete)

    def test_externally_repaired_target_is_skipped_without_a_write(self):
        board = make_board(3, cap=100)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(3), cap=100, reserve=2)
        board.issues["issue-2"]["status"] = "blocked"  # someone else fixed it

        _, result = sweeper.run()

        self.assertEqual(result.applied, 2)
        self.assertEqual(result.skipped, 1)
        self.assertNotIn(("issue-2", "patch"), board.write_log)

    def test_write_that_landed_but_lost_its_response_is_not_repeated(self):
        """Budget is charged before the write and never refunded, so a lost response means
        the repair may well have landed. Record it as attempted, never as confirmed, and let
        verification settle it on the next heartbeat."""
        board = make_board(3, cap=100)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(3), cap=100, reserve=1)

        real_patch = board.patch_issue

        def patch_then_lose_the_response(issue_id, patch):
            real_patch(issue_id, patch)  # server-side effect happens...
            raise WriteRefused("network error: connection reset")  # ...client never hears

        board.patch_issue = patch_then_lose_the_response
        _, first = sweeper.run()
        self.assertEqual(first.applied, 0, "a lost response must not be recorded as done")

        board.patch_issue = real_patch
        writes_before = len(board.write_log)
        _, second = sweeper.run()

        self.assertEqual(len(board.write_log), writes_before, "re-wrote an already-landed repair")
        self.assertEqual(second.skipped, 3)
        self.assertTrue(second.complete)

    def test_replanning_the_same_condition_yields_stable_keys(self):
        self.assertEqual([i.key for i in make_items(3)], [i.key for i in make_items(3)])


class FailureHandlingTests(unittest.TestCase):
    def test_poison_item_is_parked_and_does_not_wedge_the_sweep(self):
        board = make_board(4, cap=100)
        del board.issues["issue-2"]  # target vanished -> read fails every time
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(4), cap=100, reserve=2)

        for _ in range(MAX_ATTEMPTS + 2):
            board.writes = 0
            state, result = sweeper.run()
            if result.complete:
                break

        self.assertTrue(state.complete)
        bad = next(i for i in state.items if i.target_identifier == "ZIM-2")
        self.assertEqual(bad.state, FAILED_PERMANENT)
        self.assertEqual(len([i for i in state.items if i.state == DONE]), 3,
                         "healthy items must still land alongside a poison one")

    def test_cap_shaped_refusal_defers_rather_than_burning_an_attempt(self):
        board = make_board(10, cap=3, refusal="error")
        sweeper = Sweeper(board, "source")
        # reserve 0 forces the engine past its own guard so the platform refuses first,
        # exercising the refusal path rather than the budget path.
        sweeper.plan("s1", make_items(10), cap=100, reserve=100)
        state = sweeper.load()
        state.cap, state.reserve = 100, 0

        _, result = sweeper.run(state)

        self.assertTrue(result.stopped_for_budget)
        deferred = [i for i in state.items if i.note == "deferred: cap refusal"]
        self.assertEqual(len(deferred), 1)
        self.assertEqual(deferred[0].attempts, 0, "a cap refusal is not the item's fault")
        self.assertEqual(deferred[0].state, PENDING, "deferred item stays on the worklist")

    def test_failed_write_stays_on_the_worklist_as_the_resume_point(self):
        board = make_board(3, cap=100)
        del board.issues["issue-1"]
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(3), cap=100, reserve=2)

        sweeper.run()
        restored = sweeper.load()

        self.assertIn("ZIM-1", [i.target_identifier for i in restored.pending])
        self.assertEqual(restored.items[0].attempts, 1)
        self.assertIsNotNone(restored.items[0].last_error)


class CheckpointConcurrencyTests(unittest.TestCase):
    """The checkpoint channel is revision-guarded; losing it would silently lose progress."""

    def test_repeated_checkpoints_succeed(self):
        """Regression: the second PUT must carry baseRevisionId or the API returns 409."""
        board = make_board(40, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(40), cap=20, reserve=2)

        for _ in range(4):
            board.writes = 0
            sweeper.run()  # must not raise

        self.assertGreaterEqual(board.doc_writes, 4)
        self.assertIsNotNone(sweeper.load())

    def test_concurrent_writer_conflict_is_merged_not_lost(self):
        board = make_board(6, cap=100)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(6), cap=100, reserve=2)
        state = sweeper.load()

        # Another writer checkpoints first, recording item 6 as done. Our in-flight state
        # still has a stale revision, so our save will 409.
        other = Sweeper(board, "source")
        other_state = other.load()
        other_state.items[5].state = DONE
        other.save(other_state, "concurrent writer")

        state.items[0].state = DONE
        sweeper.save(state, "our checkpoint")

        merged = Sweeper(board, "source").load()
        done = {i.target_identifier for i in merged.items if i.state == DONE}
        self.assertEqual(done, {"ZIM-1", "ZIM-6"}, "merge lost a writer's progress")

    def test_merge_is_order_independent(self):
        a = SweepState(sweep_id="s1", source_issue_id="source", items=make_items(4))
        b = SweepState(sweep_id="s1", source_issue_id="source", items=make_items(4))
        a.items[0].state = DONE
        b.items[3].state = SKIPPED

        import copy
        from board_doctor_sweep import _merge_states

        ab = _merge_states(copy.deepcopy(a), copy.deepcopy(b))
        ba = _merge_states(copy.deepcopy(b), copy.deepcopy(a))

        self.assertEqual({i.key: i.state for i in ab.items}, {i.key: i.state for i in ba.items})


class RefusalClassificationTests(unittest.TestCase):
    """Pinned to the verified contract (ZIM-2068): 429 + details.code, checked before prose."""

    def _classify(self, status, body):
        import io
        import urllib.error
        from board_doctor_sweep import PaperclipClient

        client = PaperclipClient("http://x", "k")
        err = urllib.error.HTTPError("http://x", status, "err", {}, io.BytesIO(body.encode()))
        with unittest.mock.patch("urllib.request.urlopen", side_effect=err):
            try:
                client.patch_issue("i", {})
            except WriteRefused as exc:
                return exc.cap_shaped
        self.fail("expected WriteRefused")

    def test_cap_code_is_recognised(self):
        self.assertTrue(self._classify(
            429, '{"error":"limit","details":{"code":"cross_issue_influence_cap_exceeded"}}'))

    def test_other_429_still_treated_as_cap_shaped(self):
        """No structured code: fall back to the status, since deferring is the safe default."""
        self.assertTrue(self._classify(429, '{"error":"slow down"}'))

    def test_ownership_gate_is_not_cap_shaped(self):
        """A permission wall must burn attempts and park -- retrying it can never help."""
        self.assertFalse(self._classify(
            403, '{"error":"forbidden","details":{"code":"issue_mutation_not_allowed"}}'))

    def test_server_error_is_not_cap_shaped(self):
        self.assertFalse(self._classify(500, "internal error"))


class PlanningTests(unittest.TestCase):
    def test_worklist_is_persisted_before_any_repair(self):
        board = make_board(5, cap=100)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(5), cap=100, reserve=2)

        self.assertEqual(board.write_log, [], "no target write may precede the checkpoint")
        self.assertIsNotNone(sweeper.load())
        self.assertEqual(len(sweeper.load().items), 5)

    def test_planning_refuses_to_clobber_an_unfinished_sweep(self):
        board = make_board(30, cap=20)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(30), cap=20, reserve=2)
        sweeper.run()

        with self.assertRaises(RuntimeError):
            sweeper.plan("s2", make_items(5), cap=20, reserve=2)

    def test_planning_proceeds_once_the_previous_sweep_is_complete(self):
        board = make_board(3, cap=100)
        sweeper = Sweeper(board, "source")
        sweeper.plan("s1", make_items(3), cap=100, reserve=2)
        sweeper.run()

        state = sweeper.plan("s2", make_items(2, start=90), cap=100, reserve=2)
        self.assertEqual(state.sweep_id, "s2")

    def test_resume_without_a_worklist_reports_cleanly(self):
        board = make_board(1, cap=100)
        _, result = Sweeper(board, "source").run()
        self.assertFalse(result.complete)
        self.assertIn("no persisted worklist", result.errors[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

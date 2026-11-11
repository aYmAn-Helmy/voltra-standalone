"""Offline, deterministic PowerA schedule and revert timer tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "powera"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hub import Hub
from scheduler import Scheduler, ScheduleError, next_occurrence, parse_zone
from test_powera_hub import FakeTransport, STOCK_ORIGIN, STAND_ORIGIN, MAC_STOCK, MAC_STAND

UTC = timezone.utc
NOW = datetime(2026, 11, 11, 18, 0, tzinfo=UTC)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.trans = FakeTransport()
        self.hub = Hub({
            "sources": [
                {"id": "stock-home", "type": "stock", "url": STOCK_ORIGIN},
                {"id": "stand-office", "type": "standalone", "url": STAND_ORIGIN, "mac": MAC_STAND}
            ]
        }, db_path=str(Path(self.tmp.name) / "powera.db"), requester=self.trans)
        self.hub.refresh(force=True)

    def tearDown(self):
        self.hub.db.close()
        self.tmp.cleanup()

    def rule(self, **extra):
        return {
            "deviceId": "stock:" + MAC_STOCK, "outlet": 1,
            "on": False, "repeat": "once",
            "clock": "20:01", "date": "2026-11-11",
            "timezone": "Africa/Cairo", "confirm": True,
            **extra
        }

    def test_once_rule_runs_exactly_once_and_was_preclaimed(self):
        new = self.hub.scheduler.create(self.rule(), now=NOW)
        self.assertEqual(new["nextRunAt"], "2026-11-11T18:01:00+00:00")
        self.assertEqual(len(self.trans.writes), 0)
        self.hub.scheduler.tick(NOW + timedelta(minutes=1, seconds=3))
        self.assertEqual(len(self.trans.writes), 1)
        result = self.hub.scheduler.list()[0]
        self.assertFalse(result["enabled"])
        self.assertEqual(result["lastResult"], "confirmed")
        self.hub.scheduler.tick(NOW + timedelta(minutes=1, seconds=12))
        self.assertEqual(len(self.trans.writes), 1, "No replay of completed one-time job")
        self.assertTrue(any(n["kind"] == "automation" for n in self.hub.notifications()))

    def test_weekly_uses_zone_and_dst_fold_first_occurrence_only(self):
        item = self.hub.scheduler.create(self.rule(
            repeat="weekly", date=None, weekdays=[2, 4], on=False), now=NOW)
        self.assertEqual(item["nextRunAt"], "2026-11-11T18:01:00+00:00")
        self.hub.scheduler.tick(NOW + timedelta(minutes=1))
        row = self.hub.scheduler.list()[0]
        self.assertTrue(row["enabled"])
        self.assertEqual(row["nextRunAt"], "2026-11-13T18:01:00+00:00")
        self.assertEqual(len(self.trans.writes), 1)
        first = next_occurrence("once", "2026-11-01", "01:30",
                                parse_zone("America/New_York"), [], datetime(2026, 10, 30, tzinfo=UTC))
        self.assertEqual(first.utcoffset(), timedelta(0))
        self.assertEqual(first.hour, 5, "DST fold=0 selects 01:30 EDT (UTC-4)")

    def test_nonexistent_local_dst_time_is_rejected(self):
        with self.assertRaisesRegex(ScheduleError, "No future occurrence"):
            self.hub.scheduler.create(self.rule(
                date="2027-03-14", clock="02:30",
                timezone="America/New_York"), now=NOW)

    def test_missed_rule_is_skipped_not_executed_after_crash(self):
        self.hub.scheduler.create(self.rule(), now=NOW)
        self.hub.scheduler.tick(NOW + timedelta(minutes=20))
        self.assertEqual(self.trans.writes, [])
        entry = self.hub.scheduler.list()[0]
        self.assertEqual(entry["lastResult"], "missed")
        self.assertFalse(entry["enabled"])
        self.hub.scheduler.tick(NOW + timedelta(minutes=21))
        self.assertEqual(self.trans.writes, [])

    def test_rejects_bad_schedule_and_confirms_before_creating(self):
        with self.assertRaises(ScheduleError):
            self.hub.scheduler.create(self.rule(confirm=False), now=NOW)
        for bad in (
            {"clock": "24:35"}, {"timezone": "Unknown/Galaxy"},
            {"repeat": "weekly", "date": None, "weekdays": []},
            {"repeat": "weekly", "date": None, "weekdays": [7]},
            {"date": "2024-01-01"}, {"outlet": 5},
        ):
            with self.subTest(bad=bad), self.assertRaises(ScheduleError):
                self.hub.scheduler.create(self.rule(**bad), now=NOW)

    def test_enable_disable_and_delete(self):
        result = self.hub.scheduler.create(self.rule(repeat="weekly", date=None, weekdays=[2]), now=NOW)
        self.hub.scheduler.set_enabled(result["id"], False, now=NOW)
        self.assertFalse(self.hub.scheduler.list()[0]["enabled"])
        self.hub.scheduler.set_enabled(result["id"], True, now=NOW)
        self.assertTrue(self.hub.scheduler.list()[0]["enabled"])
        self.hub.scheduler.delete(result["id"])
        self.assertEqual(self.hub.scheduler.list(), [])

    def test_revert_timer_restores_original_state_if_still_expected(self):
        # Initial stock outlet 1 is ON; turn it OFF temporarily, then restore ON.
        result = self.hub.scheduler.start_return_timer({
            "deviceId": "stock:" + MAC_STOCK, "outlet": 1,
            "on": False, "minutes": 2, "confirm": True,
        }, now=NOW)
        self.assertTrue(result["originalState"])
        self.assertFalse(self.trans.stock[0]["outlets"][0]["on"])
        self.assertEqual(self.hub.scheduler.timers()[0]["status"], "active")
        self.hub.scheduler.tick(NOW + timedelta(minutes=2, seconds=1))
        self.assertTrue(self.trans.stock[0]["outlets"][0]["on"])
        self.assertEqual(self.hub.scheduler.timers()[0]["status"], "restored")
        before = len(self.trans.writes)
        self.hub.scheduler.tick(NOW + timedelta(minutes=2, seconds=2))
        self.assertEqual(len(self.trans.writes), before)

    def test_revert_does_not_override_external_state_change(self):
        result = self.hub.scheduler.start_return_timer({
            "deviceId": "stock:" + MAC_STOCK, "outlet": 1,
            "on": False, "minutes": 2, "confirm": True,
        }, now=NOW)
        # External actor switched it back to ON. Hub must NOT reissue a write.
        self.trans.stock[0]["outlets"][0]["on"] = True
        before = len(self.trans.writes)
        self.hub.scheduler.tick(NOW + timedelta(minutes=2))
        self.assertEqual(len(self.trans.writes), before)
        self.assertEqual(self.hub.scheduler.timers()[0]["status"], "needs_review")

    def test_revert_after_long_offline_does_not_switch_without_user(self):
        self.hub.scheduler.start_return_timer({
            "deviceId": "stock:" + MAC_STOCK, "outlet": 1,
            "on": False, "minutes": 2, "confirm": True,
        }, now=NOW)
        before = len(self.trans.writes)
        self.hub.scheduler.tick(NOW + timedelta(hours=4))
        self.assertEqual(len(self.trans.writes), before)
        self.assertEqual(self.hub.scheduler.timers()[0]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()

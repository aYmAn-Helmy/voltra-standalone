"""Durable timezone-aware PowerA schedules and reversible outlet timers.

Electrical actions are claimed in SQLite *before* sending them, so an
unknown result, crash or missed time is never automatically replayed.
"""
from __future__ import annotations
from datetime import date, datetime, time as daytime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import json
import re
import sqlite3

UTC = timezone.utc
ZONE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+./-]{0,60}$")
CLOCK_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEVICE_RE = re.compile(r"^(?:stock|standalone):[0-9A-F]{12}$")


class ScheduleError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def parse_zone(name):
    if not isinstance(name, str) or not ZONE_RE.fullmatch(name):
        raise ScheduleError("Invalid IANA time zone")
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ScheduleError("Time zone not found: " + name) from exc


def utc_time(value):
    return datetime.fromisoformat(value).astimezone(UTC)


def local_occurrence(day, clock, zone):
    h, m = map(int, clock.split(":"))
    naive = datetime.combine(day, daytime(hour=h, minute=m))
    candidate = naive.replace(tzinfo=zone, fold=0).astimezone(UTC)
    # Reject skipped times at DST spring transition; repeated times use the
    # first occurrence (fold=0), avoiding an automatic second firing.
    if candidate.astimezone(zone).replace(tzinfo=None) != naive:
        return None
    return candidate


def next_occurrence(repeat, local_date, clock, zone, weekdays, after):
    after = after.astimezone(UTC)
    if repeat == "once":
        when = local_occurrence(date.fromisoformat(local_date), clock, zone)
        return when if when and when > after else None
    current = after.astimezone(zone).date()
    for delta in range(15):
        day = current + timedelta(days=delta)
        if day.weekday() not in weekdays:
            continue
        candidate = local_occurrence(day, clock, zone)
        if candidate and candidate > after:
            return candidate
    return None


class Scheduler:
    GRACE_SECONDS = 90

    def __init__(self, hub):
        self.hub = hub
        with hub.db_lock:
            hub.db.executescript("""
                CREATE TABLE IF NOT EXISTS schedules (
                    id INTEGER PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    outlet INTEGER NOT NULL,
                    state INTEGER NOT NULL,
                    repeat TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    local_date TEXT,
                    clock TEXT NOT NULL,
                    weekdays TEXT NOT NULL,
                    next_run_at TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    last_claimed_at TEXT,
                    last_result TEXT
                );
                CREATE TABLE IF NOT EXISTS return_timers (
                    id INTEGER PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    outlet INTEGER NOT NULL,
                    original_state INTEGER NOT NULL,
                    expected_state INTEGER NOT NULL,
                    due_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detail TEXT
                );
            """)
            hub.db.commit()

    def _known_target(self, device_id, outlet):
        if not isinstance(device_id, str) or not DEVICE_RE.fullmatch(device_id) or type(outlet) is not int or outlet < 1 or outlet > 4:
            raise ScheduleError("Invalid target device or outlet")
        self.hub.refresh()
        if device_id not in self.hub.cached:
            raise ScheduleError("Device not found", 404)
        device=self.hub.cached[device_id]
        if device.get("type") == "standalone":
            # Explicit ownership: do not schedule the same channel from both
            # the Hub and the firmware, even when the times differ.
            try:
                config=self.hub.sync.read(device_id)
            except Exception as exc:
                raise ScheduleError("Read device schedules first; cannot verify conflict", 409) from exc
            if config["configuration"]["timer_minutes"][outlet-1]:
                raise ScheduleError("Firmware already has an auto-off timer for this outlet", 409)
            for rule in config["schedule"]["rules"]:
                if (rule["mode"] & 128) and (rule["mode"] & 127) and rule["channel"] in (4,outlet-1):
                    raise ScheduleError("Device has an active schedule for this outlet; edit it on the device",409)

    def list(self):
        with self.hub.db_lock:
            rows = self.hub.db.execute("SELECT * FROM schedules ORDER BY enabled DESC, next_run_at, id").fetchall()
        return [{
            "id": r["id"], "deviceId": r["device_id"], "outlet": r["outlet"],
            "on": bool(r["state"]), "repeat": r["repeat"], "timezone": r["timezone"],
            "date": r["local_date"], "clock": r["clock"],
            "weekdays": json.loads(r["weekdays"]), "nextRunAt": r["next_run_at"],
            "enabled": bool(r["enabled"]), "lastClaimedAt": r["last_claimed_at"],
            "lastResult": r["last_result"]
        } for r in rows]

    def create(self, data, now=None):
        now = (now or datetime.now(UTC)).astimezone(UTC)
        if data.get("confirm") is not True:
            raise ScheduleError("Scheduling electricity requires confirmation", 428)
        device_id, outlet, state = data.get("deviceId"), data.get("outlet"), data.get("on")
        if type(state) is not bool:
            raise ScheduleError("ON/OFF state must be boolean")
        self._known_target(device_id, outlet)
        repeat, clock = data.get("repeat"), data.get("clock")
        if repeat not in ("once", "weekly") or not isinstance(clock, str) or not CLOCK_RE.fullmatch(clock):
            raise ScheduleError("Schedule must be once or weekly with HH:MM time")
        name = data.get("timezone", "Africa/Cairo")
        zone = parse_zone(name)
        local_date = data.get("date") if repeat == "once" else None
        if repeat == "once":
            if not isinstance(local_date, str) or not DATE_RE.fullmatch(local_date):
                raise ScheduleError("Once schedules need YYYY-MM-DD")
            try: date.fromisoformat(local_date)
            except ValueError as exc: raise ScheduleError("Invalid schedule date") from exc
        raw_days = data.get("weekdays", []) if repeat == "weekly" else []
        if not isinstance(raw_days, list) or not raw_days or any(type(x) is not int or not 0 <= x <= 6 for x in raw_days) if repeat == "weekly" else False:
            raise ScheduleError("Choose at least one valid weekday")
        days = sorted(set(raw_days))
        due = next_occurrence(repeat, local_date, clock, zone, days, now)
        if due is None:
            raise ScheduleError("No future occurrence; check date/time zone", 400)
        with self.hub.db_lock:
            count = self.hub.db.execute("SELECT COUNT(*) AS n FROM schedules WHERE enabled=1").fetchone()["n"]
            if count >= 128:
                raise ScheduleError("At most 128 active schedules", 409)
            result = self.hub.db.execute(
                "INSERT INTO schedules(device_id,outlet,state,repeat,timezone,local_date,clock,weekdays,next_run_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (device_id, outlet, int(state), repeat, name, local_date, clock, json.dumps(days), due.isoformat()))
            self.hub.db.commit()
        return {"ok": True, "id": result.lastrowid, "nextRunAt": due.isoformat()}

    def set_enabled(self, id_, enabled, now=None):
        if type(id_) is not int or id_ <= 0 or type(enabled) is not bool:
            raise ScheduleError("Invalid schedule state")
        now = (now or datetime.now(UTC)).astimezone(UTC)
        with self.hub.db_lock:
            row = self.hub.db.execute("SELECT * FROM schedules WHERE id=?", (id_,)).fetchone()
            if row is None:
                raise ScheduleError("Schedule not found", 404)
            when = None
            if enabled:
                when = next_occurrence(row["repeat"], row["local_date"], row["clock"],
                                       parse_zone(row["timezone"]), json.loads(row["weekdays"]), now)
                if when is None:
                    raise ScheduleError("No future occurrence for this schedule")
            self.hub.db.execute("UPDATE schedules SET enabled=?, next_run_at=?, last_result=? WHERE id=?",
                                (int(enabled), when.isoformat() if when else None,
                                 "enabled" if enabled else "disabled", id_))
            self.hub.db.commit()
        return {"ok": True, "enabled": enabled}

    def delete(self, id_):
        if type(id_) is not int or id_ <= 0:
            raise ScheduleError("Invalid schedule ID")
        with self.hub.db_lock:
            changed = self.hub.db.execute("DELETE FROM schedules WHERE id=?", (id_,)).rowcount
            self.hub.db.commit()
        if not changed:
            raise ScheduleError("Schedule not found", 404)
        return {"ok": True}

    def start_return_timer(self, data, now=None):
        """Change one known outlet and conditionally restore its original state."""
        if data.get("confirm") is not True:
            raise ScheduleError("Outlet return timer requires confirmation", 428)
        device_id, outlet, state = data.get("deviceId"), data.get("outlet"), data.get("on")
        minutes = data.get("minutes")
        if type(state) is not bool or type(minutes) is not int or not 1 <= minutes <= 1440:
            raise ScheduleError("Choose ON/OFF and 1–1440 minutes")
        self._known_target(device_id, outlet)
        latest = self.hub.refresh(force=True)
        device = next(d for d in latest["devices"] if d["id"] == device_id)
        if not device["controlAvailable"]:
            raise ScheduleError("Device offline or not ready", 409)
        original = device["outlets"][outlet - 1]["on"]
        if type(original) is not bool:
            raise ScheduleError("Original outlet state is unknown", 409)
        if original is state:
            raise ScheduleError("Outlet already has the requested state")
        due = (now or datetime.now(UTC)).astimezone(UTC) + timedelta(minutes=minutes)
        with self.hub.db_lock:
            active = self.hub.db.execute(
                "SELECT id FROM return_timers WHERE device_id=? AND outlet=? AND status IN ('pending','active','claimed')",
                (device_id, outlet)).fetchone()
            if active:
                raise ScheduleError("This outlet already has a return timer", 409)
            cur = self.hub.db.execute(
                "INSERT INTO return_timers(device_id,outlet,original_state,expected_state,due_at,status) VALUES(?,?,?,?,?,'pending')",
                (device_id, outlet, int(original), int(state), due.isoformat()))
            self.hub.db.commit()
        try:
            self.hub.control(device_id, outlet, state)
            with self.hub.db_lock:
                self.hub.db.execute("UPDATE return_timers SET status='active' WHERE id=?",
                                    (cur.lastrowid,))
                self.hub.db.commit()
            return {"ok": True, "id": cur.lastrowid, "dueAt": due.isoformat(),
                    "originalState": original}
        except Exception as exc:
            # The actual state may have changed even if command confirmation fails.
            # Never issue an automatic reverse command for an uncertain write.
            with self.hub.db_lock:
                self.hub.db.execute("UPDATE return_timers SET status='needs_review', detail=? WHERE id=?",
                                    (str(exc)[:240], cur.lastrowid))
                self.hub.db.commit()
            raise

    def timers(self):
        with self.hub.db_lock:
            rows = self.hub.db.execute(
                "SELECT id,device_id,outlet,original_state,expected_state,due_at,status,detail FROM return_timers ORDER BY id DESC LIMIT 100"
            ).fetchall()
        return [{"id": r["id"], "deviceId": r["device_id"], "outlet": r["outlet"],
                 "originalOn": bool(r["original_state"]), "expectedOn": bool(r["expected_state"]),
                 "dueAt": r["due_at"], "status": r["status"], "detail": r["detail"]} for r in rows]

    def tick(self, now=None):
        """Exactly-once *attempt* per event, never replay after crash or missed time."""
        now = (now or datetime.now(UTC)).astimezone(UTC)
        with self.hub.db_lock:
            due = list(self.hub.db.execute(
                "SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at,id LIMIT 20",
                (now.isoformat(),)).fetchall())
        for row in due:
            scheduled = utc_time(row["next_run_at"])
            late = (now - scheduled).total_seconds()
            next_time = None
            if row["repeat"] == "weekly":
                next_time = next_occurrence("weekly", None, row["clock"], parse_zone(row["timezone"]),
                                            json.loads(row["weekdays"]), now + timedelta(seconds=1))
            is_missed = late > self.GRACE_SECONDS
            with self.hub.db_lock:
                changed = self.hub.db.execute("""
                    UPDATE schedules
                    SET next_run_at=?, enabled=?, last_claimed_at=?, last_result=?
                    WHERE id=? AND enabled=1 AND next_run_at=?
                    """, (next_time.isoformat() if next_time else None, 1 if next_time else 0,
                          now.isoformat(), "missed" if is_missed else "claimed",
                          row["id"], row["next_run_at"])).rowcount
                self.hub.db.commit()
            if not changed:
                continue
            if is_missed:
                self.hub._notify("automation", row["device_id"],
                                 f"جدول {row['id']} فات موعده ولم يتم تشغيله تلقائيًا")
                continue
            try:
                result = self.hub.control(row["device_id"], row["outlet"], bool(row["state"]))
                outcome = "confirmed" if result.get("confirmed") else "unconfirmed"
            except Exception as exc:
                outcome = "error: " + str(exc)[:180]
            with self.hub.db_lock:
                self.hub.db.execute("UPDATE schedules SET last_result=? WHERE id=?",
                                    (outcome, row["id"]))
                self.hub.db.commit()
            self.hub._notify("automation", row["device_id"], "جدول " + str(row["id"]) + ": " + outcome)

        with self.hub.db_lock:
            timers = list(self.hub.db.execute(
                "SELECT * FROM return_timers WHERE status='active' AND due_at<=? ORDER BY due_at,id LIMIT 20",
                (now.isoformat(),)).fetchall())
        for row in timers:
            late = (now - utc_time(row["due_at"])).total_seconds()
            with self.hub.db_lock:
                claimed = self.hub.db.execute(
                    "UPDATE return_timers SET status='claimed' WHERE id=? AND status='active'",
                    (row["id"],)).rowcount
                self.hub.db.commit()
            if not claimed:
                continue
            if late > self.GRACE_SECONDS:
                outcome = "needs_review"
                detail = "Timer missed its deadline; no automatic switch after recovery"
            else:
                try:
                    latest = self.hub.refresh(force=True)
                    device = next((d for d in latest["devices"] if d["id"] == row["device_id"]), None)
                    if device is None or not device["controlAvailable"]:
                        raise ScheduleError("Device not ready; no blind retry")
                    actual = device["outlets"][row["outlet"] - 1]["on"]
                    if actual is not bool(row["expected_state"]):
                        raise ScheduleError("Outlet state changed since timer started; manual review required")
                    result = self.hub.control(row["device_id"], row["outlet"], bool(row["original_state"]))
                    if not result.get("confirmed"):
                        raise ScheduleError("Restore command unconfirmed")
                    outcome, detail = "restored", "Original outlet state confirmed"
                except Exception as exc:
                    outcome, detail = "needs_review", str(exc)[:240]
            with self.hub.db_lock:
                self.hub.db.execute(
                    "UPDATE return_timers SET status=?, detail=? WHERE id=?", (outcome, detail, row["id"]))
                self.hub.db.commit()
            self.hub._notify("automation", row["device_id"], "مؤقت " + str(row["id"]) + ": " + detail)

"""Bidirectional *device-authoritative* settings synchronization for Standalone 2.x.

Implements the firmware's /api/config v7 binary format. No configuration is
pushed automatically when a device reconnects. Reads track external edits;
writes require an explicit current revision, re-check the device immediately,
POST only once, and verify persistence with fresh GETs. Lost ACK != retry.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import threading
import time

RULE_LEN = 50
HEXDIGITS = re.compile(r"^[0-9a-fA-F]{100}$")
MAC = re.compile(r"^[0-9a-fA-F]{12}$")
SAFE_KEYS = ("device", "channels", "language", "enabled", "broker", "port",
             "user", "topic", "protection", "schedule_hex", "button_lock",
             "timer_minutes", "persistent")
NAME_BAD = re.compile(r"[\x00-\x1f\x7f]")


class SyncError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def name(value):
    if (not isinstance(value, str) or not value.strip() or NAME_BAD.search(value)
            or len(value.strip().encode("utf-8")) > 64):
        raise SyncError("Invalid device/outlet name: 1–64 UTF-8 bytes")
    return value.strip()


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise SyncError(f"Invalid {label}; expected {low}..{high}")
    return value


def schedule_unpack(hexvalue: str) -> dict:
    if not isinstance(hexvalue, str) or not HEXDIGITS.fullmatch(hexvalue):
        raise SyncError("Unsupported or invalid 50-byte firmware schedule")
    binary = bytes.fromhex(hexvalue)
    tz = struct.unpack_from("<h", binary)[0]
    integer(tz, -720, 840, "timezone")
    if tz % 15:
        raise SyncError("Device timezone must be a multiple of 15 minutes")
    rules = []
    for i in range(8):
        minute, mode, day, channel, on = struct.unpack_from("<HBBBB", binary, 2 + 6*i)
        kind = mode & 127
        if (kind > 4 or minute >= 1440 or channel > 4 or on > 1 or
            (kind == 0 and any((mode, minute, day, channel, on))) or
            (kind == 2 and not 1 <= day <= 127) or
            (kind == 3 and not 1 <= day <= 31) or
            (kind in (1, 4) and day)):
            raise SyncError(f"Invalid firmware schedule rule {i+1}")
        rules.append({"minute": minute, "mode": mode, "day": day,
                      "channel": channel, "on": on})
    return {"timezone": tz, "rules": rules}


def schedule_pack(schedule: dict) -> str:
    if not isinstance(schedule, dict):
        raise SyncError("Invalid schedule payload")
    tz = integer(schedule.get("timezone"), -720, 840, "timezone")
    rules = schedule.get("rules")
    if tz % 15 or not isinstance(rules, list) or len(rules) != 8:
        raise SyncError("Schedule needs a 15-minute UTC offset and eight rule slots")
    data = bytearray(50)
    struct.pack_into("<h", data, 0, tz)
    for i, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise SyncError("Invalid schedule rule")
        struct.pack_into("<HBBBB", data, 2+6*i,
                         integer(rule.get("minute"), 0, 1439, "minute"),
                         integer(rule.get("mode"), 0, 255, "mode"),
                         integer(rule.get("day"), 0, 127, "day"),
                         integer(rule.get("channel"), 0, 4, "channel"),
                         integer(rule.get("on"), 0, 1, "on"))
    result = data.hex()
    schedule_unpack(result)
    return result


def public_config(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise SyncError("Unsupported config response", 502)
    c = {key: raw.get(key) for key in SAFE_KEYS}
    if (not isinstance(c["channels"], list) or len(c["channels"]) != 4
        or any(not isinstance(x, str) for x in c["channels"])
        or not isinstance(c["device"], str) or not isinstance(c["protection"], dict)
        or not isinstance(c["timer_minutes"], list) or len(c["timer_minutes"]) != 4
        or type(c["button_lock"]) is not int or not 0 <= c["button_lock"] <= 15):
        raise SyncError("Unsupported Standalone firmware configuration", 502)
    c["device"] = name(c["device"])
    c["channels"] = [name(x) for x in c["channels"]]
    c["language"] = integer(c["language"], 0, 1, "language")
    c["port"] = integer(c["port"], 1, 65535, "port")
    if type(c["enabled"]) is not bool:
        raise SyncError("Invalid MQTT enabled field")
    for key in ("broker", "user", "topic"):
        if not isinstance(c[key], str):
            raise SyncError("Invalid MQTT config field", 502)
    c["persistent"] = c["persistent"] is True
    p = c["protection"]
    for key, lo, hi in (("enabled", 0, 7), ("temperature", 50, 90),
                        ("current", 1000, 16000), ("power", 100, 3000)):
        integer(p.get(key), lo, hi, "protection."+key)
    c["protection"] = {k:p[k] for k in ("enabled","temperature","current","power")}
    c["schedule_hex"] = schedule_pack(schedule_unpack(c["schedule_hex"]))
    c["timer_minutes"] = [integer(m, 0, 1440, "timer") for m in c["timer_minutes"]]
    check_conflicts(c)
    return c


def check_conflicts(c):
    schedule = schedule_unpack(c["schedule_hex"])
    for rule in schedule["rules"]:
        if not (rule["mode"] & 127):
            continue
        for i, timer in enumerate(c["timer_minutes"]):
            if timer and (rule["channel"] == 4 or rule["channel"] == i):
                raise SyncError("Device timer overlaps a device schedule", 409)


def revision(c: dict) -> str:
    """A version token over public persistent settings, excluding transport/pending."""
    data = {k: c[k] for k in SAFE_KEYS if k != "persistent"}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False,
                                     sort_keys=True, separators=(",",":")).encode()).hexdigest()[:24]


def packed_config(c: dict) -> bytes:
    """Firmware /api/config version 7, no Wi-Fi or MQTT passwords in memory.

    Firmware retains Wi-Fi credentials on config apply and preserves old MQTT
    password when X-MTTL-Keep-Password=1.
    """
    c = public_config(c)
    out = bytearray([7, c["language"], int(c["enabled"]), c["port"] & 255,
                     c["port"] >> 8])
    fields = [c["device"], *c["channels"], "", "", c["broker"], c["user"],
              "", c["topic"]]
    for i, value in enumerate(fields):
        raw = value.encode("utf-8")
        cap = [64]*5 + [32,64,253,64,64,64]
        if len(raw) > cap[i]:
            raise SyncError("Config field too long")
        out.append(len(raw))
        out.extend(raw)
    p = c["protection"]
    out.extend(struct.pack("<BHHH", p["enabled"], p["temperature"],
                           p["current"], p["power"]))
    out.extend(bytes.fromhex(c["schedule_hex"]))
    out.append(c["button_lock"])
    out.extend(struct.pack("<4H", *c["timer_minutes"]))
    if len(out) > 1024:
        raise SyncError("Settings body too large")
    return bytes(out)


def update_config(c, section, changes):
    if not isinstance(changes, dict):
        raise SyncError("Settings change must be an object")
    after = json.loads(json.dumps(c, ensure_ascii=False))
    if section == "device-name":
        if set(changes) != {"name"}:
            raise SyncError("Expected only name")
        after["device"] = name(changes["name"])
    elif section == "names":
        if set(changes) != {"device","channels"} or not isinstance(changes["channels"], list) or len(changes["channels"]) != 4:
            raise SyncError("Expected device name and four outlet names")
        after["device"] = name(changes["device"])
        after["channels"] = [name(x) for x in changes["channels"]]
    elif section == "outlet-name":
        if set(changes) != {"index", "name"}:
            raise SyncError("Expected index and name")
        index = integer(changes["index"], 1, 4, "outlet")
        after["channels"][index - 1] = name(changes["name"])
    elif section == "schedules":
        if set(changes) != {"schedule"}:
            raise SyncError("Expected only schedule")
        after["schedule_hex"] = schedule_pack(changes["schedule"])
    elif section == "timers":
        if set(changes) != {"minutes"}:
            raise SyncError("Expected timer minutes")
        after["timer_minutes"] = changes["minutes"]
    elif section == "protection":
        if set(changes) != {"settings"} or not isinstance(changes["settings"], dict):
            raise SyncError("Expected protection settings")
        after["protection"] = changes["settings"]
    elif section == "button-lock":
        if set(changes) != {"mask"}:
            raise SyncError("Expected physical button lock mask")
        after["button_lock"] = changes["mask"]
    elif section == "language":
        if set(changes) != {"language"}:
            raise SyncError("Expected language")
        after["language"] = changes["language"]
    elif section == "mqtt":
        allowed = {"broker", "user", "topic", "port", "enabled"}
        if not changes or not set(changes).issubset(allowed):
            raise SyncError("Only nonsecret MQTT settings can be changed")
        after.update(changes)
    else:
        raise SyncError("Unsupported firmware setting: " + str(section), 422)
    return public_config(after)


class StandaloneSync:
    def __init__(self, hub):
        self.hub = hub
        self.locks = {}
        self.master = threading.Lock()

    def _lock(self, device_id):
        with self.master:
            return self.locks.setdefault(device_id, threading.RLock())

    def _source(self, device_id):
        if not isinstance(device_id, str) or not device_id.startswith("standalone:"):
            raise SyncError("Only Standalone firmware supports this settings API", 422)
        mac = device_id.split(":",1)[1]
        if not MAC.fullmatch(mac):
            raise SyncError("Invalid Standalone MAC")
        source = next((s for s in self.hub.sources
                       if s["type"] == "standalone" and s["mac"] == mac), None)
        if not source:
            raise SyncError("Standalone not configured", 404)
        return source

    def _read(self, source):
        status = self.hub.request(source, "/api/status")
        status_mac = str(status.get("mac","")).replace(":","").replace("-","").upper()
        if status_mac != source["mac"]:
            raise SyncError("Device MAC mismatch: refusing config access", 409)
        if status.get("state") != 5 or status.get("hardware_ready") is not True:
            raise SyncError("Standalone not ready for settings synchronization", 409)
        return public_config(self.hub.request(source, "/api/config"))

    def read(self, device_id):
        source = self._source(device_id)
        with self._lock(device_id):
            c = self._read(source)
            return {"deviceId": device_id, "source": "device",
                    "revision": revision(c), "configuration": c,
                    "schedule": schedule_unpack(c["schedule_hex"]),
                    "capabilities": {"names":True, "schedules":True, "timers":True,
                                     "protection":True, "buttonLock":True,
                                     "mqttNonsecret":True, "powerRecovery":False}}

    def write(self, device_id, section, changes, expected_revision):
        if not isinstance(expected_revision, str) or len(expected_revision) != 24:
            raise SyncError("Read device settings before writing; revision required", 428)
        source = self._source(device_id)
        with self._lock(device_id):
            before = self._read(source)
            if revision(before) != expected_revision:
                raise SyncError("Settings changed on device; reload before saving", 409)
            after = update_config(before, section, changes)
            if revision(after) == revision(before):
                return {"ok":True, "unchanged":True, **self.read(device_id)}
            # A second GET protects against out-of-band edits before writing;
            # the firmware has no atomic compare-and-swap API.
            if revision(self._read(source)) != expected_revision:
                raise SyncError("Device settings changed during edit; reload", 409)
            body = packed_config(after)
            try:
                self.hub.request(source, "/api/config", method="POST", body=body,
                                 content_type="application/octet-stream",
                                 extra_headers={"X-MTTL-Keep-Password":"1"})
            except Exception:
                # POST may have succeeded despite a lost response. Read back
                # rather than resending a possibly harmful flash write.
                pass
            for attempt in range(14):
                time.sleep(.35)
                try:
                    updated = self._read(source)
                    if revision(updated) == revision(after) and updated["persistent"]:
                        return {"ok":True, "confirmed":True,
                                **self.read(device_id)}
                    if revision(updated) not in (expected_revision, revision(after)):
                        raise SyncError("Unexpected concurrent device edit; review settings", 409)
                except SyncError as e:
                    if e.status == 409:
                        raise
                except Exception:
                    pass
            raise SyncError("Could not verify saved settings; do not retry blindly", 504)

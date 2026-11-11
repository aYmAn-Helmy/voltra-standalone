"""PowerA Hub: original local-first multi-firmware API for MTTL-W01.

No upstream powerk source is embedded here. Stock devices are accessed through
its documented JSON API; Standalone devices use their documented HTTP API.
Use on a trusted local network only; don't expose directly to the internet.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, build_opener
from powera.scheduler import Scheduler, ScheduleError

MAC_PATTERN = re.compile(r"^[0-9A-F]{12}$")
ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,45}$")
DEVICE_PATTERN = re.compile(r"^(stock|standalone):[0-9A-F]{12}$")
INVALID_TEXT = re.compile(r"[\x00-\x1f\x7f]")


class HubError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def mac_id(value: str) -> str:
    x = str(value).replace(":", "").replace("-", "").upper()
    if not MAC_PATTERN.fullmatch(x):
        raise HubError("Invalid MAC address")
    return x


def private_url(value: str) -> str:
    p = urlparse(value)
    if p.scheme != "http" or not p.hostname or p.username or p.password or p.path not in ("", "/") or p.query or p.fragment:
        raise HubError("Only HTTP origins on private IPv4 networks are supported")
    try:
        address = ipaddress.ip_address(p.hostname)
    except ValueError as exc:
        raise HubError("Use a literal private IPv4 address, not a hostname") from exc
    if address.version != 4 or not (address.is_private or address.is_loopback) or address.is_link_local or address.is_multicast or address.is_unspecified:
        raise HubError("Public and unsafe IP addresses are blocked")
    if p.port is not None and (p.port < 1 or p.port > 65535):
        raise HubError("Invalid port")
    return value.rstrip("/")


from urllib.request import HTTPRedirectHandler, ProxyHandler


class RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HubError("Redirect from device is not allowed", 502)


def _request(origin: str, path: str, *, method: str = "GET",
             body: bytes | None = None, token: str = "",
             content_type: str = "application/json",
             timeout: float = 5) -> dict:
    headers = {"Accept": "application/json"}
    if token:
        headers["X-Token"] = token
    if method == "POST":
        headers["Origin"] = origin
        headers["Content-Type"] = content_type
    req = Request(origin + path, data=body, headers=headers, method=method)
    try:
        with build_opener(ProxyHandler({}), RejectRedirect()).open(req, timeout=timeout) as response:
            raw = response.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise HubError("Oversized device response", 502)
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise HubError("Unexpected device response shape", 502)
            return parsed
    except HubError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise HubError("Device request failed: " + str(exc), 502) from exc


def name_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 64 or INVALID_TEXT.search(value):
        raise HubError("Name must be 1–64 characters without control characters")
    return value.strip()


def reading(value, factor=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return round(value / factor, 4)


def stock_device(source: dict, raw: dict) -> dict:
    mac = mac_id(raw.get("mac", ""))
    values = {o.get("n"): o for o in raw.get("outlets", []) if isinstance(o, dict)}
    outlets = []
    for i in range(1, 5):
        o = values.get(i) or {}
        outlets.append({
            "index": i, "name": f"مخرج {i}",
            "on": o.get("on") if isinstance(o.get("on"), bool) else None,
            "powerW": reading(o.get("power_w")),
            "energyKwh": reading(o.get("energy_kwh")),
            "temperatureC": reading(o.get("temp_c")),
            "currentA": None,
        })
    if raw.get("online") is not True:
        # A cached upstream stock report is not current relay or wattage data.
        for outlet in outlets:
            outlet["on"] = None
            outlet["powerW"] = None
    return {
        "id": "stock:" + mac, "mac": mac, "type": "stock", "source": source["id"],
        "name": raw.get("name") or f"MTTL {mac[-6:]}",
        "online": raw.get("online") is True, "controlAvailable": raw.get("online") is True,
        "firmware": raw.get("fw"), "rssi": raw.get("rssi"),
        "voltageV": reading(raw.get("voltage")) if raw.get("online") is True else None,
        "currentA": reading(raw.get("current_a")) if raw.get("online") is True else None,
        "powerW": reading(raw.get("power_w")) if raw.get("online") is True else None,
        "energyKwh": reading(raw.get("energy_kwh")),
        "outlets": outlets,
    }


def standalone_device(source: dict, status: dict, raw: dict) -> dict:
    mac = mac_id(status.get("mac", ""))
    if mac != source["mac"]:
        raise HubError("IP address belongs to a different MAC; check source config", 409)
    channels = raw.get("channels")
    if not isinstance(channels, list) or len(channels) != 4:
        raise HubError("Invalid Standalone channels response", 502)
    outlets = []
    for i, o in enumerate(channels):
        outlets.append({
            "index": i + 1, "name": o.get("name") or f"مخرج {i+1}",
            "on": o.get("on") if isinstance(o.get("on"), bool) else None,
            "powerW": reading(o.get("power_mw"), 1000),
            "energyKwh": reading(o.get("meter_wh"), 1000),
            "temperatureC": reading(o.get("temp_dc"), 10),
            "currentA": reading(o.get("current_ma"), 1000),
        })
    online = status.get("state") == 5 and status.get("hardware_ready") is True
    ready = online and raw.get("hardware_ready") is True
    return {
        "id": "standalone:" + mac, "mac": mac, "type": "standalone",
        "source": source["id"], "name": raw.get("name") or source.get("name") or "Standalone",
        "online": online, "controlAvailable": ready,
        "firmware": "Standalone", "rssi": status.get("rssi"),
        "voltageV": reading(raw.get("voltage_dv"), 10),
        "currentA": reading(raw.get("current_ma"), 1000),
        "powerW": reading(raw.get("power_mw"), 1000),
        "energyKwh": reading(raw.get("meter_wh"), 1000),
        "protection": raw.get("protection"),
        "outlets": outlets,
    }


class Hub:
    def __init__(self, config: dict, db_path: str = ":memory:", requester=_request):
        self.sources = []
        for s in config.get("sources", []):
            if not isinstance(s, dict) or s.get("type") not in ("stock", "standalone") or not ID_PATTERN.fullmatch(str(s.get("id", ""))):
                raise HubError("Invalid source configuration")
            source = dict(s)
            source["url"] = private_url(str(source.get("url", "")))
            if source["type"] == "standalone":
                source["mac"] = mac_id(source.get("mac", ""))
            self.sources.append(source)
        if len(self.sources) > 40 or len({s["id"] for s in self.sources}) != len(self.sources):
            raise HubError("Too many or duplicate sources")
        self.requester = requester
        self.config = config
        self.db_lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.db_lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS labels(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
                CREATE TABLE IF NOT EXISTS room_outlets(room_id INTEGER NOT NULL, device_id TEXT NOT NULL, outlet INTEGER NOT NULL,
                    PRIMARY KEY(room_id, device_id, outlet), FOREIGN KEY(room_id) REFERENCES rooms(id));
                CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL,
                    device_id TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS readings(id INTEGER PRIMARY KEY, at TEXT NOT NULL, device_id TEXT NOT NULL,
                    outlet INTEGER NOT NULL, power_w REAL, energy_kwh REAL);
                CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            self.db.commit()
        self.cached: dict[str, dict] = {}
        self.last_refresh = 0.0
        self.last_sample = 0.0
        self.scheduler = Scheduler(self)

    def request(self, source, path, **opts):
        return self.requester(source["url"], path, token=source.get("token", ""), **opts)

    def _notify(self, kind: str, device_id: str, message: str):
        with self.db_lock:
            self.db.execute("INSERT INTO notifications(at,kind,device_id,message) VALUES(?,?,?,?)",
                            (datetime.now(timezone.utc).isoformat(), kind, device_id, message))
            self.db.commit()

    def _apply_names(self, device):
        with self.db_lock:
            keys = ["device:" + device["id"]] + [f"outlet:{device['id']}:{i}" for i in range(1, 5)]
            rows = self.db.execute(
                "SELECT key,value FROM labels WHERE key IN (" + ",".join("?" for _ in keys) + ")", keys
            ).fetchall()
        overrides = {x["key"]: x["value"] for x in rows}
        device["name"] = overrides.get(keys[0], device["name"])
        for i, outlet in enumerate(device["outlets"], start=1):
            outlet["name"] = overrides.get(keys[i], outlet["name"])

    def _collect(self) -> list[dict]:
        found = {}
        for source in self.sources:
            try:
                if source["type"] == "stock":
                    response = self.request(source, "/api/state")
                    items = response.get("devices")
                    if not isinstance(items, list):
                        raise HubError("Invalid powerk device list", 502)
                    for raw in items:
                        d = stock_device(source, raw)
                        if d["id"] in found:
                            raise HubError("Duplicate device MAC between sources", 409)
                        found[d["id"]] = d
                else:
                    s = self.request(source, "/api/status")
                    d = self.request(source, "/api/device")
                    item = standalone_device(source, s, d)
                    if item["id"] in found:
                        raise HubError("Duplicate device MAC between sources", 409)
                    found[item["id"]] = item
            except (HubError, ValueError, TypeError, KeyError):
                # Keep previously identified strips visible but offline after a read error.
                for did, item in self.cached.items():
                    if item["source"] == source["id"] and did not in found:
                        prev = dict(item)
                        prev["online"] = prev["controlAvailable"] = False
                        prev["powerW"] = prev["voltageV"] = prev["currentA"] = None
                        prev["outlets"] = [{**o, "on": None, "powerW": None, "currentA": None}
                                           for o in item["outlets"]]
                        found[did] = prev
                if source["type"] == "standalone" and ("standalone:" + source["mac"]) not in found:
                    did = "standalone:" + source["mac"]
                    found[did] = {
                        "id": did, "mac": source["mac"], "type": "standalone",
                        "source": source["id"], "name": source.get("name") or "Standalone",
                        "online": False, "controlAvailable": False,
                        "powerW": None, "energyKwh": None, "voltageV": None,
                        "currentA": None, "rssi": None, "firmware": None,
                        "outlets": [{"index": i, "name": f"مخرج {i}", "on": None, "powerW": None,
                                     "energyKwh": None, "temperatureC": None, "currentA": None} for i in range(1, 5)],
                    }
        return list(found.values())

    def refresh(self, force=False):
        with self.refresh_lock:
            if not force and self.last_refresh and time.monotonic() - self.last_refresh < 4:
                return self.snapshot()
            before = {k: v.get("online") for k, v in self.cached.items()}
            records = self._collect()
            for d in records:
                self._apply_names(d)
                if d["id"] in before and before[d["id"]] != d["online"]:
                    self._notify("online" if d["online"] else "offline", d["id"],
                                 ("عاد للاتصال: " if d["online"] else "انقطع الاتصال: ") + d["name"])
            self.cached = {d["id"]: d for d in records}
            self.last_refresh = time.monotonic()
            if not self.last_sample or self.last_refresh - self.last_sample > 20:
                at = datetime.now(timezone.utc).isoformat()
                with self.db_lock:
                    for d in records:
                        if not d["online"]:
                            continue
                        for o in d["outlets"]:
                            if o["powerW"] is not None or o["energyKwh"] is not None:
                                self.db.execute("INSERT INTO readings(at,device_id,outlet,power_w,energy_kwh) VALUES(?,?,?,?,?)",
                                                (at, d["id"], o["index"], o["powerW"], o["energyKwh"]))
                    self.db.execute("DELETE FROM readings WHERE at < datetime('now', '-30 days')")
                    self.db.commit()
                self.last_sample = self.last_refresh
            return self.snapshot()

    def snapshot(self):
        values = [dict(x, outlets=[dict(o) for o in x["outlets"]]) for x in self.cached.values()]
        online = [x for x in values if x["online"]]
        power = sum(o["powerW"] or 0 for x in online for o in x["outlets"])
        return {
            "devices": values,
            "summary": {"devices": len(values), "online": len(online),
                        "outletsOn": sum(o["on"] is True for x in online for o in x["outlets"]),
                        "powerW": round(power, 2)},
            "currency": "EGP", "pricePerKwh": self.get_price(),
            "refreshedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _source_for(self, device):
        return next(s for s in self.sources if s["id"] == device["source"])

    def control(self, device_id: str, outlet: int, on: bool, confirmed=False):
        if not DEVICE_PATTERN.fullmatch(str(device_id)) or type(outlet) is not int or outlet < 0 or outlet > 4 or type(on) is not bool:
            raise HubError("Invalid control parameters")
        if outlet == 0 and confirmed is not True:
            raise HubError("Whole-strip control requires explicit confirmation", 428)
        self.refresh(force=True)
        device = self.cached.get(device_id)
        if not device:
            raise HubError("Device not found", 404)
        if not device["controlAvailable"]:
            raise HubError("Device offline or not ready", 409)
        source = self._source_for(device)
        if source["type"] == "stock":
            body = json.dumps({"mac": device["mac"], "outlet": outlet, "on": on}).encode("utf-8")
            ack = self.request(source, "/api/onoff", method="POST", body=body)
            if ack.get("ok") is not True or ack.get("confirmed") is not True:
                raise HubError("Stock command not confirmed; refresh before retrying", 504)
        else:
            status = self.request(source, "/api/status")
            live = self.request(source, "/api/device")
            if mac_id(status.get("mac", "")) != device["mac"]:
                raise HubError("IP address belongs to a different device", 409)
            if status.get("state") != 5 or status.get("hardware_ready") is not True or live.get("hardware_ready") is not True:
                raise HubError("Device not ready", 409)
            # Firmware's whole-strip command is channel 5 (index byte 4).
            raw = bytes((4 if outlet == 0 else outlet - 1, int(on)))
            ack = self.request(source, "/api/control", method="POST", body=raw,
                               content_type="application/octet-stream")
            if ack.get("accepted") is not True:
                raise HubError("Standalone command rejected", 502)
            verified = False
            for _ in range(16):
                time.sleep(.2)
                try:
                    live = self.request(source, "/api/device")
                except HubError:
                    continue
                channels = live.get("channels") or []
                if len(channels) != 4:
                    continue
                verified = (all(x.get("on") is on for x in channels) if outlet == 0
                            else channels[outlet - 1].get("on") is on)
                if verified:
                    break
            if not verified:
                # Never automatically repeat a write with uncertain outcome.
                raise HubError("Command accepted but not confirmed; do not blindly retry", 504)
        self.refresh(force=True)
        return {"ok": True, "confirmed": True, "deviceId": device_id, "outlet": outlet, "on": on}

    def control_many(self, commands: list[tuple[str, int]], on: bool, confirmed: bool):
        if confirmed is not True or type(on) is not bool:
            raise HubError("Group control requires explicit confirmation", 428)
        if not commands or len(commands) > 200:
            raise HubError("Invalid number of outlets", 400)
        results = []
        for did, outlet in commands:
            try:
                results.append({"deviceId": did, "outlet": outlet,
                                "result": self.control(did, outlet, on, confirmed=True)})
            except HubError as exc:
                results.append({"deviceId": did, "outlet": outlet,
                                "error": str(exc)})
        return {"ok": all("result" in x for x in results),
                "results": results, "partial": any("error" in x for x in results)}

    def control_all(self, on: bool, confirmed: bool):
        self.refresh(force=True)
        commands = [(d["id"], 0) for d in self.cached.values() if d["online"]]
        return self.control_many(commands, on, confirmed)

    def set_alias(self, device_id, outlet, name):
        if not DEVICE_PATTERN.fullmatch(str(device_id)) or type(outlet) is not int or not 0 <= outlet <= 4:
            raise HubError("Invalid alias target")
        value = name_text(name)
        key = "device:" + device_id if outlet == 0 else f"outlet:{device_id}:{outlet}"
        with self.db_lock:
            self.db.execute("INSERT INTO labels(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (key, value))
            self.db.commit()
        if device_id in self.cached:
            self._apply_names(self.cached[device_id])
        return {"ok": True, "name": value, "deviceId": device_id, "outlet": outlet,
                "scope": "PowerA-local-alias"}

    def set_price(self, value):
        if type(value) not in (int, float) or not 0 <= value <= 100:
            raise HubError("Price must be between 0 and 100 EGP/kWh")
        with self.db_lock:
            self.db.execute("INSERT INTO kv(key,value) VALUES('price',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (str(round(value, 4)),))
            self.db.commit()
        return {"ok": True, "pricePerKwh": round(value, 4)}

    def get_price(self):
        with self.db_lock:
            row = self.db.execute("SELECT value FROM kv WHERE key='price'").fetchone()
        return float(row["value"]) if row else 0.0

    def rooms(self):
        with self.db_lock:
            rows = self.db.execute("SELECT id,name FROM rooms ORDER BY name").fetchall()
            members = self.db.execute("SELECT room_id,device_id,outlet FROM room_outlets ORDER BY device_id,outlet").fetchall()
        return [{"id": x["id"], "name": x["name"],
                 "members": [{"deviceId": m["device_id"], "outlet": m["outlet"]}
                             for m in members if m["room_id"] == x["id"]]} for x in rows]

    def room_create(self, name):
        with self.db_lock:
            try:
                row = self.db.execute("INSERT INTO rooms(name) VALUES(?)", (name_text(name),))
                self.db.commit()
            except sqlite3.IntegrityError as exc:
                raise HubError("Room already exists", 409) from exc
        return {"ok": True, "id": row.lastrowid, "name": name}

    def room_member(self, room_id, device_id, outlet):
        if type(room_id) is not int or room_id <= 0 or not DEVICE_PATTERN.fullmatch(str(device_id)) or type(outlet) is not int or not 1 <= outlet <= 4:
            raise HubError("Invalid room membership")
        self.refresh()
        if device_id not in self.cached:
            raise HubError("Device not found", 404)
        with self.db_lock:
            if not self.db.execute("SELECT id FROM rooms WHERE id=?", (room_id,)).fetchone():
                raise HubError("Room not found", 404)
            self.db.execute("INSERT OR IGNORE INTO room_outlets(room_id,device_id,outlet) VALUES(?,?,?)",
                            (room_id, device_id, outlet))
            self.db.commit()
        return {"ok": True}

    def room_control(self, room_id, on, confirmed):
        room = next((x for x in self.rooms() if x["id"] == room_id), None)
        if room is None:
            raise HubError("Room not found", 404)
        return self.control_many([(x["deviceId"], x["outlet"]) for x in room["members"]], on, confirmed)

    def notifications(self):
        with self.db_lock:
            rows = self.db.execute("SELECT * FROM notifications ORDER BY id DESC LIMIT 100").fetchall()
        return [{**dict(x), "is_read": bool(x["is_read"])} for x in rows]

    def notification_read(self, id_):
        if type(id_) is not int or id_ < 1:
            raise HubError("Invalid notification")
        with self.db_lock:
            self.db.execute("UPDATE notifications SET is_read=1 WHERE id=?", (id_,))
            self.db.commit()
        return {"ok": True}

    def history(self, device_id, limit=100):
        if not DEVICE_PATTERN.fullmatch(str(device_id)) or type(limit) is not int or not 1 <= limit <= 1000:
            raise HubError("Invalid history request")
        with self.db_lock:
            rows = self.db.execute("SELECT at,outlet,power_w,energy_kwh FROM readings WHERE device_id=? ORDER BY id DESC LIMIT ?",
                                   (device_id, limit)).fetchall()
        return [dict(x) for x in reversed(rows)]


class ApiHandler(BaseHTTPRequestHandler):
    hub: Hub
    frontend: Path

    def _allowed_lan(self):
        """Unauthenticated local mode; never accept public or cross-subnet callers.

        This is a network boundary, not a replacement for user authentication.
        Keep this server behind a trusted LAN firewall.
        """
        try:
            peer = ipaddress.ip_address(self.client_address[0])
            local = ipaddress.ip_address(self.connection.getsockname()[0])
            host = self.headers.get("Host", "")
            if host.startswith("["):
                return False
            host_name = host.split(":")[0]
            presented = ipaddress.ip_address("127.0.0.1" if host_name == "localhost" else host_name)
            if peer.version != 4 or local.version != 4 or presented.version != 4:
                return False
            private = (ipaddress.ip_network("10.0.0.0/8"),
                       ipaddress.ip_network("172.16.0.0/12"),
                       ipaddress.ip_network("192.168.0.0/16"))
            if peer.is_loopback and local.is_loopback:
                return presented.is_loopback
            if not (any(peer in r for r in private) and any(local in r for r in private)):
                return False
            return (peer in ipaddress.ip_network(str(local) + "/24", strict=False)
                    and presented == local)
        except (ValueError, IndexError, OSError):
            return False

    def _check_origin(self):
        if self.headers.get("X-PowerA-Client") != "PowerA":
            raise HubError("PowerA local client header required", 403)
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            raise HubError("Cross-origin control is blocked", 403)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        for k, v in {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)), "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
        }.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _asset(self, name):
        ext = "text/html" if name == "index.html" else "text/css" if name.endswith(".css") else "text/javascript"
        data = (self.frontend / name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ext + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            if not self._allowed_lan():
                raise HubError("PowerA only accepts callers on the same trusted local subnet", 403)
            path = urlparse(self.path).path
            if path in ("/", "/index.html", "/app.js", "/style.css"):
                self._asset("index.html" if path == "/" else path.lstrip("/"))
                return
            params = parse_qs(urlparse(self.path).query)
            if path == "/api/status":
                self._json(self.hub.refresh())
            elif path == "/api/rooms":
                self._json({"rooms": self.hub.rooms()})
            elif path == "/api/notifications":
                self._json({"notifications": self.hub.notifications()})
            elif path == "/api/schedules":
                self._json({"schedules": self.hub.scheduler.list()})
            elif path == "/api/timers":
                self._json({"timers": self.hub.scheduler.timers()})
            elif path == "/api/history":
                self._json({"history": self.hub.history(params.get("deviceId", [""])[0],
                                      int(params.get("limit", ["100"])[0]))})
            elif path == "/api/health":
                self._json({"ok": True, "app": "PowerA", "apiVersion": 2, "mode": "lan"})
            else:
                raise HubError("Not found", 404)
        except (HubError, ScheduleError, ValueError, OSError) as exc:
            self._json({"error": str(exc)}, getattr(exc, "status", 400))

    def do_POST(self):
        try:
            if not self._allowed_lan():
                raise HubError("PowerA only accepts callers on the same trusted local subnet", 403)
            self._check_origin()
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise HubError("Expected application/json")
            size = int(self.headers.get("Content-Length", "0"))
            if size < 2 or size > 8192:
                raise HubError("Invalid request size")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise HubError("Expected JSON object")
            path = urlparse(self.path).path
            if path == "/api/control":
                res = self.hub.control(data.get("deviceId"), data.get("outlet"), data.get("on"),
                                       data.get("confirm") is True)
            elif path == "/api/control-all":
                res = self.hub.control_all(data.get("on"), data.get("confirm") is True)
            elif path == "/api/alias":
                res = self.hub.set_alias(data.get("deviceId"), data.get("outlet"), data.get("name"))
            elif path == "/api/price":
                res = self.hub.set_price(data.get("pricePerKwh"))
            elif path == "/api/rooms":
                res = self.hub.room_create(data.get("name"))
            elif path == "/api/rooms/member":
                res = self.hub.room_member(data.get("roomId"), data.get("deviceId"), data.get("outlet"))
            elif path == "/api/rooms/control":
                res = self.hub.room_control(data.get("roomId"), data.get("on"), data.get("confirm") is True)
            elif path == "/api/notifications/read":
                res = self.hub.notification_read(data.get("id"))
            elif path == "/api/schedules":
                res = self.hub.scheduler.create(data)
            elif path == "/api/schedules/enabled":
                res = self.hub.scheduler.set_enabled(data.get("id"), data.get("enabled"))
            elif path == "/api/schedules/remove":
                res = self.hub.scheduler.delete(data.get("id"))
            elif path == "/api/timers":
                res = self.hub.scheduler.start_return_timer(data)
            else:
                raise HubError("Not found", 404)
            self._json(res)
        except (HubError, ScheduleError, json.JSONDecodeError, ValueError, TypeError) as exc:
            self._json({"error": str(exc)}, getattr(exc, "status", 400))


def serve(argv=None):
    parser = argparse.ArgumentParser(description="PowerA multi-firmware local dashboard")
    parser.add_argument("--config", default="powera/config.example.json")
    parser.add_argument("--db", default="powera/data.sqlite3")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8098)
    args = parser.parse_args(argv)
    try:
        with open(args.config, "r", encoding="utf-8") as file:
            cfg = json.load(file)
        if args.host not in ("0.0.0.0", "127.0.0.1"):
            raise HubError("Use 0.0.0.0 for trusted-LAN use or 127.0.0.1 for local-only use")
        hub = Hub(cfg, db_path=args.db)
        class BoundHandler(ApiHandler):
            pass
        BoundHandler.hub = hub
        BoundHandler.frontend = Path(__file__).resolve().parent / "web"
        httpd = ThreadingHTTPServer((args.host, args.port), BoundHandler)
        print(f"PowerA Hub http://{args.host}:{args.port} | {len(hub.sources)} sources")
        print("NO LOGIN / NO TOKEN — same-LAN /24 clients only. Do not port-forward or use untrusted Wi-Fi.")
        stop = threading.Event()
        def poll():
            next_refresh = 0.0
            while not stop.is_set():
                try:
                    now = time.monotonic()
                    if now >= next_refresh:
                        hub.refresh(force=True)
                        next_refresh = now + 25
                    hub.scheduler.tick()
                except Exception as exc:
                    print(f"PowerA poll/schedule warning: {exc}")
                stop.wait(2.0)
        thread = threading.Thread(target=poll, daemon=True)
        thread.start()
        try:
            httpd.serve_forever(poll_interval=.5)
        finally:
            stop.set()
            httpd.server_close()
    except (OSError, ValueError, json.JSONDecodeError, HubError) as exc:
        parser.exit(2, f"PowerA setup error: {exc}\n")


if __name__ == "__main__":
    serve()

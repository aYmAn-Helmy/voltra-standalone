"""Safety-focused integration tests for the independent PowerA Hub."""
from __future__ import annotations

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "powera"))
from hub import Hub, HubError, ApiHandler, private_url, standalone_device


MAC_STOCK = "AABBCCDDEEFF"
MAC_STAND = "001122334455"
STOCK_ORIGIN = "http://127.0.0.1:18080"
STAND_ORIGIN = "http://192.168.0.55"


class FakeTransport:
    def __init__(self):
        self.fail_stock = False
        self.fail_standalone = False
        self.confirm_standalone = True
        self.writes = []
        self.stock = [
            {"mac": MAC_STOCK, "name": "المكتب", "online": True, "fw": "0.1.54-1.0.66",
             "power_w": 92, "energy_kwh": 4.5, "voltage": 220, "current_a": .4, "rssi": -48,
             "outlets": [{"n": i, "on": i == 1, "power_w": 92 if i == 1 else 0,
                          "energy_kwh": 1.125, "temp_c": 24} for i in range(1, 5)]}
        ]
        self.standalone = {
            "name": "الصالة", "hardware_ready": True,
            "voltage_dv": 2201, "current_ma": 500, "power_mw": 110000,
            "meter_wh": 1500, "channels": [
                {"name": "مخرج " + str(i), "on": i == 1, "power_mw": 110000 if i == 1 else 0,
                 "meter_wh": 300, "temp_dc": 265, "current_ma": 120}
                for i in range(1, 5)
            ],
        }

    def __call__(self, origin, path, *, method="GET", body=None, token="", content_type="application/json", timeout=5):
        if origin == STOCK_ORIGIN:
            if self.fail_stock:
                raise HubError("stock disconnected", 502)
            if path == "/api/state":
                return {"devices": self.stock}
            if path == "/api/onoff":
                self.writes.append((origin, path, body))
                info = json.loads(body)
                for device in self.stock:
                    if device["mac"] == info["mac"]:
                        for o in device["outlets"]:
                            if info["outlet"] in (0, o["n"]):
                                o["on"] = info["on"]
                return {"ok": True, "confirmed": True}
        if origin == STAND_ORIGIN:
            if self.fail_standalone:
                raise HubError("standalone disconnected", 502)
            if path == "/api/status":
                return {"mac": "00:11:22:33:44:55", "state": 5, "hardware_ready": True, "rssi": -56}
            if path == "/api/device":
                return self.standalone
            if path == "/api/control":
                self.writes.append((origin, path, body))
                if self.confirm_standalone:
                    channel, enabled = body
                    for i, o in enumerate(self.standalone["channels"]):
                        if channel in (4, i):
                            o["on"] = bool(enabled)
                return {"accepted": True}
        raise HubError("Unknown fake endpoint", 404)


class PowerAHubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.transport = FakeTransport()
        self.hub = Hub({
            "sources": [
                {"id": "stock-home", "type": "stock", "url": STOCK_ORIGIN, "token": "other"},
                {"id": "stand-living", "type": "standalone", "url": STAND_ORIGIN, "mac": MAC_STAND}
            ]
        }, db_path=str(Path(self.temp.name) / "test.sqlite3"), requester=self.transport)

    def tearDown(self):
        self.hub.db.close()
        self.temp.cleanup()

    def test_merges_two_firmwares_and_real_metering(self):
        result = self.hub.refresh(force=True)
        self.assertEqual(result["summary"]["devices"], 2)
        self.assertEqual(result["summary"]["online"], 2)
        self.assertAlmostEqual(result["summary"]["powerW"], 202)
        self.assertEqual(result["summary"]["outletsOn"], 2)
        stand = next(d for d in result["devices"] if d["type"] == "standalone")
        self.assertEqual(stand["id"], "standalone:" + MAC_STAND)
        self.assertEqual(stand["voltageV"], 220.1)
        self.assertEqual(stand["outlets"][0]["energyKwh"], .3)

    def test_standalone_identity_must_match_pinned_mac(self):
        source = dict(self.hub.sources[1])
        source["mac"] = "FFFFFFFFFFFF"
        with self.assertRaises(HubError):
            standalone_device(source, {"mac": "00:11:22:33:44:55", "state": 5}, {"channels": [{}] * 4})

    def test_stock_explicit_switch_and_whole_strip_confirmation(self):
        self.hub.refresh(force=True)
        with self.assertRaises(HubError) as ex:
            self.hub.control("stock:" + MAC_STOCK, 0, False)
        self.assertEqual(ex.exception.status, 428)
        self.assertEqual(self.transport.writes, [])
        confirmed = self.hub.control("stock:" + MAC_STOCK, 1, False)
        self.assertTrue(confirmed["confirmed"])
        self.assertFalse(self.transport.stock[0]["outlets"][0]["on"])
        self.hub.control("stock:" + MAC_STOCK, 0, True, confirmed=True)
        self.assertTrue(all(o["on"] for o in self.transport.stock[0]["outlets"]))

    def test_standalone_binary_protocol_is_not_replayed(self):
        self.hub.refresh(force=True)
        self.hub.control("standalone:" + MAC_STAND, 2, True)
        self.assertEqual(self.transport.writes[-1], (STAND_ORIGIN, "/api/control", b"\x01\x01"))
        self.transport.confirm_standalone = False
        self.transport.standalone["channels"][2]["on"] = False
        with self.assertRaisesRegex(HubError, "not confirmed"):
            self.hub.control("standalone:" + MAC_STAND, 3, True)
        self.assertEqual([x for x in self.transport.writes if x[0] == STAND_ORIGIN][-1][2], b"\x02\x01")
        self.assertEqual(len([x for x in self.transport.writes if x[0] == STAND_ORIGIN]), 2)

    def test_offline_metering_never_looks_live(self):
        self.hub.refresh(force=True)
        self.transport.fail_standalone = True
        values = self.hub.refresh(force=True)["devices"]
        standalone = next(x for x in values if x["type"] == "standalone")
        self.assertFalse(standalone["online"])
        self.assertIsNone(standalone["powerW"])
        self.assertIsNone(standalone["voltageV"])
        self.assertTrue(all(o["powerW"] is None and o["on"] is None for o in standalone["outlets"]))
        self.transport.fail_stock = False
        self.transport.stock[0]["online"] = False
        values = self.hub.refresh(force=True)["devices"]
        stock = next(x for x in values if x["type"] == "stock")
        self.assertFalse(stock["online"])
        self.assertIsNone(stock["powerW"])
        self.assertTrue(all(o["powerW"] is None and o["on"] is None for o in stock["outlets"]))

    def test_whole_network_command_requires_confirmation(self):
        self.hub.refresh(force=True)
        with self.assertRaises(HubError):
            self.hub.control_all(False, False)
        self.assertEqual(self.transport.writes, [])
        result = self.hub.control_all(False, True)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual([x for x in self.transport.writes if x[0] == STAND_ORIGIN][0][-1], b"\x04\x00")

    def test_local_aliases_rooms_cost_history_and_inbox(self):
        self.hub.refresh(force=True)
        self.hub.set_alias("stock:" + MAC_STOCK, 1, "كمبيوتر المكتب")
        self.hub.set_alias("stock:" + MAC_STOCK, 0, "غرفة العمل")
        self.assertEqual(next(d for d in self.hub.refresh(force=True)["devices"] if d["type"] == "stock")["outlets"][0]["name"],
                         "كمبيوتر المكتب")
        self.assertEqual(self.hub.set_price(2.25)["pricePerKwh"], 2.25)
        room = self.hub.room_create("المكتب")
        self.hub.room_member(room["id"], "stock:" + MAC_STOCK, 1)
        self.hub.room_member(room["id"], "standalone:" + MAC_STAND, 4)
        self.assertEqual(len(self.hub.rooms()[0]["members"]), 2)
        result = self.hub.room_control(room["id"], True, True)
        self.assertTrue(result["ok"])
        self.assertTrue(self.hub.history("stock:" + MAC_STOCK))
        self.transport.fail_standalone = True
        self.hub.refresh(force=True)
        inbox = self.hub.notifications()
        self.assertTrue(any(n["kind"] == "offline" for n in inbox))
        self.hub.notification_read(inbox[0]["id"])
        self.assertTrue(self.hub.notifications()[0]["is_read"])

    def test_reject_public_sources_and_invalid_parameters(self):
        for url in ("https://192.168.0.1", "http://8.8.8.8", "http://169.254.0.1",
                    "http://user:pw@192.168.0.1", "http://example.com", "http://192.168.1.1/?x=1"):
            with self.subTest(url=url), self.assertRaises(HubError):
                private_url(url)
        self.hub.refresh(force=True)
        for outlet in (True, -1, 5, 2.5):
            with self.subTest(outlet=outlet), self.assertRaises(HubError):
                self.hub.control("stock:" + MAC_STOCK, outlet, True)
        with self.assertRaises(HubError):
            self.hub.set_price(-2)
        with self.assertRaises(HubError):
            self.hub.set_alias("stock:" + MAC_STOCK, 0, "Bad\nName")

    def test_web_routes_and_required_token(self):
        class Handler(ApiHandler):
            pass
        Handler.hub = self.hub
        Handler.frontend = Path(__file__).resolve().parents[1] / "powera" / "web"
        Handler.auth_token = "this-is-a-strong-testing-token"
        Handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        origin = "http://127.0.0.1:" + str(server.server_port)
        try:
            with self.assertRaises(HTTPError) as unauthorized:
                urlopen(origin + "/api/status", timeout=3)
            self.assertEqual(unauthorized.exception.code, 401)
            request = Request(origin + "/api/status", headers={"X-PowerA-Token": Handler.auth_token})
            result = json.load(urlopen(request, timeout=3))
            self.assertEqual(result["summary"]["devices"], 2)
            html = urlopen(origin + "/", timeout=3).read().decode()
            self.assertIn("PowerA", html)
            self.assertIn("Double", html) if False else None
            post = Request(origin + "/api/price", method="POST",
                           headers={"X-PowerA-Token": Handler.auth_token, "Content-Type": "application/json"},
                           data=b'{"pricePerKwh":2.7}')
            self.assertEqual(json.load(urlopen(post, timeout=3))["pricePerKwh"], 2.7)
        finally:
            server.shutdown()
            server.server_close()
            t.join(3)


if __name__ == "__main__":
    unittest.main()

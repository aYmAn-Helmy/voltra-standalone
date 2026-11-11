"""PowerA OEM Stock TCP listener integration tests with a simulated physical strip.

Tests cover the text wire protocol, actual socket exchange, relay readback,
the zero-third-party bridge Hub configuration and no blind command retries.
"""
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from powera.stock_bridge import StockBridge, StockError, parse_records, private_peer
from powera.hub import Hub

STOCK_MAC = "112233445566"
STAND_MAC = "001122334455"


def wire_record(n, on, power=300):
    return f"{n}:0;{'on' if on else 'off'};0;normal;normal;{power};00000064;00000000;00000000;ok;00;25"


class FakeStockStrip:
    def __init__(self, port):
        self.port = port
        self.socket = None
        self.responses = True
        self.sent = []
        self.channels = {i: i == 1 for i in range(1, 5)}
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def report(self):
        return "up:getinfo:" + ";".join(wire_record(i, self.channels[i]) for i in range(1, 5)) + "\r\n"

    def run(self):
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=3) as sock:
                self.socket = sock
                sock.sendall(f"up:bootinfo:lgutap;{STOCK_MAC};001122334455;0.1.54-1.0.66;connect\r\n".encode())
                self.ready.set()
                with sock.makefile("rb") as inp:
                    while not self.closed.is_set():
                        line = inp.readline()
                        if not line:
                            break
                        cmd = line.decode("ascii").strip()
                        self.sent.append(cmd)
                        if cmd == "up:getinfo:all" and self.responses:
                            sock.sendall(self.report().encode())
                        elif cmd.startswith("up:onoff:"):
                            _, _, channel, word = cmd.split(":")
                            self.channels[int(channel)] = word == "on"
                            sock.sendall(f"up:onoff:{channel}:{word}\r\n".encode())
                        elif cmd == "up:power_report:1:vol":
                            sock.sendall(b"up:power_report:1:239300\r\n")
                        elif cmd == "up:query:wifirssi":
                            sock.sendall(b"up:query:-42\r\n")
        except (OSError, ValueError):
            pass

    def stop(self):
        self.closed.set()
        if self.socket:
            try: self.socket.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            try: self.socket.close()
            except OSError: pass
        self.worker.join(2)


def wait_for(predicate, seconds=3):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return True
        time.sleep(.02)
    return False


class StockListenerTests(unittest.TestCase):
    def setUp(self):
        self.bridge = StockBridge(host="127.0.0.1", port=0).start()
        self.simulated = FakeStockStrip(self.bridge.port)
        self.assertTrue(self.simulated.ready.wait(2))
        self.assertTrue(wait_for(lambda: bool(self.bridge.snapshot()) and
                      self.bridge.snapshot()[0]["ready"]))
        self.hub = Hub({"sources": [{"id": "stock-native", "type": "stock-native"}]})
        self.hub.stock_bridge = self.bridge

    def tearDown(self):
        self.simulated.stop()
        self.bridge.stop()
        self.hub.db.close()

    def test_boot_handshake_native_discovery_and_power(self):
        data = self.hub.refresh(force=True)
        self.assertEqual(data["summary"]["devices"], 1)
        self.assertEqual(data["summary"]["online"], 1)
        self.assertTrue(data["stockReceiver"]["listening"])
        self.assertEqual(data["stockReceiver"]["port"], self.bridge.port)
        d = data["devices"][0]
        self.assertEqual(d["id"], "stock:" + STOCK_MAC)
        self.assertEqual(d["type"], "stock")
        self.assertTrue(d["controlAvailable"])
        self.assertEqual([o["on"] for o in d["outlets"]], [True, False, False, False])
        self.assertEqual(round(d["powerW"]), 1, "power is in watts, not raw milliwatts")
        self.assertTrue(all(o["energyKwh"] == .1 for o in d["outlets"]))

    def test_single_and_whole_strip_relay_verified_and_no_token(self):
        self.hub.refresh(force=True)
        self.hub.control("stock:" + STOCK_MAC, 2, True)
        self.assertEqual(self.simulated.channels[2], True)
        self.assertTrue(self.hub.control("stock:" + STOCK_MAC, 0, False, confirmed=True)["confirmed"])
        self.assertTrue(all(x is False for x in self.simulated.channels.values()))
        self.assertEqual(self.hub.refresh(force=True)["summary"]["outletsOn"], 0)
        self.assertIn("up:onoff:2:on", self.simulated.sent)
        self.assertTrue(all("X-Token" not in x for x in self.simulated.sent))

    def test_ack_without_readback_never_counts_as_success_or_retries(self):
        self.hub.refresh(force=True)
        self.simulated.responses = False
        with self.assertRaisesRegex(Exception, "no fresh state"):
            self.hub.control("stock:" + STOCK_MAC, 2, True)
        self.assertEqual(self.simulated.sent.count("up:onoff:2:on"), 1)

    def test_close_marks_device_offline_without_fake_zero_power(self):
        self.hub.refresh(force=True)
        self.simulated.stop()
        self.assertTrue(wait_for(lambda: self.bridge.snapshot() and
                    self.bridge.snapshot()[0]["online"] is False))
        d = self.hub.refresh(force=True)["devices"][0]
        self.assertFalse(d["online"])
        self.assertFalse(d["controlAvailable"])
        self.assertIsNone(d["outlets"][0]["on"])
        self.assertIsNone(d["outlets"][0]["powerW"])

    def test_native_and_standalone_share_same_snapshot(self):
        mac = "00:11:22:33:44:55"
        def responder(origin, path, **kwargs):
            if path == "/api/status":
                return {"mac": mac, "state": 5, "hardware_ready": True}
            if path == "/api/device":
                return {"name": "Another strip", "hardware_ready": True,
                        "channels": [{"name": f"Ch {i}", "on": False,
                                      "power_mw": 0, "meter_wh": 0}
                                     for i in range(1, 5)]}
            raise AssertionError("Unexpected request " + path)
        self.hub.db.close()
        mixed = Hub({"sources": [
            {"id": "stock-native", "type": "stock-native"},
            {"id": "stand", "type": "standalone", "url": "http://192.168.1.50",
             "mac": mac}
        ]}, requester=responder)
        mixed.stock_bridge = self.bridge
        try:
            snap = mixed.refresh(force=True)
            self.assertEqual({x["type"] for x in snap["devices"]}, {"stock", "standalone"})
            self.assertEqual(snap["summary"]["devices"], 2)
        finally:
            mixed.db.close()


class ParserTests(unittest.TestCase):
    def test_four_channel_record_parsing(self):
        raw = "up:getinfo:" + ";".join(
            wire_record(i, i % 2 == 0, i * 1200) for i in range(1, 6))
        outlets = parse_records(raw)
        self.assertEqual(len(outlets), 4)
        self.assertEqual([x["power_w"] for x in outlets], [1.2, 2.4, 3.6, 4.8])
        self.assertEqual(outlets[0]["energy_kwh"], .1)
        self.assertEqual([x["on"] for x in outlets], [False, True, False, True])

    def test_reject_incomplete_report(self):
        self.assertEqual(parse_records("up:getinfo:" + wire_record(1, True)), [])

    def test_private_ip_filter(self):
        self.assertTrue(private_peer("192.168.1.123"))
        self.assertTrue(private_peer("10.0.0.5"))
        self.assertTrue(private_peer("127.0.0.1"))
        self.assertFalse(private_peer("8.8.8.8"))
        self.assertFalse(private_peer("169.254.13.2"))
        self.assertFalse(private_peer("2001:db8::1"))


if __name__ == "__main__":
    unittest.main()

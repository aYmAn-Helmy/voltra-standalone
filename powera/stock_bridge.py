"""Native LG U+ / TONLY MTTL-W01 stock-firmware TCP transport for PowerA.

Independent implementation of the documented line-oriented TCP 10086 protocol.
The STRIP connects to this listener. LAN scanning cannot find an unprovisioned
stock strip; its stored server IP must point to the computer running PowerA.
No third-party controller or upstream source is bundled here.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import socketserver
import threading
import time

BOOT = re.compile(r"^up:bootinfo:([^;\r\n]{1,80});([0-9a-fA-F]{12});([0-9a-fA-F]{12});([^;\r\n]{1,80});connect$")
RECORD = re.compile(
    r"(?P<channel>[1-5]):(?P<runtime>-?\d+);(?P<relay>on|off);"
    r"(?P<state>-?\d+);(?P<overload>[^;:]+);(?P<overheat>[^;:]+);"
    r"(?P<watts>-?\d+);(?P<energy>[0-9a-fA-F]{8});"
    r"(?P<previous>[0-9a-fA-F]{8});(?P<config>[0-9a-fA-F]{8});"
    r"(?P<status>[^;:]+);(?P<event>[0-9a-fA-F]{2});(?P<temp>-?\d+)",
    re.IGNORECASE,
)
EVENT = re.compile(r"^up:event:onoff:([0-4]):(on|off)$", re.IGNORECASE)
VOLTAGE = re.compile(r"^up:power_report:([1-5]):(-?\d+)$", re.IGNORECASE)
RSSI = re.compile(r"^up:query:(-?\d+)$")
MAX_LINE = 8192
PRIVATE = tuple(ipaddress.ip_network(n) for n in
                ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
REFRESH_SECONDS = 5.0
STALE_SECONDS = 20.0


class StockError(Exception):
    """A stock strip's command could not be confirmed. Never auto-retry writes."""


def parse_records(message: str) -> list[dict]:
    """Parse a complete, four-outlet hardware snapshot (not an ACK).

    The fifth wire record is an aggregate and intentionally not returned.
    Absent or malformed channels invalidate the entire measurement.
    """
    if not message.lower().startswith("up:getinfo:"):
        return []
    found = {}
    for match in RECORD.finditer(message[len("up:getinfo:"):]):
        v = match.groupdict()
        ch = int(v["channel"])
        if ch not in range(1, 5) or ch in found:
            continue
        watts = int(v["watts"]) / 1000
        energy = int(v["energy"], 16) / 1000
        if not (0 <= watts <= 100000 and 0 <= energy <= 4294967.295):
            return []
        found[ch] = {
            "n": ch, "on": v["relay"].lower() == "on",
            "power_w": round(watts, 3), "energy_kwh": round(energy, 3),
            "temp_c": int(v["temp"]),
            "overload": v["overload"], "overheat": v["overheat"],
        }
    return [found[i] for i in range(1, 5)] if len(found) == 4 else []


def private_peer(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return (isinstance(ip, ipaddress.IPv4Address)
            and (ip.is_loopback or any(ip in net for net in PRIVATE)))


class StripConnection:
    def __init__(self, bridge, conn, mac, model, firmware, ip):
        self.bridge = bridge
        self.conn = conn
        self.mac = mac
        self.ip = ip
        self.model = model
        self.firmware = firmware
        self.condition = threading.Condition(threading.RLock())
        self.transaction = threading.Lock()
        self.open = True
        self.sequence = 0
        self.last_report = 0.0
        self.voltage = None
        self.rssi = None
        self.outlets = []
        self.last_receive = time.monotonic()

    def snapshot(self) -> dict:
        with self.condition:
            ready = self.open and len(self.outlets) == 4 and (
                time.monotonic() - self.last_report < STALE_SECONDS)
            outlets = [{**o} for o in self.outlets] if ready else [
                {"n": i, "on": None, "power_w": None, "energy_kwh": None,
                 "temp_c": None} for i in range(1, 5)]
            return {
                "mac": self.mac, "name": "MTTL " + self.mac[-6:],
                "model": self.model, "fw": self.firmware, "ip": self.ip,
                "online": self.open, "ready": ready,
                "on": any(o["on"] is True for o in outlets) if ready else None,
                "power_w": round(sum(o["power_w"] for o in outlets), 3) if ready else None,
                "energy_kwh": (round(sum(o["energy_kwh"] for o in outlets), 3)
                               if ready else None),
                "voltage": self.voltage if ready else None,
                "current_a": None,   # No direct stock current measurement available.
                "rssi": self.rssi if ready else None,
                "outlets": outlets,
            }

    def send(self, line: str):
        with self.condition:
            if not self.open:
                raise StockError("Stock device disconnected")
            try:
                self.conn.sendall((line + "\r\n").encode("ascii"))
            except OSError as exc:
                raise StockError("Stock socket send failed") from exc

    def receive(self, message: str):
        self.last_receive = time.monotonic()
        if message.lower().startswith("up:getinfo:"):
            channels = parse_records(message)
            if len(channels) == 4:
                with self.condition:
                    if self.open:
                        self.outlets = channels
                        self.last_report = time.monotonic()
                        self.sequence += 1
                        self.condition.notify_all()
            return
        m = VOLTAGE.fullmatch(message)
        if m:
            raw = int(m.group(2))
            if raw >= 50_000:
                with self.condition:
                    self.voltage = round(raw / 1000, 2)
            return
        m = RSSI.fullmatch(message)
        if m:
            with self.condition:
                self.rssi = int(m.group(1))
            return
        m = EVENT.fullmatch(message)
        if m:
            index = int(m.group(1))
            if index in range(1, 5):
                with self.condition:
                    for o in self.outlets:
                        if o["n"] == index:
                            o["on"] = m.group(2).lower() == "on"

    def request_state(self, timeout: float = 4.0) -> bool:
        with self.condition:
            baseline = self.sequence
            self.send("up:getinfo:all")
            deadline = time.monotonic() + timeout
            while self.open and self.sequence <= baseline:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(timeout=remaining)
            return self.open and self.sequence > baseline

    def refresh(self):
        if not self.transaction.acquire(blocking=False):
            return
        try:
            if self.request_state(timeout=3):
                with self.condition:
                    self._polls = getattr(self, "_polls", 0) + 1
                    every_third = self._polls % 3 == 0
                if every_third:
                    self.send("up:power_report:1:vol")
                    self.send("up:query:wifirssi")
        except StockError:
            pass
        finally:
            self.transaction.release()

    def command(self, channels: list[int], on: bool) -> bool:
        if not channels or any(ch not in (1, 2, 3, 4) for ch in channels):
            raise StockError("Invalid stock outlet")
        with self.transaction:
            with self.condition:
                if not self.open or not self.outlets or (
                    time.monotonic() - self.last_report > STALE_SECONDS):
                    raise StockError("Stock strip offline or sensor data stale")
            # Send each channel once. Commands may be partially applied if the
            # socket drops; do not auto-repeat any uncertain write.
            for channel in channels:
                self.send(f"up:onoff:{channel}:{'on' if on else 'off'}")
            # Read hardware relay state. An ON/OFF ACK alone is NOT confirmation.
            time.sleep(0.3)
            if not self.request_state(timeout=4):
                raise StockError("Stock command was sent but no fresh state returned; do not retry blindly")
            with self.condition:
                states = {o["n"]: o["on"] for o in self.outlets}
                if not all(states.get(i) is on for i in channels):
                    raise StockError("Stock command not confirmed by relay readback")
                return True

    def close(self):
        with self.condition:
            self.open = False
            self.condition.notify_all()
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.conn.close()
        except OSError:
            pass


class StockBridge:
    """Threaded native TCP listener; one session per physical MAC.

    Sockets accept only private/loopback IPv4 peers. By design there is no
    authentication in this preview; the host's firewall must be LAN-only.
    """
    def __init__(self, host: str = "0.0.0.0", port: int = 10086, allowed_macs=()):
        self.host = host
        self.port = port
        self.allowed_macs = frozenset(x.replace(":", "").upper() for x in allowed_macs)
        self.lock = threading.RLock()
        self.devices = {}     # known MAC -> last known metadata (no stale relay data)
        self.sessions = {}
        self.server = None
        self.server_thread = None
        self.poll_thread = None
        self.stopping = threading.Event()

    def register(self, sock, line: str, ip: str) -> StripConnection | None:
        m = BOOT.fullmatch(line)
        if not m or not private_peer(ip):
            return None
        model, mac, _, firmware = m.groups()
        mac = mac.upper()
        if self.allowed_macs and mac not in self.allowed_macs:
            return None
        candidate = StripConnection(self, sock, mac, model, firmware, ip)
        with self.lock:
            previous = self.sessions.get(mac)
            self.devices[mac] = {"mac": mac, "name": "MTTL " + mac[-6:],
                                 "fw": firmware, "model": model, "ip": ip}
            self.sessions[mac] = candidate
        if previous is not None:
            previous.close()
        return candidate

    def detach(self, session):
        with self.lock:
            if self.sessions.get(session.mac) is session:
                del self.sessions[session.mac]
        session.close()

    def snapshot(self) -> list[dict]:
        with self.lock:
            known = [dict(d) for d in self.devices.values()]
            sessions = dict(self.sessions)
        entries = []
        for meta in known:
            active = sessions.get(meta["mac"])
            if active is not None and active.open:
                entries.append(active.snapshot())
                continue
            entries.append({
                **meta, "online": False, "ready": False,
                "power_w": None, "energy_kwh": None, "voltage": None,
                "current_a": None, "rssi": None, "on": None,
                "outlets": [{"n": i, "on": None, "power_w": None,
                             "energy_kwh": None, "temp_c": None}
                            for i in range(1, 5)],
            })
        return entries

    def command(self, mac: str, outlet: int, on: bool) -> bool:
        with self.lock:
            session = self.sessions.get(mac.upper())
        if session is None or not session.open:
            raise StockError("Stock strip disconnected")
        if outlet not in (0, 1, 2, 3, 4) or type(on) is not bool:
            raise StockError("Invalid stock control parameters")
        return session.command([1, 2, 3, 4] if outlet == 0 else [outlet], on)

    def poll(self):
        with self.lock:
            active = list(self.sessions.values())
        for session in active:
            if self.stopping.is_set():
                break
            session.refresh()

    def start(self):
        if self.server is not None:
            return self
        bridge = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                ip = self.client_address[0]
                if not private_peer(ip):
                    return
                self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                session = None
                try:
                    while not bridge.stopping.is_set():
                        line = self.rfile.readline(MAX_LINE + 1)
                        if not line or len(line) > MAX_LINE:
                            break
                        text = line.replace(b"\x00", b"").decode("utf-8", "replace").strip("\r\n ")
                        if session is None:
                            session = bridge.register(self.request, text, ip)
                            if session is None:
                                # Only the expected boot handshake is allowed.
                                break
                            # Request immediate state without blocking the reader
                            # thread which receives that response.
                            session.send("up:getinfo:all")
                        else:
                            session.receive(text)
                except (OSError, ValueError, StockError):
                    pass
                finally:
                    if session is not None:
                        bridge.detach(session)

        class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.stopping.clear()
        self.server = Server((self.host, self.port), Handler)
        self.port = self.server.server_address[1]
        self.server_thread = threading.Thread(target=self.server.serve_forever,
                                               kwargs={"poll_interval": 0.2},
                                               daemon=True, name="powera-stock-listener")
        self.server_thread.start()
        def background():
            while not self.stopping.wait(REFRESH_SECONDS):
                self.poll()
        self.poll_thread = threading.Thread(target=background, daemon=True,
                                            name="powera-stock-refresh")
        self.poll_thread.start()
        return self

    def stop(self):
        self.stopping.set()
        srv = self.server
        self.server = None
        if srv is not None:
            srv.shutdown()
            srv.server_close()
        with self.lock:
            sessions = list(self.sessions.values())
        for session in sessions:
            session.close()
        if self.server_thread is not None:
            self.server_thread.join(timeout=2)
        if self.poll_thread is not None:
            self.poll_thread.join(timeout=2)


def provision(server_ip: str, ssid: str, password: str, *, host="192.168.1.1", port=30300):
    """Point an OEM strip in SoftAP mode at a private PowerA host.

    Requires caller to be connected to the device's own Wi-Fi. No firmware
    flashing. Must be an explicit physical setup operation.
    """
    if not private_peer(server_ip) or ":" in server_ip or not isinstance(ssid, str) \
       or not ssid or ":" in ssid or any(x in ssid for x in "\r\n") \
       or not isinstance(password, str) or not password or ":" in password \
       or any(x in password for x in "\r\n") or len(ssid.encode()) > 32 \
       or len(password.encode()) > 63:
        raise StockError("Invalid private PowerA IP or Wi-Fi credentials")
    results = []
    for command, answer in (
        (f"up:ip:{server_ip}", "up:ip:ip_ok"),
        (f"up:connect:{ssid}:{password}", "up:connect:connect_ok")
    ):
        with socket.create_connection((host, port), timeout=6) as sock:
            sock.settimeout(6)
            sock.sendall((command + "\r\n").encode("utf-8"))
            response = bytearray()
            while b"\n" not in response and len(response) < 2048:
                part = sock.recv(256)
                if not part:
                    break
                response.extend(part)
            text = response.decode("utf-8", "replace").strip()
            if answer not in text:
                raise StockError("Provisioning failed: " + text)
            results.append(text)
    return results


def main():
    import argparse
    import getpass
    parser = argparse.ArgumentParser(description="Provision original MTTL-W01 to the PowerA stock TCP receiver")
    parser.add_argument("provision", choices=("provision",))
    parser.add_argument("--ip", required=True, help="PowerA Hub computer's private IPv4")
    parser.add_argument("--ssid", required=True, help="2.4GHz home Wi-Fi SSID")
    args = parser.parse_args()
    password = getpass.getpass("Wi-Fi password (not echoed): ")
    for reply in provision(args.ip, args.ssid, password):
        print(reply)
    print("Rejoin your usual Wi-Fi. Stock strip should now connect to PowerA TCP 10086.")


if __name__ == "__main__":
    main()

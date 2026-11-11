# PowerA — Local Smart Power

PowerA is an independently implemented unified dashboard and Android application
for LG U+ / Jinheung **MTTL-W01**, covering both **Stock** (native TCP 10086
receiver) and **Standalone** (direct HTTP) firmware devices.

## Stage 2 preview (no account, no token)

PowerA starts directly: **no login screen, no access token, no cloud**.
The Android application automatically scans the connected Wi-Fi subnet for
PowerA Hub on port **8098**, and opens the same responsive web dashboard.
You can enter the Hub IP manually if discovery is not supported by the router.

**Important:** Android is the controller UI; a computer, Raspberry Pi or
always-on home server must run **PowerA Hub**. The Hub itself now includes the
original-firmware **TCP 10086 receiver**; no separate powerk process is needed.
Original stock strips **will not automatically appear through IP scanning**:
each strip must first be provisioned to connect to the Hub computer's IP.

### 1. Run the Hub on a computer or Raspberry Pi

Python 3.10+ recommended (IANA tzdata package / system timezone database is
required for the scheduler). From the repository root:

```bash
git clone --branch PowerA https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
cp powera/config.example.json powera/config.json
# Add Standalone devices by their real LAN IP + MAC if needed (see below).
python3 -m powera.hub --config powera/config.json --db powera/data.sqlite3
```

The Hub defaults to listening on `0.0.0.0:8098` but **only accepts the same
private IPv4 /24 subnet** and localhost. If using only a local browser, add
`--host 127.0.0.1` instead.

- **Stock (original firmware):** no powerk server is required. The new source
  `{"id":"stock-native","type":"stock-native"}` enables the built-in TCP
  receiver on **10086**. If your existing `powera/config.json` is from an
  older release, **replace the old `stock-home` source with `stock-native`**,
  keeping all Standalone sources intact. Stop any running `powerk.py serve`
  process: only one process can listen on TCP 10086 on the same machine.
- **One-time Stock pairing:** each original strip must be told the Hub's
  **local IPv4 address**. Follow the [Arabic stock setup guide](docs/STOCK_PAIRING_AR.md).
- Standalone: add a source with its **real IP and MAC address** to the list:

```json
{
  "id": "standalone-office",
  "type": "standalone",
  "name": "مكتب",
  "url": "http://192.168.0.55",
  "mac": "00:11:22:33:44:55"
}
```

The MAC shown here is a placeholder; replace it with the real device MAC.
You may optionally set `"allowedMacs": ["AA:BB:CC:DD:EE:FF"]` on the
`stock-native` source. A blank/missing list accepts all original-firmware
strips on the trusted LAN. MAC allowlisting is only a basic device filter,
**not strong authentication**, because MAC identifiers can be spoofed.
The device is verified by MAC before commands, blocking accidental control
when the local DHCP server reassigns a remembered address.

### 2. Open on Android or web

Open `http://<YOUR-HUB-IP>:8098` in a browser on the same Wi-Fi, or install
the preview Android APK from [PowerA Releases](https://github.com/aYmAn-Helmy/voltra-standalone/releases/tag/powera-preview-v0.3.0).
Android 8.0+ is supported. The app discovers the Hub automatically in
the **same /24 Wi-Fi segment**; type its IP on the welcome screen if needed.

The new Android app is original source in `powera/android`, independent of the
external Kotlin powerk app, and is built using Java 17 / Android SDK 35:

```bash
gradle -p powera/android :app:assembleDebug
```

This creates `powera/android/app/build/outputs/apk/debug/app-debug.apk`.
GitHub Actions builds a preview APK automatically. Do not distribute the older
upstream submodule as a derivative without obtaining the author's permission.

### 3. Features implemented now

- Native original Stock TCP (10086) reception: parse boot/getinfo, per-outlet
  watts/energy, connection/online status, verified relay read-back and optional
  one-time SoftAP provisioning. No separate Stock HTTP bridge needed.
- Mixed Stock and Standalone cards, independently controlled four-outlet
  switches, whole-strip ON/OFF and all-online-strips ON/OFF.
- Double-tap guard with 3-second window for every power-changing web button.
- Cross-strip rooms, room controls, local names, saved favorites and filters.
- Live sampled watts, cumulative kWh, cost approximation in EGP, per-outlet
  comparison bars and historical SVG energy/power charts.
- **One-time and weekly ON/OFF scheduling**, IANA timezone-aware. Choose days
  and choose an hour using a quick visual Smart Timer or precise time input.
- **Return timer:** change a plug temporarily and attempt to restore its
  original state after 1–1440 minutes; only restore if the physical state still
  matches the expected state.
- Notifications for disconnections, reconnections and automation execution,
  with a read/unread inbox.
- Arabic RTL layout, responsive mobile UI, dark/light mode.

### 4. Important limitations / safety

This is a preview. It has **no login, no token and no account sharing** at the
user's request. Anyone connected to the same trusted LAN subnet can potentially
control your electricity. **Use only trusted private Wi-Fi. Do not open Hub
ports **8098 and 10086** (and any optional legacy Stock HTTP bridge)
to the internet.**
The Hub web API rejects cross-subnet clients and nonlocal HTTP Host headers.
The TCP listener accepts only private/loopback IPv4 peers. These measures reduce exposure but are **not user authentication**.

Timers/schedules run on the Hub, not the firmware. If the Hub is offline at a
scheduled minute or a restore timer expires long before reconnection, the Hub
will **skip that action**, record it in the inbox, and not reissue an uncertain
switch command. Schedule writes are claimed in SQLite *before* execution so a
crash does not cause duplicate execution. Missed rule execution cannot be
replayed, and Hub-based schedules are **not reliable safety devices**.

Automatic overvoltage, undervoltage, overcurrent protection and power-on
recovery are firmware/hardware-specific; they are **not implemented** by this
preview. Email/phone login, Google/Apple ID, cloud sharing, iPhone widgets,
energy-based automation rules and English UI are deferred. Both firmware
types still need real-hardware acceptance testing.

### 5. Run verification

```bash
python3 -m unittest discover -s test -p 'test_powera_*.py' -v
# Includes OEM TCP handshake / readback simulator (no physical device required)
python3 -m unittest discover -s test -p 'test_branding.py' -v
node --check powera/web/app.js
```

See [the implementation status for every requested capability](docs/POWER_A_REQUIREMENTS.md).

## Open-source upstream references and attribution

We implement the publicly documented OEM line-oriented TCP protocol
described in [ahmedtohamy1/powerk](https://github.com/ahmedtohamy1/powerk),
and the Standalone HTTP API documented in
[af950833/mttl_w01_standalone](https://github.com/af950833/mttl_w01_standalone).
The former repository is pinned under `upstream/powerk` as a **Git submodule**
rather than copying its source into PowerA. The original upstream project did
not publish a clear redistribution license when checked on 2026-11-11; obtain
permission before distributing modified copies of its app. PowerA's own Hub,
web frontend and Android launcher are original, separate implementations.

The earlier upstream-name overlay remains in `scripts/` for reference;
**the app now built/released from `powera/android` is the supported PowerA app**.

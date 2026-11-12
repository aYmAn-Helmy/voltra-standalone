# PowerA v0.4.0 Preview — Unified Smart Power

An original local-first controller for **LG U+ / MTTL-W01** with the
**stock firmware TCP 10086 receiver** and **Standalone HTTP API** in a single
Python Hub. The same Arabic RTL responsive dashboard runs in a web browser
and in the independent Android wrapper.

> **Development preview, not a certified electrical controller.** Software
> tests use physical-device protocol simulators; actual stock/Standalone
> hardware compatibility and long-running UI behavior must be confirmed on
> your devices before everyday use. It has NO accounts and NO token
> (temporarily by design). Anyone on the permitted private LAN can operate
> the outlets.

## Changes in v0.4

### Simple daily controls

- Every full outlet tile is a **single-tap ON/OFF control**, with
  keyboard support, a pending indicator, and a fresh relay readback before
  reporting success. No double tap.
- Whole-strip, room, and all-strips power commands keep one explicit
  confirmation dialog. No automatic retries of uncertain power writes.
- A quieter home screen: four output tiles per strip in a 2×2 grid,
  quick energy/status, favorites, connected/offline badges and advanced
  wattage charts under expandable details.
- Arabic RTL mobile layout, bottom navigation, light/dark preference.

### Two-way device-authoritative Standalone settings

From a Standalone card choose **إعدادات الجهاز** to read existing settings
directly from the firmware, then optionally edit and explicitly save:

- Real device and four outlet names (not just browser-local aliases).
- **Up to eight firmware schedules:** daily, selected weekdays, monthly
  date, end-of-month, ON/OFF, device fixed UTC offset in 15-minute steps.
- Device-native auto-off timers for each outlet, 0–1440 minutes.
- Firmware temperature, total-current and total-wattage thresholds and
  enabled masks (only capabilities physically supported by the firmware).
- Physical button locks and nonsecret MQTT settings (existing Wi-Fi/MQTT
  passwords are retained on the device and never exposed).
- The Hub **reads new device settings** automatically and flags changes.
  It **never pushes old cached settings on reconnection**. A write needs
  the revision read from the device, is rechecked for conflicts, sent once,
  then confirmed using repeated GET of the persistent device configuration.
  A lost ACK doesn't trigger an automatic second POST.

The format and behaviour were verified against the published source for
[Standalone firmware v2.1.1](https://github.com/af950833/mttl_w01_standalone).
Older firmware/config formats may not expose this interface and will report
unsupported settings instead of accepting a blind rewrite. The device's
internal schedules keep running while PowerA Hub is offline.

**Unsupported:** independent per-outlet Always ON / Always OFF / Restore
Last State, and staggered power-on delay are not available as editable
settings in the reviewed Standalone firmware. They are deliberately not
exposed as working controls. Firmware power/thermal/current protection is
NOT a substitute for appropriately rated hardware safety devices.

### Measured 7/30/90-day energy history

- Persistent per-**device and outlet** power watts and accumulated kWh.
- New SQLite ledger retains ~**92 days** of sampled readings; 7/30/90 day
  daily totals, outlet comparison, peak W and estimated EGP cost.
- kWh energy uses **differences between sequential cumulative meter
  readings** where available; falls back to clearly labelled estimated
  wattage integration if there is no usable energy counter.
- Missing telemetry, long network outages, meter resets and suspicious
  counter jumps are visibly reported and **not counted as zero or made up**.
  Only observed intervals of 5 minutes or less can contribute.
- The 90-day history **starts recording when this version of PowerA Hub
  is running**, not 90 days into the past. Existing pre-v0.4 raw samples
  are not silently converted to billed energy.

### Scheduling: physical device vs Hub

The scheduling screen distinguishes **device-native** Standalone schedules
(which keep operating even without PowerA) from separately stored **Hub
schedules** (which require the Hub running). Hub jobs are skipped rather
than replayed after significant downtime. Overlapping firmware schedules/
device timers are checked before a Hub schedule is created, re-enabled or
executed; conflicting writes are refused and recorded, not forced.

## Start PowerA Hub (required)

A PC, Raspberry Pi or always-on local server runs the Hub. The Android APK
is an interface, not a TCP receiver; the phone does NOT replace the Hub.

Python **3.10+** with IANA timezone database is recommended.

```bash
git clone --branch PowerA https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
cp powera/config.example.json powera/config.json
# Edit powera/config.json to include YOUR Standalone IP and MAC
python3 -m powera.hub --config powera/config.json --db powera/data.sqlite3
```

Existing installation upgrade (do not delete the SQLite database):
```bash
git switch PowerA
git pull --ff-only
# Stop PowerA Hub first, back up its database, keep the original config:
cp powera/data.sqlite3 powera/data.sqlite3.backup
python3 -m powera.hub --config powera/config.json --db powera/data.sqlite3
```

**Do not replace a working config with the example during an upgrade.**
If you used the old external stock bridge, use this instead of
`stock-home` (leave all Standalone source entries intact):

```json
{
  "sources": [
    {"id":"stock-native","type":"stock-native","name":"المشتركات الرسمية"},
    {"id":"office-standalone","type":"standalone",
      "url":"http://192.168.1.55","mac":"00:11:22:33:44:55"}
  ]
}
```

All addresses/MACs above are **placeholders**. Stock firmware strips must
be provisioned once with **the Hub computer's private IPv4 address** and
connect to its TCP **10086** listener (not the Android phone). Stop the old
powerk process if it owns that port. See the
[Arabic pairing guide](docs/STOCK_PAIRING_AR.md). The Standalone device
can be added by IP + MAC without a stock TCP session.

Web UI: `http://<HUB-LAN-IP>:8098`, or install the
[PowerA 0.4.0 Preview APK](https://github.com/aYmAn-Helmy/voltra-standalone/releases/tag/powera-preview-v0.4.0).
It scans the same trusted Wi-Fi /24 for the Hub; enter the Hub IP manually
when discovery is blocked. Updating **only the APK does not update the
server**: the new settings, UI and history require updating the Python Hub
on your computer or Raspberry Pi as well.

The new Android wrapper's source is `powera/android` (Java 17, Android
SDK 35, Android 8.0+). It is distinct from the unmodified pinned external
powerk submodule.

## Security & compatibility

- This LAN-only preview has **no accounts or access token**, at the user's
  request. The Hub uses same-LAN client checks and restricts cross-origin
  writes; these are NOT real user authentication. Only use your trusted
  private Wi-Fi, never guest/public Wi-Fi, and **never port-forward 8098
  or 10086 onto the internet**.
- Device HTTP/TCP traffic is **not encrypted**. Do not treat this as an
  internet-ready or safety-rated product.
- Other firmware versions, Wi-Fi isolation, stale DHCP IP, or a blocked
  TCP 10086 listener can prevent physical devices from showing up.
- Standalone configuration is saved to flash only on an explicit user
  action, not every telemetry poll. Do not switch off power while it is
  saving; the firmware has its own flash wear and persistence policies.
- Accounts, family sharing, iOS widgets, cloud access and firmware power
  recovery modes are out of scope for this preview.
- The upstream powerk project is linked as a Git submodule, not copied into
  this app. The Stock receiver is our original line-protocol implementation;
  no proprietary upstream source is redistributed here.

## Automated verification

```bash
python3 -m unittest discover -s test -p 'test_powera_*.py' -v
python3 -m unittest discover -s test -p 'test_branding.py' -v
npm install --ignore-scripts --no-audit --no-fund
node --test test/powera-web.test.mjs test/powera-v04-ui.test.mjs
node --check powera/web/app.js
node --check powera/web/device-settings.js
node --check powera/web/energy.js
```

CI additionally compiles the native Android APK. Tests cover native
stock TCP handshake/relay readback; Standalone HTTP settings read/write,
binary-v7 codec, revisions, no blind POST retries and MAC mismatches; IANA
timezones and scheduler crash/missed-time handling; monthly meter deltas and
resets; and DOM interactions of the mobile dashboard. These tests **do not
prove real-hardware or physical electrical safety**.

For capability status and remaining limitations, see
[PowerA requirements](docs/POWER_A_REQUIREMENTS.md).

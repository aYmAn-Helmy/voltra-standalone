# PowerA — Local Smart Power

PowerA is an independently implemented unified dashboard and Android application
for LG U+ / Jinheung **MTTL-W01**, covering both **Stock** (powerk controller)
and **Standalone** firmware devices.

## Stage 2 preview (no account, no token)

PowerA starts directly: **no login screen, no access token, no cloud**.
The Android application automatically scans the connected Wi-Fi subnet for
PowerA Hub on port **8098**, and opens the same responsive web dashboard.
You can enter the Hub IP manually if discovery is not supported by the router.

**Important:** The native Android app does **not** run the stock MTTL controller
by itself. A computer, Raspberry Pi or home server must run the PowerA Hub
continuously, and original Stock strips still need a TCP controller such as
upstream powerk.

### 1. Run the Hub on a computer or Raspberry Pi

Python 3.10+ recommended (IANA tzdata package / system timezone database is
required for the scheduler). From the repository root:

\`\`\`bash
git clone --branch PowerA https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
cp powera/config.example.json powera/config.json
# Set your local stock bridge IP in config.json if it differs from localhost.
python3 -m powera.hub --config powera/config.json --db powera/data.sqlite3
\`\`\`

The Hub defaults to listening on \`0.0.0.0:8098\` but **only accepts the same
private IPv4 /24 subnet** and localhost. If using only a local browser, add
\`--host 127.0.0.1\` instead.

- Stock: run your original [powerk controller](https://github.com/ahmedtohamy1/powerk)
  on the same server (by default \`http://127.0.0.1:8080\`) or set another
  private IP in \`config.json\`.
- Standalone: add a source with its **real IP and MAC address** to the list:

\`\`\`json
{
  "id": "standalone-office",
  "type": "standalone",
  "name": "مكتب",
  "url": "http://192.168.0.55",
  "mac": "00:11:22:33:44:55"
}
\`\`\`

The MAC shown here is a placeholder; replace it with the real device MAC.
The device is verified by MAC before commands, blocking accidental control
when the local DHCP server reassigns a remembered address.

### 2. Open on Android or web

Open \`http://<YOUR-HUB-IP>:8098\` in a browser on the same Wi-Fi, or install
the preview Android APK from [PowerA Releases](https://github.com/aYmAn-Helmy/voltra-standalone/releases/tag/powera-preview-v0.3.0).
Android 8.0+ is supported. The app discovers the Hub automatically in
the **same /24 Wi-Fi segment**; type its IP on the welcome screen if needed.

The new Android app is original source in \`powera/android\`, independent of the
external Kotlin powerk app, and is built using Java 17 / Android SDK 35:

\`\`\`bash
gradle -p powera/android :app:assembleDebug
\`\`\`

This creates \`powera/android/app/build/outputs/apk/debug/app-debug.apk\`.
GitHub Actions builds a preview APK automatically. Do not distribute the older
upstream submodule as a derivative without obtaining the author's permission.

### 3. Features implemented now

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
port 8098, upstream port 8080 or device TCP port 10086 to the internet.**
The Hub also rejects public IPs, cross-subnet clients, and nonlocal HTTP Host
headers. These measures reduce exposure but are **not user authentication**.

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

\`\`\`bash
python3 -m unittest discover -s test -p 'test_powera_*.py' -v
python3 -m unittest discover -s test -p 'test_branding.py' -v
node --check powera/web/app.js
\`\`\`

See [the implementation status for every requested capability](docs/POWER_A_REQUIREMENTS.md).

## Open-source upstream references and attribution

We use the documented JSON API of
[ahmedtohamy1/powerk](https://github.com/ahmedtohamy1/powerk) and documented
Standalone API of
[af950833/mttl_w01_standalone](https://github.com/af950833/mttl_w01_standalone).
The former repository is pinned under \`upstream/powerk\` as a **Git submodule**
rather than copying its source into PowerA. The original upstream project did
not publish a clear redistribution license when checked on 2026-11-11; obtain
permission before distributing modified copies of its app. PowerA's own Hub,
web frontend and Android launcher are original, separate implementations.

The earlier upstream-name overlay remains in \`scripts/\` for reference;
**the app now built/released from \`powera/android\` is the supported PowerA app**.

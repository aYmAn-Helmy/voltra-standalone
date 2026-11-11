# PowerA

**PowerA** is the dedicated development branch for customizing an Android controller for LG U+ / Jinheung MTTL-W01 smart power strips.

## PowerA Hub — first integrated web preview

An **original, independently authored** local Hub has been added in
\`powera/hub.py\`. It uses the documented upstream powerk JSON protocol for
stock devices and the documented Standalone HTTP API for custom firmware.

**This is not yet integrated into the upstream Kotlin APK**, and it does not
implement the full feature roadmap. See
[the 63-feature requirements matrix](docs/POWER_A_REQUIREMENTS.md) for exact
scope and implementation status.

### First run

Start the **original** powerk controller separately for stock firmware strips
(if you have any). Then configure PowerA sources. A copy of the provided
config example is recommended so that you can keep credentials private.

\`\`\`bash
cp powera/config.example.json powera/config.json
# Edit powera/config.json: stock server URL(s), and optionally Standalone
# firmware IP + MAC (see the example below).
python3 -m powera.hub --config powera/config.json --db powera/data.sqlite3
# Web UI: http://127.0.0.1:8098
\`\`\`

For an additional Standalone device, add an entry to the
\`sources\` list (replace the IP and MAC with **real** values):

\`\`\`json
{"id":"standalone-office","type":"standalone","name":"مكتب","url":"http://192.168.0.55","mac":"00:11:22:33:44:55"}
\`\`\`

The MAC is pinned: an IP reassignment cannot cause commands to be sent to a
different physical strip. A mismatched or unreachable device stays offline.

### LAN access

By default the web UI binds **only to 127.0.0.1**. To open it from a phone
connected to the same trusted LAN, choose a long token and explicitly bind the
server to the LAN:

\`\`\`bash
POWERA_TOKEN='a-long-random-unique-secret-please' python3 -m powera.hub \\
  --config powera/config.json --db powera/data.sqlite3 --host 0.0.0.0 --port 8098
\`\`\`

Browse \`http://<SERVER-IP>:8098\` from the phone, go to **Settings** and
enter the same token. The token persists only in the current browser tab's
session storage. The upstream stock controller still needs its separate
\`X-Token\` if configured, added per source in \`powera/config.json\`.
Neither this preview nor the stock/Standalone device protocols provides
end-to-end encrypted transport; use a trusted local network, or a private VPN
with HTTPS termination for remote use. **Never port-forward these servers
directly onto the internet.**

### Implemented in the current Hub + web preview

- Unified stock/Standalone cards, identity validation, online/offline states.
- All four outlets and whole-strip commands, plus all-online-strips control.
- Double-tap guard for every web power button; explicit confirmation for
  all-outlet, all-strip and room operations.
- Confirmed stock commands and Standalone relay read-back; **never retry**
  an uncertain power command automatically.
- Local device/outlet display names (do not rewrite firmware names).
- Cross-strip rooms, room member assignment and room power controls.
- Current W, cumulative kWh, temperature, voltage/current if available.
- Price input in EGP/kWh and simple estimated cumulative cost.
- 30-day *sample-based* local readings storage (no fabricated backfilled data).
- Connection lost/restored inbox and read/unread state.
- Dark/light web appearance; Arabic and right-to-left layout.

### Deliberately not yet implemented

Android PowerA Hub integration, cloud accounts/SSO, household sharing,
advanced schedules, protection rules/alarms, push notifications, Siri/iOS widgets,
firmware power-on recovery settings, and production release signing. Some rely
on firmware or a dedicated iOS client. The 25-second background sample
and 15-second web refresh are polling, **not real-time event delivery**.

### Verification

\`\`\`bash
python3 -m unittest discover -s test -p 'test_powera_hub.py' -v
node --check powera/web/app.js
\`\`\`

The CI also checks the existing PowerA app-name overlay.

---

## Upstream reference

Based on the architecture and documented interfaces of [ahmedtohamy1/powerk](https://github.com/ahmedtohamy1/powerk), a Python controller + Kotlin/Jetpack Compose Android client. The upstream project is linked as a **Git submodule** in `upstream/powerk`, preserving its original source, history, authorship and update path.

This branch is separate from Voltra's `main` and `feat/central-dashboard` branches, so the two initiatives can evolve independently.

### Get the project

```bash
git clone --branch PowerA --recurse-submodules https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
# If it was cloned without submodules:
git submodule update --init --recursive
```

### Build the PowerA-branded Android application

Our overlay changes the Android launcher label **and the in-app title** (both Arabic
and English `app_name` resources) to **PowerA**. It also changes the Gradle
project name to `PowerA` and sets a separate Android application ID
`com.powera.app` so it can be installed alongside the original.

```bash
git clone --branch PowerA --recurse-submodules https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
bash scripts/build_powera.sh
```

APK output: `upstream/powerk/android/app/build/outputs/apk/debug/app-debug.apk`.
To prepare without building, run `python3 scripts/brand_powera.py`. To verify
the renamed state, run `python3 scripts/brand_powera.py --check`.

The upstream source remains an external submodule and this script modifies only
your **local working checkout**. The original Kotlin package is deliberately
unchanged; it does not affect the visible PowerA name.

**Licensing:** The upstream project did not provide a clear redistribution
license when checked. This branch does not republish the upstream source or
a rebranded APK. Obtain permission before distributing a derivative.

### Project identity

- **New project / workstream name:** PowerA
- **Development branch:** `PowerA`
- **Upstream implementation:** powerk, under `upstream/powerk`, unmodified
- **PowerA branding overlay:** display name `PowerA` and application ID `com.powera.app` (applied during local build)

### License and reuse status

**Important:** As checked on 2026-11-11, the upstream powerk repository did not publish a `LICENSE` file or GitHub-recognized license. A public repository can be inspected and linked, but this does **not automatically permit** copying, republishing, renaming and distributing its entire source or APK under another brand. We therefore intentionally keep it as an external Git submodule rather than committing a modified copy as PowerA.

Obtain an explicit license or written permission from the upstream owner before publishing a derivative application or copied source under PowerA. Development can proceed on original implementation and documented protocol integration in this branch.

## Next development targets

1. Verify the renamed PowerA APK on Android and clarify distribution permission.
2. Integrate the stock MTTL-W01 protocol using authorized interfaces, or interface with the upstream powerk JSON API.
3. Optionally add Standalone firmware HTTP/SSE support alongside the stock controller.
4. Add automated tests and a distributable APK once redistribution rights and signing are settled.

For the upstream setup, provisioning steps and API documentation, see [the original Arabic README](https://github.com/ahmedtohamy1/powerk/blob/master/README.ar.md).

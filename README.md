# Voltra Standalone

Voltra Standalone is an Arabic-first dashboard that connects **directly to LG MTTL-W01 strips running compatible [Standalone firmware](https://github.com/af950833/mttl_w01_standalone)**, and also aggregates multiple [MTTL-W01 MatterBridge](https://github.com/ttaengz/mttl-w01-matterbridge) servers.

The app automatically detects the upstream API: Standalone firmware uses each strip's port **80** (`/api/status`, `/api/device`, `/api/control`), while MatterBridge has its management dashboard on port **8086**.

## Features (extended Standalone UI)

- Add/remove source bridges through the dashboard; addresses are persisted in data/bridges.json.
- Aggregate devices from several bridges without collisions when device MAC/IDs repeat.
- Display live power (W), cumulative energy readings (Wh), temperature, firmware, and online/offline state.
- Switch each of the four outputs on/off and request device refresh.
- Delete an offline device from its **original bridge** registry with confirmation.
- Show Matter QR codes/manual pairing codes and reset commissioning with explicit warning.
- Total connected power/energy and search/filter by bridge and device status.
- Preserve previously seen devices as offline if a source bridge cannot be reached.
- Responsive dark UI inspired by the original local dashboard.
- Protect the dashboard with HTTP Basic authentication when exposed beyond localhost.

**Per-device management panels** are now available directly inside every Standalone strip card (expand **⚙️ إدارة كل إعدادات المشترك**). The panel supports names, physical button locks, timers, scheduler rules, protection thresholds, MQTT settings, Wi-Fi scanning/reconfiguration, diagnostics, and guarded FWR OTA. Automatic LAN discovery and live SSE streaming are not implemented. The original local dashboard remains available as a fallback.

## Start with Node.js 20+

Run:

    npm start

Open http://127.0.0.1:8090, click Add Source, then enter the **physical Standalone device IP**, e.g. http://192.168.0.55 (port 80), or an already running **MatterBridge server**, e.g. http://192.168.1.100:8086. Saved sources automatically upgrade to the right type on refresh.

To allow other machines to reach Voltra, set HOST=0.0.0.0 and a strong VOLTRA_PASSWORD in the shell environment. Optionally set VOLTRA_USER, PORT and CONFIG_PATH. Node does not automatically read .env.example.

If you prefer a static starting configuration, copy data/bridges.example.json to data/bridges.json and update the address. The UI can manage the file afterwards.

## Docker Compose

    cp .env.example .env
    # Edit .env and set a strong VOLTRA_PASSWORD
    docker compose up --build -d

Open http://SERVER_IP:8090. The Voltra container needs network access to each original MatterBridge HTTP server. It does **not** run the original TCP (10086) or Matter (5540) services. Standalone-firmware devices do not need these services.

## Safety

Keep the original bridges and Voltra behind a trusted firewall. Plain HTTP Basic authentication does not encrypt credentials: use HTTPS through a reverse proxy if accessed outside a trusted LAN. The app refuses an external bind without a password. Source addresses are restricted by default to private IPv4 networks, localhost, .local and .lan. Redirects are disabled, to reduce unsafe outbound requests.

Matter pairing codes and QR images are sensitive. Only authorized users should access the Voltra dashboard. The original upstream bridge HTTP API does not implement its own authentication; restrict its port 8086 at the firewall.

## API

GET /api/status, GET /api/bridges, POST /api/bridges, DELETE /api/bridges/:id, GET /api/bridges/:id/qr.svg, POST /api/bridges/:id/matter/reconnect, POST /api/bridges/:id/devices/:device/refresh, POST /api/bridges/:id/devices/:device/outlets/:index/state, DELETE /api/bridges/:id/devices/:device.

All mutation endpoints use same-origin checks; JSON POST requests use Content-Type: application/json. Ordinary source status requests have four-second timeouts. Configuration saves, scans, and firmware updates have separate bounded timeouts.

## Tests

    npm test

Includes configuration validation, persistence, aggregation and offline-cache tests. Integration with real MTTL-W01 hardware needs to be tested on the local network.

## Supported Standalone firmware (direct IP)

Confirmed source API: [af950833/mttl_w01_standalone](https://github.com/af950833/mttl_w01_standalone) 2.1.x; equivalent 2.0.x APIs may also work. The central dashboard displays device/channel names, outlet power/energy/current/temperature, device voltage/current, RSSI, firmware version, online state and button lock indication. Outlet changes are sent as firmware's 2-byte `/api/control` command with an upstream Origin header, then independently confirmed through `/api/device`. A command is never blindly retried after an ACK.

Open the **⚙️ إدارة كل إعدادات المشترك** panel inside each device card for these tabs:

- **Readings & diagnostics**: voltage/current/power, firmware and Build ID, Wi-Fi RSSI, current protection and flash-write status, memory and energy diagnostics.
- **Names and locks**: rename the strip and each outlet; control physical button lock for each channel; choose the language of the device's local UI.
- **Timers**: four independent auto-off timers (0 = disabled, 1–1440 minutes).
- **Scheduler**: eight rules including daily, weekday mask, monthly date or last day of month, enable/disable, target outlet or all and ON/OFF action, explicit timezone offset. Mutually exclusive with timers on occupied channels, as required by the firmware.
- **Protection**: configurable over-temperature (50–90°C), total current (1–16 A) and power (100–3000 W) cutoffs.
- **MQTT**: broker, port, user, topic, on/off and optional replacement password. Passwords are never returned by the upstream API.
- **Wi-Fi**: scan nearby networks and change SSID/password. Network changes can disconnect the strip or change its IP.
- **Firmware**: read OTA status, display build ID and upload a verified .fwr image with required **independently sourced SHA-256 checksum**, explicit confirmation and native Image2/XOR format checks. There are no automatic retries after a write or interrupted reboot.

All configuration writes use the original firmware's binary format version 7 and are polled for flash persistence before reporting success. The service does not re-send uncertain writes. Changes outside the central UI (for example from the device's own dashboard) can still race with central updates; avoid configuring the same strip from two interfaces simultaneously.

**IMPORTANT OTA / electrical safety:** Firmware uploads can render an appliance unusable and may require a hardware programmer for recovery. Only use a known-compatible .fwr from a trusted vendor/developer; compare the SHA-256 checksum with the official release, keep stable power, and verify a full successful reboot. For unsupported firmware variants, perform OTA through the device's own local dashboard rather than Voltra. Software protection limits are not a replacement for proper electrical protection.

The device's **Open local dashboard** link remains available as a fallback.

If a saved source still shows offline, run these commands **from the machine or container running Voltra**, substituting the physical strip IP:

    curl http://192.168.0.55/api/status
    curl http://192.168.0.55/api/device

On supported Standalone firmware the first response contains `state` and `mac`, and the second contains exactly four `channels`. MatterBridge's API instead returns a `devices` array from `http://SERVER_IP:8086/api/status`. Each device must be on a reachable network; Voltra cannot communicate with a device that is not joined to Wi-Fi.

## Extended Standalone API routes

All routes are subject to Voltra's authentication and same-origin checks:

- `GET /api/bridges/:id/devices/:device/standalone/settings` — device config, parsed schedule, hardware/firmware/diagnostics
- `POST /api/bridges/:id/devices/:device/standalone/settings` — JSON section patch (`names`, `locks`, `language`, `timers`, `schedule`, `protection`, `mqtt`)
- `POST /api/bridges/:id/devices/:device/standalone/wifi/scan` — JSON `{}`
- `POST /api/bridges/:id/devices/:device/standalone/wifi/connect` — JSON `{ "ssid": "...", "password": "...", "confirm": true }`
- `POST /api/bridges/:id/devices/:device/standalone/firmware/upload` — raw FWR, `Content-Type: application/x-mttl-fwr`, `X-Voltra-Confirm: FLASH`, `X-Voltra-FWR-SHA256` (required, 64 hex)
- `POST /api/bridges/:id/devices/:device/outlets/5/state` — **Standalone only**, atomic all-outlets ON/OFF using native channel index 4

## Local verification

Run `npm test` with Node.js 20+. Tests cover binary config encoding, scheduler round-trips, validation, FWR format, settings confirmation after lost responses, Wi-Fi scan, and authentication. Full end-to-end behavior must still be confirmed with a physical MTTL-W01 on a trusted LAN.

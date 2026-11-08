# Voltra Standalone

Voltra Standalone is an Arabic-first dashboard that brings together LG MTTL-W01 four-outlet power strips registered with one or more [MTTL-W01 MatterBridge](https://github.com/ttaengz/mttl-w01-matterbridge) servers.

The linked source project includes a local web dashboard at port 8086. Voltra connects to its supported HTTP API and keeps each original MatterBridge in control of its own devices, power outlets and Matter commissioning.

## Features in version 0.1

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

This version aggregates MatterBridge instances. It does not yet discover power strips independently, reflash them, change Wi-Fi settings, or provide firmware OTA. Those would require a separately verified device protocol/firmware implementation. The ota.icns file linked in the request is an icon asset, not a device API.

## Start with Node.js 20+

Run:

    npm start

Open http://127.0.0.1:8090, click Add Bridge, then supply the address of an **already running** upstream MatterBridge, e.g. http://192.168.1.100:8086.

To allow other machines to reach Voltra, set HOST=0.0.0.0 and a strong VOLTRA_PASSWORD in the shell environment. Optionally set VOLTRA_USER, PORT and CONFIG_PATH. Node does not automatically read .env.example.

If you prefer a static starting configuration, copy data/bridges.example.json to data/bridges.json and update the address. The UI can manage the file afterwards.

## Docker Compose

    cp .env.example .env
    # Edit .env and set a strong VOLTRA_PASSWORD
    docker compose up --build -d

Open http://SERVER_IP:8090. The Voltra container needs network access to each original MatterBridge HTTP server. It does **not** run the original TCP (10086) or Matter (5540) services; those remain on the source bridge servers.

## Safety

Keep the original bridges and Voltra behind a trusted firewall. Plain HTTP Basic authentication does not encrypt credentials: use HTTPS through a reverse proxy if accessed outside a trusted LAN. The app refuses an external bind without a password. Source addresses are restricted by default to private IPv4 networks, localhost, .local and .lan. Redirects are disabled, to reduce unsafe outbound requests.

Matter pairing codes and QR images are sensitive. Only authorized users should access the Voltra dashboard. The original upstream bridge HTTP API does not implement its own authentication; restrict its port 8086 at the firewall.

## API

GET /api/status, GET /api/bridges, POST /api/bridges, DELETE /api/bridges/:id, GET /api/bridges/:id/qr.svg, POST /api/bridges/:id/matter/reconnect, POST /api/bridges/:id/devices/:device/refresh, POST /api/bridges/:id/devices/:device/outlets/:index/state, DELETE /api/bridges/:id/devices/:device.

All mutation endpoints use same-origin checks; JSON POST requests use Content-Type: application/json. Source requests have four-second timeouts.

## Tests

    npm test

Includes configuration validation, persistence, aggregation and offline-cache tests. Integration with real MTTL-W01 hardware needs to be tested on the local network.

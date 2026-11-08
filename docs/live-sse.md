# Voltra Live SSE architecture

Voltra proxies device native `GET /api/events` and fans out the same `relay` and `device` events to authenticated browsers through `GET /api/live/events`.

The embedded MTTL-W01 Standalone firmware explicitly allows **one** upstream stream only. Opening its original dashboard can occupy that slot; Voltra will display HTTP fallback until it becomes free. Opening multiple Voltra dashboards does not create multiple connections to the physical strip.

The server verifies each strip's live MAC before attaching to its SSE stream, rejects oversized or malformed event frames, sends heartbeats, uses an idle timeout, reconnects with backoff, and closes upstream streams when nobody is subscribed. SSE never sends device credentials, Wi-Fi passwords, or MQTT passwords.

The browser uses one EventSource for its whole dashboard. Incoming events patch the displayed card and readings without removing an open settings form. A slower 30-second HTTP status refresh is retained for discovery/offline states and firmware variants that do not support SSE. SSE is real-time *relay and device events*, not direct WebSocket control. Existing validated HTTP commands remain responsible for writes and acknowledgment.

All event stream access is protected by Voltra's Basic Auth just like other API routes. The original physical appliance HTTP port must remain on a trusted LAN/VPN.

## Quick check

```
curl -N -u admin:YOUR_PASSWORD http://SERVER_IP:8090/api/live/events
```

Once a Standalone source is online, watch for `event: source`, `event: relay`, and `event: device`. If only fallback appears, check that no other client (including the original device dashboard) currently owns the firmware's single SSE slot.

## Per-device sparkline

Each Standalone card plots a lightweight in-browser wattage trend from the last 60 device SSE readings. The samples remain in browser memory only (not historical accounting data, and no writes to the strip's flash). If SSE is unavailable, the trend waits for new live readings while the regular HTTP summary remains available.

While an input inside a device settings panel has focus, background HTTP refreshes update telemetry in place instead of destroying and rebuilding the form. Unsaved configuration changes therefore remain intact.

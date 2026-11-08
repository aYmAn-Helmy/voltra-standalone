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

# PowerA Requirements — 11 Nov 2026

This is the user's feature backlog transcribed into engineering acceptance criteria.
**Status:** ✅ Hub/Web now = implemented in the original PowerA Hub/web preview,
🟡 Partial = requires more work, ⏳ Planned = not implemented,
⚠️ Depends = blocked by device firmware/platform/provider support. The
original Kotlin **powerk APK is not connected to the new Hub yet**.

## 1 — Device control (10)

| # | Requirement | Status | Details |
| --- | --- | --- | --- |
| D1 | Individual ON/OFF for all 4 outlets | ✅ Hub/Web | Stock documented JSON API and Standalone verified HTTP |
| D2 | Whole power strip ON/OFF | ✅ Hub/Web | Explicit confirmation |
| D3 | All strips ON/OFF | ✅ Hub/Web | Online strips only; partial failures reported; no rollback |
| D4 | Per-outlet ON/OFF state | ✅ Hub/Web | Unknown state never shown as OFF |
| D5 | Online/offline | ✅ Hub/Web | Connection polling; offline cache |
| D6 | Rename strip | 🟡 Partial | Local PowerA display alias only; no firmware rename |
| D7 | Rename outlet | 🟡 Partial | Local PowerA display alias only |
| D8 | Android control | 🟡 Partial | Existing upstream APK uses stock API only; Hub integration pending |
| D9 | Web dashboard | ✅ Hub/Web | Branded Arabic responsive page |
| D10 | Double-Tap Guard | ✅ Hub/Web | 3-second confirm window for web power controls |

## 2 — Timers & scheduling (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| T1 | Scheduled ON | ⏳ Planned | Persistent scheduler/command audit |
| T2 | Scheduled OFF | ⏳ Planned | Ditto |
| T3 | One-shot scheduling | ⏳ Planned | Idempotence across reboot |
| T4 | Weekly recurring scheduling | ⏳ Planned | Recurrence and missed-run rules |
| T5 | Visual Smart Timer | ⏳ Planned | Timeline editor |
| T6 | Return to original outlet state after duration | ⏳ Planned | Snapshot/restore, don't override physical changes without policy |
| T7 | Usage-based automation | ⏳ Planned | Verified fresh telemetry, hysteresis and audit |
| T8 | Time zone-aware execution | ⏳ Planned | IANA zone ID and DST policy |

Standalone firmware itself supports up to eight on-device schedules and
per-channel timers, but PowerA does not yet configure them. Stock firmware
features differ.

## 3 — Energy monitoring (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| E1 | Watt per outlet | ✅ Hub/Web | When supplied by device |
| E2 | Total strip wattage | ✅ Hub/Web | Device readings |
| E3 | kWh | ✅ Hub/Web | Cumulative counter when present |
| E4 | History | 🟡 Partial | Local polling snapshots up to 30 days; no chart/export yet |
| E5 | Outlet comparison | 🟡 Partial | Four tiles side by side, advanced comparison pending |
| E6 | kWh rate | ✅ Hub/Web | Local EGP price setting |
| E7 | Estimated cost | ✅ Hub/Web | Counter × price; not a bill; missing readings unknown |
| E8 | Voltage and current | ✅ Hub/Web | Only if supplied |

## 4 — Electrical protection (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| P1 | Overload monitoring | ⚠️ Depends | Expose hardware flags; not in Hub yet |
| P2 | Heat warning | ⏳ Planned | Needs device thresholds and alert engine |
| P3 | Cutoff on device power threshold | ⚠️ Depends | Firmware-local protection preferred over server |
| P4 | Upper/lower power rules | ⏳ Planned | Need threshold, hysteresis, stale-data guard |
| P5 | Overvoltage | ⚠️ Depends | Sensor/firmware support; never claim hub software is hardware safety |
| P6 | Undervoltage | ⚠️ Depends | Same |
| P7 | Overcurrent | ⚠️ Depends | Same |
| P8 | Protection notification | ⏳ Planned | Native firmware flags, inbox/push integration |

**Safety:** PowerA and its networking are not a safety-rated protective
relay. Use appropriate breakers/RCD and rated hardware protection.

## 5 — Rooms & family (6)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| R1 | Create rooms | ✅ Hub/Web | SQLite |
| R2 | Mix outlets from different strips in same room | ✅ Hub/Web | Cross-firmware |
| R3 | Room ON/OFF | ✅ Hub/Web | Multi-device results, explicit confirmation |
| R4 | Share a strip to another account | ⏳ Planned | Requires user auth/ACLs |
| R5 | Household permissions | ⏳ Planned | Owner/editor/viewer roles |
| R6 | Shared devices listing | ⏳ Planned | Per-account access control |

## 6 — Notifications (7)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| N1 | Device disconnected | ✅ Hub/Web | Poll-detected only |
| N2 | Device reconnected | ✅ Hub/Web | Poll-detected only |
| N3 | Electrical fault | ⏳ Planned | Verified firmware warning states |
| N4 | Automation executed | ⏳ Planned | Requires scheduler |
| N5 | Physical button change | ⏳ Planned | Need event origin; polling alone can't prove origin |
| N6 | Notification inbox | ✅ Hub/Web | Local 100 newest |
| N7 | Read/unread | ✅ Hub/Web | Local SQLite |

## 7 — Accounts & settings (11)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| A1 | Phone + password login | ⏳ Planned | Requires secure identity service |
| A2 | Google/Apple login | ⏳ Planned | OAuth/OIDC app IDs and provider setup |
| A3 | Arabic + English | 🟡 Partial | Arabic web; upstream Android has both |
| A4 | RTL | ✅ Hub/Web | Arabic RTL |
| A5 | Dark/light | ✅ Hub/Web | Local preference |
| A6 | User profile | ⏳ Planned | Database/account model |
| A7 | Logout/session management | 🟡 Partial | Hub browser-tab token only; no accounts |
| A8 | Delete account | ⏳ Planned | Requires accounts, retention and deletion policy |
| A9 | Secure session storage | 🟡 Partial | Browser session token; proper OAuth session design later |
| A10 | Provision Wi-Fi | ⚠️ Depends | Upstream stock provision and Standalone setup exist separately; not in Hub |
| A11 | iPhone home screen widget | ⚠️ Depends | Requires separate iOS app and WidgetKit |

## 8 — Power recovery (5)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| PR1 | Per-outlet restoration setting | ⚠️ Depends | Check stock/Standalone firmware persistence interfaces |
| PR2 | Always ON | ⚠️ Depends | Device firmware must reliably implement at startup |
| PR3 | Always OFF | ⚠️ Depends | Same |
| PR4 | Restore Last State | ⚠️ Depends | State persistence and failure modes |
| PR5 | Staggered startup delays | ⚠️ Depends | Hardware/firmware startup sequence preferred |

Power recovery must work even when the phone and Hub are offline. Server-side
resending after reconnection **does not fulfill this requirement**, and can
cause unexpected energizing; implement firmware-local policies only after
physical validation and explicit user consent.

## Milestones and acceptance gates

1. **P0 – Hub integration**: Stock + Standalone normalized with unit tests,
   identity verification, safe control and failure reporting. ✅ Prototype.
2. **P1 – Android & richer UI**: Independently licensed app integrated to Hub,
   rooms, verified commands, persistent favorites, energy charts, localization.
3. **P2 – Scheduler/alerts**: Durable timed jobs, IANA time zones, idempotent
   execution, energy-triggered rules and notification events.
4. **P3 – Accounts/family**: Provider-backed identities, per-device ACLs,
   invitation lifecycle, credential storage, audit and account deletion.
5. **P4 – Firmware and iOS**: Distinct verified support for recovery modes,
   firmware protection settings, native phone notifications and iOS WidgetKit.

### Engineering criteria

- Never equate a command HTTP acknowledgment with confirmed relay state.
- Never automatically repeat uncertain or failed power writes.
- Validate current MAC before Standalone writes to prevent DHCP identity drift.
- Bulk/room controls return per-target results and never assume atomicity.
- Confirm actions with power impact, especially after a blackout.
- Treat missing/stale telemetry as unknown rather than zero.
- Network exposure needs strong authentication and transport protection.
- Authorization checks must happen on the API, not only through UI buttons.
- Avoid remote firmware updates until checksum/identity/physical test gates pass.
- Physical testing on both firmware types is needed before release.

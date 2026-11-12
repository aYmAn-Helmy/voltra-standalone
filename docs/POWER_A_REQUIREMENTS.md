# PowerA Requirements — v0.4 Preview, 12 Nov 2026

This is the user's feature backlog transcribed into engineering acceptance criteria.
**Status:** ✅ Hub/Web now = implemented in the original PowerA Hub/web preview,
🟡 Partial = requires more work, ⏳ Planned = not implemented,
⚠️ Depends = blocked by device firmware/platform/provider support. An independently authored **PowerA Android APK now discovers and embeds the Hub**. The upstream Kotlin powerk app is linked but not redistributed.

## 1 — Device control (10)

| # | Requirement | Status | Details |
| --- | --- | --- | --- |
| D1 | Individual ON/OFF for all 4 outlets | ✅ Hub/Web | Native Stock TCP 10086 or legacy bridge, plus Standalone HTTP (physical verification pending) |
| D2 | Whole power strip ON/OFF | ✅ Hub/Web | Explicit confirmation |
| D3 | All strips ON/OFF | ✅ Hub/Web | Online strips only; partial failures reported; no rollback |
| D4 | Per-outlet ON/OFF state | ✅ Hub/Web | Unknown state never shown as OFF |
| D5 | Online/offline | ✅ Hub/Web | Native Stock TCP connect/disconnect; Standalone polls and offline cache |
| D6 | Rename strip | ✅ Hub/Web | Stock local alias; Standalone device flash name synced bidirectionally |
| D7 | Rename outlet | ✅ Hub/Web | Stock local alias; Standalone firmware-persistent names |
| D8 | Android control | ✅ Phase 2 Preview | Original Android shell autodiscovers and embeds the unified Hub web UI |
| D9 | Web dashboard | ✅ Hub/Web | Branded Arabic responsive page |
| D10 | Double-Tap Guard | ✅ Superseded | User requested one-tap entire outlet card; whole-strip/room/bulk actions ask confirmation |

## 2 — Timers & scheduling (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| T1 | Scheduled ON | ✅ Hub/Web | Durable SQLite schedule with verified relay command |
| T2 | Scheduled OFF | ✅ Hub/Web | Same verified control pathway |
| T3 | One-shot scheduling | ✅ Hub/Web | Claim before send, never replay after crash |
| T4 | Weekly recurring scheduling | ✅ Hub/Web | Per-weekday recurrence, late events skipped |
| T5 | Visual Smart Timer | 🟡 Partial | Selectable two-hour timeline plus exact time/day editor |
| T6 | Return to original outlet state after duration | ✅ Hub/Web | Guarded restore; missed timer or changed state requires manual review |
| T7 | Usage-based automation | ⏳ Planned | Verified fresh telemetry, hysteresis and audit |
| T8 | Time zone-aware execution | ✅ Hub/Web | IANA timezone, DST gap skipped and fold=0 |

**Two distinct scheduling engines:** Standalone firmware schedules (8 slots, direct bidirectional sync, fixed UTC-offset device clock, stay active without the Hub) and Hub-owned jobs (SQLite, IANA timezone, Hub must remain online). Active overlap is rejected before scheduling and at execution; missed deadlines are not replayed. Device firmware schedules only supported when firmware exposes v7 config.

## Bidirectional Standalone settings (v0.4)

- ✅ Read existing device name, four outlet names, eight firmware schedule rules, per-outlet firmware timers, protection thresholds, physical button lock and nonsecret MQTT settings.
- ✅ Explicit writes check a revision of the fresh device config, write the firmware v7 binary format with Wi-Fi/MQTT secrets preserved, and verify persistent readback after one POST. External changes are never overwritten automatically.
- ✅ Live device changes become visible in PowerA after polling/reopening, with an inbox entry.
- ⚠️ Firmware versions without the documented v7 config are not assumed compatible. Real hardware test pending.
- ⚠️ Power recovery mode selection and staggered start have no verified firmware API and are unavailable.

## 3 — Energy monitoring (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| E1 | Watt per outlet | ✅ Hub/Web | When supplied by device |
| E2 | Total strip wattage | ✅ Hub/Web | Device readings |
| E3 | kWh | ✅ Hub/Web | Cumulative counter when present |
| E4 | History | ✅ Hub/Web | Per-outlet 92-day local ledger and 7/30/90-day measured kWh graphs; no backfill |
| E5 | Outlet comparison | ✅ Hub/Web | Visual wattage bars per outlet |
| E6 | kWh rate | ✅ Hub/Web | Local EGP price setting |
| E7 | Estimated cost | ✅ Hub/Web | Sum of verified meter-delta and labelled watt-integral estimate × configured EGP rate; not a bill |
| E8 | Voltage and current | ✅ Hub/Web | Only if supplied |

## 4 — Electrical protection (8)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| P1 | Overload monitoring | 🟡 Partial | Read firmware protection settings; actual firmware trips not yet alert-integrated |
| P2 | Heat warning | 🟡 Partial | Standalone firmware temperature cutoff threshold editable; proactive app alert pending |
| P3 | Cutoff on device power threshold | 🟡 Partial | Firmware's total-power safety threshold editable; not arbitrary per-outlet protection |
| P4 | Upper/lower power rules | ⏳ Planned | Need threshold, hysteresis, stale-data guard |
| P5 | Overvoltage | ⚠️ Depends | Sensor/firmware support; never claim hub software is hardware safety |
| P6 | Undervoltage | ⚠️ Depends | Same |
| P7 | Overcurrent | 🟡 Partial | Firmware total-current limit editable, actual physical overcurrent validation pending |
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
| N1 | Device disconnected | ✅ Hub/Web | Hub polls Standalone and detects native Stock TCP disconnects |
| N2 | Device reconnected | ✅ Hub/Web | Poll-detected only |
| N3 | Electrical fault | ⏳ Planned | Verified firmware warning states |
| N4 | Automation executed | ✅ Hub/Web | Scheduled/return-timer results; device settings change notifications |
| N5 | Physical button change | ⏳ Planned | Need event origin; polling alone can't prove origin |
| N6 | Notification inbox | ✅ Hub/Web | Local 100 newest |
| N7 | Read/unread | ✅ Hub/Web | Local SQLite |

## 7 — Accounts & settings (11)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| A1 | Phone + password login | ⏳ Planned | Requires secure identity service |
| A2 | Google/Apple login | ⏳ Planned | OAuth/OIDC app IDs and provider setup |
| A3 | Arabic + English | 🟡 Partial | Arabic PowerA RTL web/Android shell; complete English translation still missing |
| A4 | RTL | ✅ Hub/Web | Arabic RTL |
| A5 | Dark/light | ✅ Hub/Web | Local preference |
| A6 | User profile | ⏳ Planned | Database/account model |
| A7 | Logout/session management | ⏳ Deferred | Accounts intentionally postponed; no token or login |
| A8 | Delete account | ⏳ Planned | Requires accounts, retention and deletion policy |
| A9 | Secure session storage | ⏳ Deferred | No login, credentials or sessions in LAN-only preview |
| A10 | Provision Wi-Fi | 🟡 Partial | Native stock SoftAP CLI pairing; Standalone Wi-Fi setup still through device web UI |
| A11 | iPhone home screen widget | ⚠️ Depends | Requires separate iOS app and WidgetKit |

## 8 — Power recovery (5)

| # | Requirement | Status | Notes |
| --- | --- | --- | --- |
| PR1 | Per-outlet restoration setting | ⚠️ Firmware | Not exposed by reviewed Standalone v2.1.1 editable HTTP API; read-only status only |
| PR2 | Always ON | ⚠️ Firmware | No verified firmware-local editable option in current API |
| PR3 | Always OFF | ⚠️ Firmware | No verified firmware-local editable option in current API |
| PR4 | Restore Last State | ⚠️ Firmware | Firmware persists relay logic state but no selectable mode verified |
| PR5 | Staggered startup delays | ⚠️ Firmware | No native API; not simulated by server after reconnect |

Power recovery must work even when the phone and Hub are offline. Server-side
resending after reconnection **does not fulfill this requirement**, and can
cause unexpected energizing; implement firmware-local policies only after
physical validation and explicit user consent.

## Milestones and acceptance gates

1. **P0 – Hub integration**: Stock + Standalone normalized with unit tests,
   identity verification, safe control and failure reporting. ✅ Prototype.
2. **P1 – Android & simpler UI**: Single-tap full outlet cards, subtle pending state, expandable details, mobile bottom bar, saved favorites and 90-day energy charts. ✅ Automated UI preview; physical mobile usability validation pending.
3. **P2 – Scheduler/alerts**: Durable once/weekly jobs, IANA zones, reversible timers and execution inbox implemented in local Hub. Energy-based rules and push notifications pending.
4. **P3 – Accounts/family**: Deferred by project request. No sign-in/token/sharing in this preview.
5. **P4 – Firmware and iOS**: Standalone config read/edit/verify added in v0.4 (source-based simulation only). Native recovery modes, push, iOS WidgetKit depend on separate hardware/platform support and are outside this release.

### Engineering criteria

- Never equate a command HTTP acknowledgment with confirmed relay state.
- Never automatically repeat uncertain or failed power writes.
- Validate current MAC before Standalone writes to prevent DHCP identity drift.
- Bulk/room controls return per-target results and never assume atomicity.
- Confirm actions with power impact, especially after a blackout.
- Treat missing/stale telemetry as unknown rather than zero.
- **Temporary unauthenticated LAN mode**: same private IPv4 /24 only, numeric Host checks and same-origin write guard. Anyone on that subnet can control the strips; never use public/guest Wi-Fi or expose through port forwarding. Future production build requires authentication and transport protection.
- Authorization checks must happen on the API, not only through UI buttons.
- Avoid remote firmware updates until checksum/identity/physical test gates pass.
- Physical testing on both firmware types is needed before release.

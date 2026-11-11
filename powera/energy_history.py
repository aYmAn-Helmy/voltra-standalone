"""90-day power/energy history with conservative meter-delta accounting.

Records outlet watts and cumulative kWh; derives only observed interval
energy (no fabricated consumption across missing data or meter resets).
Falls back to estimated trapezoidal watt integration when meter is unavailable.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import math
import sqlite3
import threading
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class EnergyError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status=status


def measure(x):
    return type(x) in (int,float) and math.isfinite(x) and x >= 0


class EnergyLedger:
    RETENTION_DAYS = 92
    MAX_INTERVAL_SECONDS = 300       # no guess across an outage
    MAX_OUTLET_WATTS = 4500          # reject impossible meter deltas

    def __init__(self, hub):
        self.hub = hub
        self.lock = threading.RLock()
        self.last_insert = 0.0
        with hub.db_lock:
            hub.db.executescript("""
              CREATE TABLE IF NOT EXISTS energy_samples (
                at INTEGER NOT NULL, device_id TEXT NOT NULL,
                outlet INTEGER NOT NULL CHECK(outlet BETWEEN 1 AND 4),
                watts REAL, counter_kwh REAL, delta_kwh REAL, estimated_kwh REAL,
                gap TEXT NOT NULL DEFAULT '', PRIMARY KEY(at,device_id,outlet)
              );
              CREATE INDEX IF NOT EXISTS idx_energy_device_at
                ON energy_samples(device_id,at);
              CREATE TABLE IF NOT EXISTS energy_baselines (
                device_id TEXT NOT NULL, outlet INTEGER NOT NULL,
                at INTEGER NOT NULL, watts REAL, counter_kwh REAL,
                PRIMARY KEY(device_id,outlet)
              );
            """)
            hub.db.commit()

    def ingest(self, devices, now=None):
        now = int((now or datetime.now(timezone.utc)).timestamp())
        with self.lock, self.hub.db_lock:
            if now - self.last_insert < 60:
                return 0
            accepted=0
            for device in devices:
                if not device.get("online"):
                    continue
                for outlet in device.get("outlets", []):
                    index = outlet.get("index")
                    if type(index) is not int or not 1 <= index <= 4:
                        continue
                    watts = outlet.get("powerW")
                    counter = outlet.get("energyKwh")
                    watts = float(watts) if measure(watts) else None
                    counter = float(counter) if measure(counter) else None
                    if watts is None and counter is None:
                        continue
                    previous = self.hub.db.execute(
                        "SELECT at,watts,counter_kwh FROM energy_baselines WHERE device_id=? AND outlet=?",
                        (device["id"], index)).fetchone()
                    delta = estimate = None
                    gap = "first"
                    if previous:
                        elapsed = now - previous["at"]
                        if elapsed <= 0:
                            continue
                        if elapsed > self.MAX_INTERVAL_SECONDS:
                            gap = "offline_or_missing"
                        elif counter is not None and previous["counter_kwh"] is not None:
                            diff = counter - previous["counter_kwh"]
                            if diff < -0.0000001:
                                gap = "counter_reset"
                            elif diff > (elapsed/3600)*self.MAX_OUTLET_WATTS/1000 + 0.02:
                                gap = "meter_jump"
                            else:
                                delta = max(0.0, diff)
                                gap = ""
                        elif watts is not None and previous["watts"] is not None:
                            # Only use watt integration if no compatible pair of
                            # cumulative meter values is available.
                            if watts > self.MAX_OUTLET_WATTS or previous["watts"] > self.MAX_OUTLET_WATTS:
                                gap = "power_outlier"
                            else:
                                estimate = (watts + previous["watts"])/2 * elapsed/3_600_000
                                gap = "estimated"
                        else:
                            gap = "missing_meter"
                    self.hub.db.execute(
                        "INSERT OR IGNORE INTO energy_samples(at,device_id,outlet,watts,counter_kwh,delta_kwh,estimated_kwh,gap) VALUES(?,?,?,?,?,?,?,?)",
                        (now,device["id"],index,watts,counter,delta,estimate,gap))
                    self.hub.db.execute("""
                        INSERT INTO energy_baselines(device_id,outlet,at,watts,counter_kwh)
                        VALUES(?,?,?,?,?)
                        ON CONFLICT(device_id,outlet)
                        DO UPDATE SET at=excluded.at, watts=excluded.watts,
                                      counter_kwh=excluded.counter_kwh
                        """, (device["id"],index,now,watts,counter))
                    accepted += 1
            self.hub.db.execute("DELETE FROM energy_samples WHERE at<?",
                                (now-self.RETENTION_DAYS*86400,))
            self.hub.db.commit()
            self.last_insert = now
            return accepted

    def report(self, days=30, device_id=None, zone="Africa/Cairo", now=None):
        if type(days) is not int or days not in (7,30,90):
            raise EnergyError("Select 7, 30 or 90 days")
        if device_id is not None and (
                not isinstance(device_id,str) or not (
                  device_id.startswith("stock:") or device_id.startswith("standalone:"))):
            raise EnergyError("Invalid device ID")
        try:
            tz = ZoneInfo(zone)
        except (TypeError,ValueError,ZoneInfoNotFoundError):
            raise EnergyError("Invalid IANA timezone")
        now = now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            raise EnergyError("now must include timezone")
        local_today = now.astimezone(tz).date()
        first_day = local_today-timedelta(days=days-1)
        start = int(datetime.combine(first_day,datetime.min.time(),tzinfo=tz).timestamp())
        end = int(now.timestamp())
        sql="SELECT at,device_id,outlet,watts,delta_kwh,estimated_kwh,gap FROM energy_samples WHERE at>=? AND at<=?"
        args=[start,end]
        if device_id:
            sql+=" AND device_id=?"
            args.append(device_id)
        sql+=" ORDER BY at"
        with self.hub.db_lock:
            rows=self.hub.db.execute(sql,args).fetchall()
        chart={}
        outlets={}
        summary={"meteredKwh":0.0,"estimatedKwh":0.0,"peakW":None,
                 "samples":0,"gaps":0}
        for day in range(days):
            d=(first_day+timedelta(days=day)).isoformat()
            chart[d]={"date":d,"meteredKwh":0.0,"estimatedKwh":0.0,
                      "samples":0,"gaps":0}
        for row in rows:
            day=datetime.fromtimestamp(row["at"],timezone.utc).astimezone(tz).date().isoformat()
            if day not in chart:
                continue
            datum=chart[day]
            key=(row["device_id"],row["outlet"])
            if key not in outlets:
                outlets[key]={"deviceId":key[0],"outlet":key[1],"meteredKwh":0.,
                              "estimatedKwh":0.,"peakW":None,"samples":0,"gaps":0}
            entry=outlets[key]
            for part in (datum,entry,summary):
                part["samples"]+=1
                if row["gap"] and row["gap"] not in ("estimated",):
                    part["gaps"]+=1
                if row["delta_kwh"] is not None:
                    part["meteredKwh"]+=row["delta_kwh"]
                if row["estimated_kwh"] is not None:
                    part["estimatedKwh"]+=row["estimated_kwh"]
                if "peakW" in part and row["watts"] is not None:
                    part["peakW"]=max(part["peakW"] or 0,row["watts"])
        for item in [summary,*outlets.values(),*chart.values()]:
            for prop in ("meteredKwh","estimatedKwh"):
                item[prop]=round(item[prop],5)
            item["observedKwh"]=round(item["meteredKwh"]+item["estimatedKwh"],5)
        price=self.hub.get_price()
        summary["estimatedCostEgp"]=round(summary["observedKwh"]*price,2)
        summary["complete"]=summary["gaps"]==0 and summary["samples"]>0
        return {
            "days":days, "timezone":zone, "unit":"kWh",
            "energySource":"meter delta preferred; watts integral estimated fallback",
            "coverage":"only intervals <=5min with consecutive observations; missing periods excluded",
            "summary":summary, "daily":list(chart.values()),
            "outlets":sorted(outlets.values(),key=lambda x:(x["deviceId"],x["outlet"])),
            "pricePerKwh":price
        }

"""PowerA 0.4: firmware configuration sync and 90-day energy regression tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from powera.hub import Hub
from powera.standalone_sync import (StandaloneSync, SyncError, schedule_pack,
                                    schedule_unpack, public_config, packed_config,
                                    revision)
from powera.energy_history import EnergyLedger

MAC="001122334455"
DID="standalone:"+MAC
UTC=timezone.utc
EMPTY={"minute":0,"mode":0,"day":0,"channel":0,"on":0}


def configuration():
    return {
        "persistent":True, "device":"المكتب", "channels":["كمبيوتر","شاحن","لمبة","مروحة"],
        "language":1, "enabled":False, "broker":"", "port":1883,
        "user":"", "topic":"mttl",
        "protection":{"enabled":7,"temperature":90,"current":16000,"power":3000},
        "schedule_hex":schedule_pack({"timezone":120,"rules":[dict(EMPTY) for _ in range(8)]}),
        "button_lock":0, "timer_minutes":[0,0,0,0],
    }


class MockFirmware:
    def __init__(self):
        self.current=configuration()
        self.posts=[]
        self.fail_after_post=False
        self.status_mac="00:11:22:33:44:55"

    def __call__(self, origin, path, *, body=None, method="GET",
                 extra_headers=None, content_type="application/json", **kwargs):
        assert origin=="http://192.168.1.55",origin
        if path=="/api/status":
            return {"mac":self.status_mac,"state":5,"hardware_ready":True}
        if path=="/api/config":
            if method=="GET":
                return json.loads(json.dumps(self.current))
            self.posts.append((body,extra_headers,content_type))
            if not self.fail_after_post:
                # This fake checks the advertised v7 encoded sections without
                # decoding secrets which firmware preserves.
                assert body[0]==7 and body[-9] in range(16)
                self.current=self._after
            return {"accepted":True,"pending":True}
        if path=="/api/device":
            return {"name":self.current["device"],"hardware_ready":True,
                    "channels":[{"name":n,"on":False,"power_mw":0,
                                 "meter_wh":250} for n in self.current["channels"]]}
        raise AssertionError(path)


class FirmwareSyncTests(unittest.TestCase):
    def setUp(self):
        self.fake=MockFirmware()
        self.tmp=tempfile.TemporaryDirectory()
        self.hub=Hub({"sources":[{"id":"stand","type":"standalone",
                                  "url":"http://192.168.1.55","mac":MAC}]},
                     db_path=str(Path(self.tmp.name)/"powera.db"),requester=self.fake)
        self.sync=self.hub.sync

    def tearDown(self):
        self.hub.db.close()
        self.tmp.cleanup()

    def test_existing_device_schedules_are_read_not_overwritten(self):
        self.fake.current["schedule_hex"]=schedule_pack({
            "timezone":120,"rules":[
                {"minute":480,"mode":130,"day":0b00011111,"channel":0,"on":1},
                *[dict(EMPTY) for _ in range(7)]
            ]})
        result=self.sync.read(DID)
        self.assertEqual(result["source"],"device")
        self.assertEqual(result["schedule"]["rules"][0]["minute"],480)
        self.assertEqual(result["schedule"]["rules"][0]["mode"],130)
        self.assertFalse(result["capabilities"]["powerRecovery"])
        self.assertEqual(self.fake.posts,[], "reading must never write to device")

    def test_wire_codec_v7_and_no_secret_password_rewrite(self):
        original=public_config(self.fake.current)
        binary=packed_config(original)
        self.assertEqual(binary[0],7)
        self.assertEqual(binary[-8:],bytes(8))
        self.assertEqual(binary[-9],0)
        self.assertEqual(binary[-59:-9],bytes.fromhex(original["schedule_hex"]))
        self.assertNotIn(b"SECRET_WIFI_PASSWORD",binary)
        self.assertEqual(schedule_unpack(original["schedule_hex"])["timezone"],120)

    @patch("powera.standalone_sync.time.sleep")
    def test_device_changes_written_and_read_back_once(self,_sleep):
        old=self.sync.read(DID)
        self.fake._after={**self.fake.current, "channels":["جهاز جديد",*self.fake.current["channels"][1:]]}
        result=self.sync.write(DID,"outlet-name",{"index":1,"name":"جهاز جديد"},
                               old["revision"])
        self.assertTrue(result["confirmed"])
        self.assertEqual(result["configuration"]["channels"][0],"جهاز جديد")
        self.assertEqual(len(self.fake.posts),1)
        self.assertEqual(self.fake.posts[0][1],{"X-MTTL-Keep-Password":"1"})
        self.assertEqual(self.fake.posts[0][2],"application/octet-stream")

    def test_stale_revision_refused_and_source_of_truth_remains_device(self):
        before=self.sync.read(DID)
        self.fake.current["device"]="تغيير من الويب"
        with self.assertRaisesRegex(SyncError,"changed"):
            self.sync.write(DID,"device-name",{"name":"تغيير من التطبيق"},
                            before["revision"])
        self.assertEqual(self.fake.posts,[])
        self.assertEqual(self.sync.read(DID)["configuration"]["device"],"تغيير من الويب")

    @patch("powera.standalone_sync.time.sleep")
    def test_missing_device_confirmation_never_replays_flash_write(self,_sleep):
        rev=self.sync.read(DID)["revision"]
        self.fake.fail_after_post=True
        with self.assertRaisesRegex(SyncError,"do not retry"):
            self.sync.write(DID,"device-name",{"name":"غير مؤكد"},rev)
        self.assertEqual(len(self.fake.posts),1)
        self.assertEqual(self.fake.current["device"],"المكتب")

    def test_reject_timer_overlap_with_existing_device_schedule(self):
        existing=self.sync.read(DID)
        used={"timezone":120,"rules":[
            {"minute":600,"mode":129,"day":0,"channel":0,"on":1},
            *[dict(EMPTY) for _ in range(7)]
        ]}
        self.fake.current["schedule_hex"]=schedule_pack(used)
        fresh=self.sync.read(DID)
        with self.assertRaisesRegex(SyncError,"overlaps"):
            self.sync.write(DID,"timers",{"minutes":[15,0,0,0]},fresh["revision"])
        self.assertEqual(self.fake.posts,[])

    def test_firmware_protection_settings_constraints(self):
        x=self.sync.read(DID)
        with self.assertRaises(SyncError):
            self.sync.write(DID,"protection",{"settings":{
                "enabled":7,"temperature":120,"current":16000,"power":3000}},
                x["revision"])
        self.assertEqual(self.fake.posts,[])

    def test_identity_mismatch_blocks_config(self):
        self.fake.status_mac="AA:BB:CC:DD:EE:FF"
        with self.assertRaisesRegex(SyncError,"MAC mismatch"):
            self.sync.read(DID)

    def test_external_change_creates_notification_without_writing(self):
        self.hub.sync_settings_poll()
        self.assertEqual(self.fake.posts,[])
        self.fake.current["button_lock"]=1
        self.hub.sync_settings_poll()
        inbox=self.hub.notifications()
        self.assertEqual(inbox[0]["kind"],"settings")
        self.assertEqual(self.fake.posts,[])


class EnergyHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.hub=Hub({"sources":[]},
                     db_path=str(Path(self.tmp.name)/"energy.db"))
        self.ledger=self.hub.energy
        self.now=datetime(2026,11,12,12,0,tzinfo=UTC)

    def tearDown(self):
        self.hub.db.close()
        self.tmp.cleanup()

    def tick(self,minute, watts=120, counter=5, device="stock:AABBCCDDEEFF",index=1):
        t=self.now+timedelta(minutes=minute)
        self.ledger.ingest([{"id":device,"online":True,"outlets":[
            {"index":index,"powerW":watts,"energyKwh":counter}]}],now=t)
        return t

    def test_meter_difference_energy_not_sum_of_cumulative_counter(self):
        self.tick(0,counter=12)
        self.tick(1,counter=12.002)
        self.tick(2,counter=12.005)
        report=self.ledger.report(30,now=self.now+timedelta(minutes=3))
        self.assertAlmostEqual(report["summary"]["meteredKwh"],.005,5)
        self.assertEqual(report["summary"]["estimatedKwh"],0)
        self.assertEqual(report["summary"]["samples"],3)
        self.assertEqual(report["outlets"][0]["outlet"],1)

    def test_reset_does_not_create_negative_energy(self):
        self.tick(0,counter=9)
        self.tick(1,counter=0)
        self.tick(2,counter=.003)
        report=self.ledger.report(7,now=self.now+timedelta(minutes=3))
        self.assertAlmostEqual(report["summary"]["meteredKwh"],.003,5)
        self.assertGreaterEqual(report["summary"]["gaps"],2)

    def test_missed_period_excluded_not_called_zero(self):
        self.tick(0,counter=1)
        self.tick(90,counter=3)
        self.tick(91,counter=3.01)
        report=self.ledger.report(90,now=self.now+timedelta(hours=2))
        self.assertAlmostEqual(report["summary"]["meteredKwh"],.01,5)
        self.assertFalse(report["summary"]["complete"])
        self.assertGreaterEqual(report["summary"]["gaps"],2)

    def test_watts_integrated_as_approximation_only_without_meter(self):
        self.tick(0,watts=100,counter=None)
        self.tick(1,watts=200,counter=None)
        report=self.ledger.report(7,now=self.now+timedelta(minutes=2))
        self.assertEqual(report["summary"]["meteredKwh"],0)
        self.assertAlmostEqual(report["summary"]["estimatedKwh"],.0025,5)

    def test_last_90_days_selected_with_timezones(self):
        self.tick(0,counter=1)
        self.tick(1,counter=1.003)
        cairo=self.ledger.report(90,zone="Africa/Cairo",now=self.now+timedelta(minutes=2))
        self.assertEqual(len(cairo["daily"]),90)
        self.assertEqual(cairo["daily"][-1]["date"],"2026-11-12")
        self.assertAlmostEqual(cairo["summary"]["observedKwh"],.003,5)

    def test_offline_readings_are_not_zeroed_or_counted(self):
        self.ledger.ingest([{"id":"stock:AABBCCDDEEFF","online":False,
                             "outlets":[{"index":1,"powerW":0,"energyKwh":0}]}],
                           now=self.now)
        report=self.ledger.report(30,now=self.now+timedelta(minutes=2))
        self.assertEqual(report["summary"]["samples"],0)
        self.assertFalse(report["summary"]["complete"])


class PowerAHttpV04Tests(unittest.TestCase):
    """Real local HTTP boundary over the same Hub used by Android WebView."""
    def setUp(self):
        from http.server import ThreadingHTTPServer
        import threading
        self.tmp=tempfile.TemporaryDirectory()
        self.fake=MockFirmware()
        self.hub=Hub({"sources":[{"id":"stand","type":"standalone",
                                  "url":"http://192.168.1.55","mac":MAC}]},
                    db_path=str(Path(self.tmp.name)/"powera.db"),requester=self.fake)
        from powera.hub import ApiHandler
        class Handler(ApiHandler):
            pass
        Handler.hub=self.hub
        Handler.frontend=Path(__file__).resolve().parents[1]/"powera"/"web"
        Handler.log_message=lambda *args:None
        self.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        self.origin="http://127.0.0.1:"+str(self.server.server_port)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.hub.db.close()
        self.tmp.cleanup()

    def test_http_get_and_post_device_settings_and_energy(self):
        from urllib.request import Request,urlopen
        from urllib.parse import urlencode
        fresh=json.load(urlopen(self.origin+"/api/device-settings?"+
                           urlencode({"deviceId":DID}),timeout=4))
        self.assertEqual(fresh["configuration"]["device"],"المكتب")
        self.assertEqual(fresh["source"],"device")
        self.assertFalse(fresh["capabilities"]["powerRecovery"])
        self.assertNotIn("wifi_password",fresh["configuration"])
        self.fake._after={**self.fake.current,"device":"PowerA"}
        payload={"deviceId":DID,"section":"device-name",
                 "changes":{"name":"PowerA"},"revision":fresh["revision"]}
        with patch("powera.standalone_sync.time.sleep"):
            req=Request(self.origin+"/api/device-settings",method="POST",
                data=json.dumps(payload).encode(),headers={
                  "Content-Type":"application/json","X-PowerA-Client":"PowerA",
                  "Origin":self.origin})
            answer=json.load(urlopen(req,timeout=4))
        self.assertTrue(answer["confirmed"])
        self.assertEqual(answer["configuration"]["device"],"PowerA")
        self.hub.energy.ingest([{"id":DID,"online":True,
             "outlets":[{"index":1,"powerW":90,"energyKwh":1}]}])
        report=json.load(urlopen(self.origin+"/api/energy/report?days=90",
                                timeout=4))
        self.assertEqual(report["days"],90)
        self.assertEqual(len(report["daily"]),90)

    def test_http_rejects_cross_origin_powera_writes(self):
        from urllib.request import Request,urlopen
        from urllib.error import HTTPError
        req=Request(self.origin+"/api/device-settings",method="POST",
            data=b'{"section":"names"}',headers={
              "Content-Type":"application/json","X-PowerA-Client":"PowerA",
              "Origin":"http://evil.example"})
        with self.assertRaises(HTTPError) as denied:
            urlopen(req,timeout=4)
        self.assertEqual(denied.exception.code,403)


if __name__=="__main__":
    unittest.main()

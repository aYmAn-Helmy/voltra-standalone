import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function makeMobile() {
  const source = await readFile(new URL('../public/mobile.js', import.meta.url), 'utf8');
  const mac = 'AA:BB:CC:DD:EE:FF';
  const devices = [{ id: 'auto_AABBCCDDEEFF', name: 'Office Strip',
    url: 'http://192.168.0.55', mac }];
  let on = false;
  let writes = 0;
  let config = {
    persistent: true, device: 'Office Strip',
    channels: ['1', '2', '3', '4'], language: 1, enabled: false,
    port: 1883, broker: '192.168.0.8', user: 'admin', topic: 'test',
    mqtt_password_set: false, button_lock: 0, timer_minutes: [0, 0, 0, 0],
    protection: { enabled: 7, temperature: 90, current: 16000, power: 3000 },
    schedule_hex: '7800' + '00'.repeat(48)
  };
  const events = [];
  const status = () => ({ state: 5, mac: mac.toLowerCase(), hardware_ready: true,
    uptime_ms: 240000, rssi: -53 });
  const detail = () => ({
    name: config.device, hardware_ready: true, voltage_dv: 2260,
    current_ma: 450, channels: [0,1,2,3].map(i => ({
      name: config.channels[i], on: i === 0 ? on : false, power_mw: 2500,
      meter_wh: 100, temp_dc: 265, current_ma: 125, locked: false
    }))
  });
  let context;
  const browser = {
    VoltraAndroid: {
      run(id, op, raw) {
        setImmediate(() => {
          let reply;
          try {
            const x = JSON.parse(raw);
            if (op === 'sources') reply = { sources: devices };
            else if (op === 'discover') reply = { sources: devices, discovered: 1, subnet: '192.168.0.0/24' };
            else if (op === 'startStreams' || op === 'stopStreams') reply = { ok: true };
            else if (op === 'http') {
              const path = new URL(x.url).pathname;
              let data;
              if (path === '/api/status') data = status();
              else if (path === '/api/device') data = detail();
              else if (path === '/api/version') data = { version: '2.1.1' };
              else if (path === '/api/config' && x.method === 'POST') {
                writes++;
                assert.equal(x.headers.Origin, 'http://192.168.0.55');
                assert.equal(x.headers['X-MTTL-Keep-Password'], '1');
                const bytes = Buffer.from(x.bodyBase64, 'base64');
                assert.equal(bytes[0], 7);
                config = { ...config, button_lock: bytes.at(-9) };
                data = { accepted: true };
              } else if (path === '/api/config') data = config;
              else if (path === '/api/control') {
                assert.equal(x.headers.Origin, 'http://192.168.0.55');
                const body = Buffer.from(x.bodyBase64, 'base64');
                assert.deepEqual([...body], [0, 1]);
                on = true; data = { accepted: true };
              } else if (path === '/api/firmware/status') data = { ota_ready: false };
              else if (path === '/api/memory') data = { heap_free_bytes: 1024 };
              else if (path === '/api/energy') data = { save_failures: 0 };
              else data = {};
              reply = { status: 200, body: JSON.stringify(data) };
            } else throw Error('Unexpected native operation ' + op);
            context.window.__voltraNativeDone(id, JSON.stringify(reply));
          } catch (error) {
            context.window.__voltraNativeDone(id, JSON.stringify({ error: error.message }));
          }
        });
      }
    },
    fetch: globalThis.fetch,
    addEventListener: (type, fn) => events.push({ type, fn }),
    refresh: () => Promise.resolve()
  };
  context = {
    window: browser, document: { getElementById: () => null },
    TextEncoder, TextDecoder, Uint8Array, TextDecoderStream, URL, URLSearchParams,
    Response, Promise, setTimeout, clearTimeout, btoa, atob, crypto: globalThis.crypto
  };
  runInNewContext(source, context);
  return { browser, devices, events, state: () => ({ on, writes, config }) };
}

test('Android transport reads real Standalone API shape and builds complete device cards', async () => {
  const h = await makeMobile();
  const response = await h.browser.fetch('/api/status');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.devices.length, 1);
  assert.equal(value.devices[0].id, 'AABBCCDDEEFF');
  assert.equal(value.devices[0].sourceType, 'standalone');
  assert.equal(value.devices[0].outlets.length, 4);
  assert.equal(value.devices[0].outlets[0].powerW, 2.5);
  assert.equal(value.devices[0].outlets[0].temperatureC, 26.5);
  assert.equal(value.devices[0].rssi, -53);
  assert.equal(value.summary.devicesOnline, 1);
  assert.equal(value.summary.powerW, 10);
});

test('Android transport checks MAC and confirms real relay change', async () => {
  const h = await makeMobile();
  const url = '/api/bridges/auto_AABBCCDDEEFF/devices/AABBCCDDEEFF/outlets/1/state';
  const response = await h.browser.fetch(url, {
    method: 'POST', body: JSON.stringify({ on: true })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).confirmed, true);
  assert.equal(h.state().on, true);
  const result = await h.browser.fetch('/api/status');
  assert.equal((await result.json()).devices[0].outlets[0].on, true);
});

test('advanced card settings load and binary lock write is confirmed without replay', async () => {
  const h = await makeMobile();
  const url = '/api/bridges/auto_AABBCCDDEEFF/devices/AABBCCDDEEFF/standalone/settings';
  const initial = await h.browser.fetch(url);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).schedule.rules.length, 8);
  const response = await h.browser.fetch(url, {
    method: 'POST', body: JSON.stringify({ section: 'locks', button_lock: 5 })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).confirmed, true);
  assert.equal(h.state().config.button_lock, 5);
  assert.equal(h.state().writes, 1);
});

test('Android automatic discovery works without a Node bridge', async () => {
  const h = await makeMobile();
  await h.browser.VoltraMobile.scanNow(true);
  assert.equal(h.events.some(x => x.type === 'load'), true);
  const sources = await h.browser.fetch('/api/bridges');
  assert.equal((await sources.json()).length, 1);
});

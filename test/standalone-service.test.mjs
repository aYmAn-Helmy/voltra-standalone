import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeManager } from '../src/manager.mjs';
import { StandaloneService } from '../src/standalone-service.mjs';
import { encodeSchedule, defaultSchedule } from '../src/standalone-config.mjs';

const baseConfig = () => ({
  persistent: true, device: 'Strip', channels: ['1', '2', '3', '4'],
  language: 1, enabled: false, port: 1883, broker: '192.168.0.20',
  user: '', topic: 'mttl', mqtt_password_set: false, button_lock: 0,
  timer_minutes: [0, 0, 0, 0],
  protection: { enabled: 7, temperature: 90, current: 16000, power: 3000 },
  schedule_hex: encodeSchedule(defaultSchedule())
});

test('read config + update lock, ensure Binary version 7, exact Origin and no duplicate POST', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voltra-service-'));
  let config = baseConfig();
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...opts });
    if (path === '/api/status') return Response.json({
      state: 5, mac: 'aa:bb:cc:dd:ee:ff', hardware_ready: true, rssi: -42
    });
    if (path === '/api/device') return Response.json({
      name: 'Strip', hardware_ready: true,
      channels: Array.from({ length: 4 }, (_, i) => ({
        name: String(i + 1), on: false, power_mw: 0, meter_wh: 0
      }))
    });
    if (path === '/api/version') return Response.json({ version: '2.1.1' });
    if (path === '/api/config' && opts.method === 'POST') {
      assert.equal(opts.headers.Origin, 'http://192.168.0.55');
      assert.equal(opts.headers['Content-Type'], 'application/octet-stream');
      assert.equal(opts.headers['X-MTTL-Keep-Password'], '1');
      assert.equal(Buffer.from(opts.body)[0], 7);
      config = { ...config, button_lock: Buffer.from(opts.body).at(-9) };
      // Simulate a lost HTTP response even though flash write succeeded.
      throw Error('connection closed after commit');
    }
    if (path === '/api/config') return Response.json(config);
    if (path === '/api/scan' && opts.method === 'POST') {
      assert.equal(opts.headers.Origin, 'http://192.168.0.55');
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (path === '/api/scan') return Response.json({
      pending: false, failed: false,
      networks: [{ ssid_hex: '5465737457694669', rssi: -40, security: 3 }]
    });
    if (path === '/api/firmware/status') return Response.json({
      ota_ready: true, version: '2.1.1', build_id: 'testing'
    });
    if (path === '/api/memory') return Response.json({ heap_free_bytes: 12345 });
    if (path === '/api/energy') return Response.json({ save_failures: 0 });
    throw Error('Unexpected path: ' + path);
  };
  try {
    const manager = new BridgeManager(join(folder, 'bridges.json'), fetcher);
    await manager.load();
    const bridge = await manager.add({ name: 'Office', url: 'http://192.168.0.55' });
    const [dev] = (await manager.status()).devices;
    const service = new StandaloneService(manager);
    const info = await service.info(bridge.id, dev.id);
    assert.equal(info.config.device, 'Strip');
    assert.equal(info.firmware.ota_ready, true);
    assert.equal(info.memory.heap_free_bytes, 12345);
    assert.equal(info.schedule.rules.length, 8);
    const saved = await service.update(bridge.id, dev.id, { section: 'locks', button_lock: 5 });
    assert.equal(saved.confirmed, true);
    assert.equal(saved.config.button_lock, 5);
    assert.equal(calls.filter(c => c.path === '/api/config' && c.method === 'POST').length, 1);
    const scanned = await service.scan(bridge.id, dev.id);
    assert.equal(scanned.networks[0].ssid, 'TestWiFi');
    assert.equal(scanned.networks[0].rssi, -40);
    await assert.rejects(service.firmwareUpload(bridge.id, dev.id, Buffer.from([1, 2]), 'x'), /checksum/i);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeManager } from '../src/manager.mjs';
import { isStandaloneStatus } from '../src/standalone.mjs';

const status = { state: 5, mac: 'aa:bb:cc:dd:ee:ff', hardware_ready: true, rssi: -48 };
const mkChannel = n => ({ name: 'Outlet ' + n, on: false, power_mw: 5000, meter_wh: 250, temp_dc: 265, current_ma: 120, locked: false });

test('standalone signature does not match MatterBridge', () => {
  assert.equal(isStandaloneStatus(status), true);
  assert.equal(isStandaloneStatus({ devices: [], ok: true }), false);
});

test('direct standalone status and safe binary control with confirmation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voltra-standalone-'));
  let state = false;
  let controlCount = 0;
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, options });
    if (u.pathname === '/api/status') return Response.json(status);
    if (u.pathname === '/api/device') return Response.json({
      name: 'Kitchen Strip', hardware_ready: true, voltage_dv: 2260, current_ma: 450,
      channels: Array.from({ length: 4 }, (_, i) => ({ ...mkChannel(i + 1), on: i === 0 ? state : false }))
    });
    if (u.pathname === '/api/version') return Response.json({ version: '2.1.1' });
    if (u.pathname === '/api/control') {
      controlCount++;
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Origin, 'http://192.168.0.55');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.deepEqual(Array.from(options.body), [0, 1]);
      state = true;
      return Response.json({ accepted: true });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const manager = new BridgeManager(join(dir, 'bridges.json'), fetcher);
    await manager.load();
    const b = await manager.add({ name: 'IT', url: 'http://192.168.0.55' });
    const data = await manager.status();
    assert.equal(data.bridges[0].type, 'standalone');
    assert.equal(data.devices.length, 1);
    assert.equal(data.devices[0].firmwareVersion, '2.1.1');
    assert.equal(data.devices[0].id, 'AABBCCDDEEFF');
    assert.equal(data.devices[0].name, 'Kitchen Strip');
    assert.equal(data.devices[0].voltageV, 226);
    assert.equal(data.devices[0].outlets[0].powerW, 5);
    assert.equal(data.devices[0].outlets[0].energyWh, 250);
    assert.equal(data.devices[0].outlets[0].temperatureC, 26.5);
    const result = await manager.setOutlet(b.id, 'AABBCCDDEEFF', 1, true);
    assert.equal(result.confirmed, true);
    assert.equal(controlCount, 1);
    assert.equal((await manager.status()).devices[0].outlets[0].on, true);
    assert.equal(calls.filter(c => c.path === '/api/control').length, 1);
    await assert.rejects(manager.removeDevice(b.id, 'AABBCCDDEEFF'), /Remove this Standalone strip/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

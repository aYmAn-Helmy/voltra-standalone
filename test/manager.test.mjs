import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeManager, normalizeBridge, ApiError, aggregate } from '../src/manager.mjs';

test('limits targets to local HTTP origins by default', () => {
  assert.throws(() => normalizeBridge({ name: 'bad', url: 'https://example.com/' }), ApiError);
  assert.throws(() => normalizeBridge({ name: 'bad', url: 'http://user:pass@192.168.1.10:8086/' }), ApiError);
  assert.equal(normalizeBridge({ name: 'Lab', url: 'http://192.168.1.10:8086/' }).url,
    'http://192.168.1.10:8086');
});
test('stores sources and rejects duplicates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voltra-'));
  try {
    const config = join(folder, 'bridges.json');
    const manager = new BridgeManager(config); await manager.load();
    const b = await manager.add({ name: 'Lab', url: 'http://192.168.1.10:8086' });
    await assert.rejects(manager.add({ name: 'Again', url: b.url }), ApiError);
    const next = new BridgeManager(config); await next.load();
    assert.equal(next.list().length, 1);
    await next.remove(b.id);
    assert.equal(next.list().length, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('totals ignore offline devices', () => {
  const a = aggregate([
    { id: 'a', name: 'a', online: true, devices: [{ id: 'X', reachable: true,
      outlets: [{ on: true, powerW: 25, energyWh: 180 }] }] },
    { id: 'b', name: 'b', online: false, devices: [{ id: 'X', reachable: false,
      outlets: [{ on: true, powerW: 33, energyWh: 600 }] }] }
  ]);
  assert.equal(a.devices.length, 2);
  assert.equal(a.summary.devicesOnline, 1);
  assert.equal(a.summary.powerW, 25);
  assert.equal(a.summary.outletsOn, 1);
});
test('caches previously seen devices as offline if source disconnects', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voltra-'));
  try {
    let online = true;
    const fetcher = async () => {
      if (!online) throw new Error('unreachable');
      return { ok: true, text: async () => JSON.stringify({ devices: [
        { id: '123456789ABC', reachable: true, outlets: [{ index: 1, on: true, powerW: 5, energyWh: 100 }] }
      ], commissioning: { commissioned: false, manualPairingCode: '1234' } }) };
    };
    const manager = new BridgeManager(join(folder, 'bridges.json'), fetcher);
    await manager.load();
    await manager.add({ name: 'Office', url: 'http://10.0.0.1:8086' });
    assert.equal((await manager.status()).summary.powerW, 5);
    online = false;
    const result = await manager.status();
    assert.equal(result.summary.devicesOnline, 0);
    assert.equal(result.summary.devices, 1);
    assert.equal(result.bridges[0].online, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

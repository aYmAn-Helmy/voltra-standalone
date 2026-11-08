import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function harness() {
  const source = await readFile(new URL('../public/live.js', import.meta.url), 'utf8');
  const created = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; created.push(this); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    dispatch(name, data) { this.handlers.get(name)?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const environment = { window: { EventSource: FakeEventSource }, EventSource: FakeEventSource };
  environment.globalThis = environment;
  runInNewContext(source, environment);
  return { api: environment.VoltraLive, created };
}
const strip = () => ({
  bridgeId: 'office', id: 'AABBCCDDEEFF', sourceType: 'standalone',
  name: 'Old', reachable: true, controlAvailable: true, outlets: [
    { index: 1, on: false, powerW: 0, energyWh: 0 },
    { index: 2, on: false, powerW: 0, energyWh: 0 },
    { index: 3, on: false, powerW: 0, energyWh: 0 },
    { index: 4, on: false, powerW: 0, energyWh: 0 }
  ]
});
const firmware = (on = true) => ({
  name: 'New', hardware_ready: true, voltage_dv: 2280, current_ma: 300,
  channels: Array.from({ length: 4 }, (_, i) => ({
    name: 'Port ' + (i + 1), on: i === 0 ? on : false,
    power_mw: i === 0 ? 12000 : 0, meter_wh: 290,
    temp_dc: 275, current_ma: i === 0 ? 250 : 0, locked: i === 1
  }))
});

test('browser parses firmware events into device card readings without reloading', async () => {
  const { api, created } = await harness();
  const d = strip(), devices = [d];
  const callbacks = [];
  api.start((type, x) => callbacks.push({ type, x }), () => {});
  assert.equal(created.length, 1);
  assert.equal(created[0].url, '/api/live/events');
  const now = Date.now();
  created[0].dispatch('source', { bridgeId: 'office', deviceId: d.id, connected: true, at: now });
  assert.equal(api.liveCount(), 1);
  created[0].dispatch('device', {
    bridgeId: 'office', deviceId: d.id, at: now, snapshot: firmware()
  });
  assert.equal(callbacks.length, 1);
  assert.equal(api.receive(callbacks[0].type, callbacks[0].x, devices), true);
  assert.equal(d.name, 'New');
  assert.equal(d.outlets[0].on, true);
  assert.equal(d.outlets[0].powerW, 12);
  assert.equal(d.outlets[0].energyWh, 290);
  assert.equal(d.outlets[0].temperatureC, 27.5);
  assert.equal(d.outlets[1].locked, true);
  const refresh = { devices: [strip()] };
  api.hydrate(refresh);
  assert.equal(refresh.devices[0].name, 'New');
  assert.equal(refresh.devices[0].outlets[0].on, true);
  api.invalidate('office', d.id);
  const afterCommand = { devices: [strip()] };
  api.hydrate(afterCommand);
  assert.equal(afterCommand.devices[0].name, 'Old', 'new confirmed HTTP state must not be overwritten');
  api.stop();
  assert.equal(created[0].closed, true);
});

test('relay events override channel state only for correct MAC/bridge, then reset on stop', async () => {
  const { api, created } = await harness();
  const d = strip();
  api.start(() => {}, () => {});
  const now = Date.now();
  const envelope = { bridgeId: 'office', deviceId: d.id,
    at: now, snapshot: { known: 15, on: 2, fault: 0 } };
  assert.equal(api.receive('relay', envelope, [d]), true);
  assert.equal(d.outlets[0].on, false);
  assert.equal(d.outlets[1].on, true);
  assert.equal(api.receive('relay', { ...envelope, deviceId: 'NOT_DEVICE' }, [d]), false);
  assert.equal(api.receive('relay', { ...envelope, snapshot: { known: 16, on: 2, fault: 0 } }, [d]), false);
  api.stop();
  assert.equal(created[0].closed, true);
});

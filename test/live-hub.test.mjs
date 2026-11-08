import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveHub, FrameParser } from '../src/live-hub.mjs';

function delay(ms = 25) { return new Promise(resolve => setTimeout(resolve, ms)); }
function client() {
  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.output = ''; this.destroyed = false; this.writableEnded = false;
      this.writableLength = 0;
    }
    writeHead(code, headers) {
      this.code = code; this.headers = headers;
    }
    flushHeaders() {}
    write(value) { this.output += value; return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.writableEnded = true; this.emit('close'); }
  }
  return new FakeResponse();
}
const relay = 'event: relay\ndata: {"known":15,"on":3,"fault":0}\n\n';
const device = 'event: device\ndata: {"channels":[{"on":true,"power_mw":1100},{"on":false,"power_mw":0},{"on":false,"power_mw":0},{"on":false,"power_mw":0}],"name":"Office"}\n\n';

test('parser handles fragmented CRLF, keepalive and malformed frame bounds', () => {
  const events = [];
  const parser = new FrameParser((type, data) => events.push({ type, data }));
  parser.push(':keepalive\r\n\r\nevent: relay\r\ndata: {"known":15,\r\n');
  parser.push('data: "on":3,"fault":0}\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'relay');
  assert.deepEqual(JSON.parse(events[0].data), { known: 15, on: 3, fault: 0 });
  assert.throws(() => parser.push('x'.repeat(14000)), /limit|large/i);
});

test('two dashboard viewers share exactly one physical SSE connection', async () => {
  const encoder = new TextEncoder();
  let starts = 0, controllers = [];
  const manager = {
    bridges: [{ id: 'office', url: 'http://192.168.0.55' }],
    cache: new Map([['office', { type: 'standalone', online: true, devices: [
      { id: 'AABBCCDDEEFF', reachable: true }
    ] }]]),
    request: async (id, path) => {
      assert.equal(id, 'office');
      assert.equal(path, '/api/status');
      return { state: 5, mac: 'aa:bb:cc:dd:ee:ff' };
    },
    fetcher: async (url, options) => {
      assert.equal(url, 'http://192.168.0.55/api/events');
      assert.equal(options.headers.Accept, 'text/event-stream');
      starts++;
      const body = new ReadableStream({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(encoder.encode(relay.slice(0, 20)));
          controller.enqueue(encoder.encode(relay.slice(20) + device));
        },
        cancel() {}
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
  };
  const hub = new LiveHub(manager, { retryMin: 1000, retryMax: 1000 });
  const a = client(), b = client();
  try {
    hub.addClient(a);
    hub.addClient(b);
    await delay(60);
    assert.equal(starts, 1, 'one upstream for two viewers');
    assert.equal(a.code, 200);
    assert.match(a.headers['Content-Type'], /text\/event-stream/);
    assert.match(a.output, /event: relay/);
    assert.match(a.output, /event: device/);
    assert.match(b.output, /event: device/);
    assert.match(a.output, /"bridgeId":"office"/);
    assert.match(b.output, /"deviceId":"AABBCCDDEEFF"/);
    a.destroy();
    assert.equal(hub.clients.size, 1, 'other viewer retains SSE upstream');
    b.destroy();
    await delay(30);
    assert.equal(hub.clients.size, 0);
    assert.equal(hub.sources.size, 0);
  } finally {
    hub.close();
    for (const c of controllers) { try { c.close(); } catch {} }
  }
});

test('IP/MAC mismatch blocks firmware stream and clients get fallback notice', async () => {
  let opened = 0;
  const manager = {
    bridges: [{ id: 'office', url: 'http://192.168.0.55' }],
    cache: new Map([['office', { type: 'standalone', online: true, devices: [
      { id: 'AABBCCDDEEFF', reachable: true }
    ] }]]),
    request: async () => ({ state: 5, mac: '11:22:33:44:55:66' }),
    fetcher: async () => { opened++; throw Error('should never open stream'); }
  };
  const hub = new LiveHub(manager, { retryMin: 60000, retryMax: 60000 });
  const a = client();
  try {
    hub.addClient(a);
    await delay(20);
    assert.equal(opened, 0);
    assert.match(a.output, /"connected":false/);
  } finally { hub.close(); }
});

test('removed source and browser disconnect stop upstream without reconnecting', async () => {
  let opens = 0;
  const manager = {
    bridges: [{ id: 'it', url: 'http://192.168.0.55' }],
    cache: new Map([['it', { type: 'standalone', online: true, devices: [
      { id: 'AABBCCDDEEFF', reachable: true }
    ] }]]),
    request: async () => ({ state: 5, mac: 'aa:bb:cc:dd:ee:ff' }),
    fetcher: async () => {
      opens++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
  };
  const hub = new LiveHub(manager, { retryMin: 1000, retryMax: 1000 });
  const a = client();
  try {
    hub.addClient(a);
    await delay(30);
    assert.equal(opens, 1);
    manager.bridges = [];
    hub.sync();
    assert.equal(hub.sources.size, 0);
    await delay(40);
    assert.equal(opens, 1, 'removed source never reconnected');
  } finally {
    a.destroy();
    hub.close();
  }
});

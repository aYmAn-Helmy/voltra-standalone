// One upstream SSE connection per physical standalone strip; many authenticated Voltra
// clients share it. The firmware permits only ONE event stream at a time.
// No untrusted events from removed/reassigned IPs are ever sent to browsers.
import { isStandaloneStatus } from './standalone.mjs';

const WAIT_MIN = 3000;
const WAIT_MAX = 15000;
const IDLE_MS = 35000;
const MAX_FRAME = 12000;
const MAX_CLIENTS = 32;
const now = () => Date.now();

function validDevice(s) {
  return s && typeof s === 'object' && Array.isArray(s.channels) &&
    s.channels.length === 4 && s.channels.every(c => c && typeof c === 'object' &&
      (c.on === true || c.on === false || c.on === null) &&
      (c.power_mw == null || Number.isFinite(c.power_mw)));
}
function validRelay(s) {
  return s && typeof s === 'object' &&
    [s.known, s.on, s.fault].every(Number.isInteger) &&
    s.known >= 0 && s.known <= 15 && s.on >= 0 && s.on <= 15 &&
    s.fault >= 0 && s.fault <= 65535;
}

// SSE frames are separated by blank lines, including CRLF frames split across
// TCP chunks. A single embedded device must not be able to grow a server buffer.
export class FrameParser {
  constructor(onFrame) { this.onFrame = onFrame; this.buffer = ''; }
  push(text) {
    this.buffer += text;
    if (this.buffer.length > MAX_FRAME * 2) throw Error('SSE stream exceeded frame limit');
    let index;
    while ((index = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const match = this.buffer.slice(index).match(/^\r?\n\r?\n/);
      const chunk = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + match[0].length);
      if (chunk.length > MAX_FRAME) throw Error('SSE frame too large');
      let kind = 'message', data = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event:')) kind = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) this.onFrame(kind, data.join('\n'));
    }
    if (this.buffer.length > MAX_FRAME) throw Error('SSE partial frame too large');
  }
}

export class LiveHub {
  constructor(manager, { idleMs = IDLE_MS, retryMin = WAIT_MIN, retryMax = WAIT_MAX } = {}) {
    this.manager = manager;
    this.idleMs = idleMs;
    this.retryMin = retryMin;
    this.retryMax = retryMax;
    this.clients = new Set();
    this.sources = new Map();
    this.heartbeatTimer = null;
    this.closed = false;
  }

  event(res, event, data) {
    if (res.destroyed || res.writableEnded || res.writableLength > 256_000) {
      if (!res.destroyed) res.destroy();
      return false;
    }
    const output = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    try { res.write(output); return true; } catch { res.destroy(); return false; }
  }
  emit(event, payload) {
    for (const res of this.clients) {
      if (!this.event(res, event, payload)) this.clients.delete(res);
    }
    if (this.clients.size === 0) this.stopAll();
  }
  addClient(res) {
    if (this.closed) throw Error('Event service is shutting down');
    if (this.clients.size >= MAX_CLIENTS) throw Error('Maximum live viewers reached');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.flushHeaders?.();
    this.clients.add(res);
    if (!this.heartbeatTimer) {
      // Keep intermediate HTTP proxies from buffering/closing idle SSE responses.
      this.heartbeatTimer = setInterval(() => {
        for (const client of this.clients) {
          if (!this.event(client, 'ping', { at: now() })) this.clients.delete(client);
        }
        if (!this.clients.size) this.stopAll();
      }, 15000);
      this.heartbeatTimer.unref?.();
    }
    this.event(res, 'hello', { connected: true, at: new Date().toISOString() });
    const done = () => {
      this.clients.delete(res);
      if (!this.clients.size) this.stopAll();
    };
    res.once('close', done);
    this.sync();
  }
  sync() {
    if (this.closed || !this.clients.size) return;
    const wanted = new Map();
    for (const bridge of this.manager.bridges) {
      const cached = this.manager.cache.get(bridge.id);
      const device = cached?.type === 'standalone' && cached.online && cached.devices?.[0];
      if (device?.id && device.reachable) wanted.set(bridge.id, { bridge, deviceId: device.id });
    }
    for (const [id, entry] of this.sources) {
      const next = wanted.get(id);
      if (!next || next.deviceId !== entry.deviceId || next.bridge.url !== entry.url) {
        this.stop(id);
      }
    }
    for (const [id, source] of wanted) {
      if (!this.sources.has(id)) this.start(id, source.bridge.url, source.deviceId);
    }
  }
  start(id, url, deviceId) {
    const entry = {
      id, url, deviceId, active: true, controller: null, retry: this.retryMin,
      timer: null, watchdog: null
    };
    this.sources.set(id, entry);
    void this.connect(entry);
  }
  stop(id) {
    const entry = this.sources.get(id);
    if (!entry) return;
    this.sources.delete(id);
    entry.active = false;
    clearTimeout(entry.timer);
    clearTimeout(entry.watchdog);
    entry.controller?.abort();
  }
  stopAll() {
    for (const id of [...this.sources.keys()]) this.stop(id);
    if (!this.clients.size) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  close() {
    this.closed = true;
    this.stopAll();
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
  retry(entry) {
    if (!entry.active || this.closed || !this.clients.size) return;
    const delay = entry.retry;
    entry.retry = Math.min(entry.retry * 2, this.retryMax);
    entry.timer = setTimeout(() => { void this.connect(entry); }, delay);
    entry.timer.unref?.();
  }
  async connect(entry) {
    if (!entry.active || this.closed || !this.clients.size) return;
    const controller = new AbortController();
    entry.controller = controller;
    let reader;
    try {
      // Check the LIVE MAC before opening a long-lived event stream.
      // A DHCP reassignment must never attach an unrelated physical strip.
      const id = entry.id;
      const live = await this.manager.request(id, '/api/status');
      if (!isStandaloneStatus(live) ||
        live.mac.replaceAll(':', '').toUpperCase() !== entry.deviceId.toUpperCase()) {
        throw Error('Source MAC changed; live stream refused');
      }
      if (!entry.active) return;
      const response = await this.manager.fetcher(entry.url + '/api/events', {
        method: 'GET', headers: { Accept: 'text/event-stream' },
        redirect: 'error', signal: controller.signal
      });
      if (!response.ok || !response.body ||
        !(response.headers.get('content-type') || '').includes('text/event-stream')) {
        throw Error('Device SSE unavailable (HTTP ' + response.status + ')');
      }
      entry.retry = this.retryMin;
      this.emit('source', { bridgeId: id, deviceId: entry.deviceId, connected: true, at: now() });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new FrameParser((kind, raw) => {
        if (!entry.active || raw.length > MAX_FRAME) return;
        if (kind !== 'relay' && kind !== 'device') return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        if (kind === 'device' && !validDevice(data)) return;
        if (kind === 'relay' && !validRelay(data)) return;
        this.emit(kind, {
          bridgeId: id, deviceId: entry.deviceId, at: now(), snapshot: data
        });
      });
      const resetIdle = () => {
        clearTimeout(entry.watchdog);
        entry.watchdog = setTimeout(() => controller.abort(), this.idleMs);
        entry.watchdog.unref?.();
      };
      resetIdle();
      while (entry.active && this.clients.size && !this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          resetIdle();
          parser.push(decoder.decode(value, { stream: true }));
        }
      }
    } catch (error) {
      if (entry.active && !this.closed && this.clients.size) {
        this.emit('source', {
          bridgeId: entry.id, deviceId: entry.deviceId, connected: false,
          reason: 'Stream interrupted', at: now()
        });
      }
    } finally {
      clearTimeout(entry.watchdog);
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch {} }
      if (entry.controller === controller) entry.controller = null;
      this.retry(entry);
    }
  }
}

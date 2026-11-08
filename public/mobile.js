/* Voltra Android standalone transport. Reuses the exact Voltra cards/settings UI,
 * but replaces its Node server routes with Android's private-LAN HTTP adapter.
 * No remote website, WebSocket bridge, cloud or MatterBridge is required. */
(() => {
  'use strict';
  if (!window.VoltraAndroid) return;

  const REQUEST_TIMEOUT = 110000;
  let seq = 0;
  const pending = new Map();
  const sourceCache = new Map();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
  const macId = mac => mac.replaceAll(':', '').toUpperCase();
  const fail = text => { throw new Error(text); };
  const num = (x, a, b, name) => {
    if (!Number.isInteger(x) || x < a || x > b) fail('Invalid ' + name);
    return x;
  };
  const stringField = (x, limit, name, mandatory = false) => {
    if (typeof x !== 'string' || encoder.encode(x).length > limit ||
      /[\x00-\x1f\x7f]/.test(x) || (mandatory && !x.trim())) fail('Invalid ' + name);
    return x;
  };

  window.__voltraNativeDone = (id, json) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    try {
      const data = JSON.parse(json);
      if (data.error) item.reject(Error(data.error));
      else item.resolve(data);
    } catch (e) { item.reject(e); }
  };
  function native(op, value = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id); reject(Error('Android connection timed out'));
      }, REQUEST_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      try { window.VoltraAndroid.run(id, op, JSON.stringify(value)); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  function b64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(text);
  }
  function fromHex(hex) {
    if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) fail('Invalid hex data');
    return Uint8Array.from(hex.match(/../g) || [], x => parseInt(x, 16));
  }
  function hex(bytes) {
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  }
  async function http(origin, path, method = 'GET', body = null, headers = {}, timeout = 5000) {
    const request = { url: origin + path, method, headers: {
      ...headers,
      ...(method === 'POST' ? { Origin: origin } : {})
    }, timeout };
    if (body instanceof Uint8Array) request.bodyBase64 = b64(body);
    else if (body !== null && body !== undefined) request.bodyText = String(body);
    const response = await native('http', request);
    let result;
    try { result = JSON.parse(response.body); }
    catch { fail('Invalid firmware JSON from ' + path); }
    if (response.status < 200 || response.status >= 300)
      fail(result?.error || 'Firmware HTTP ' + response.status + ' on ' + path);
    return result;
  }
  async function list() {
    const result = await native('sources');
    for (const source of result.sources) sourceCache.set(source.id, source);
    return result.sources;
  }
  const cached = new Map();
  const sourceType = s => s.type === 'standalone' ? 'standalone' : 'unknown';
  function convert(source, s, d, version) {
    const scale = (v, factor) => typeof v === 'number' && Number.isFinite(v) ? v / factor : null;
    const mac = s.mac.replaceAll(':', '').toUpperCase();
    return {
      id: mac, name: d.name || source.name, sourceType: 'standalone', sourceUrl: source.url,
      firmwareVersion: version?.version || 'Standalone', reachable: s.state === 5,
      controlAvailable: s.state === 5 && s.hardware_ready === true && d.hardware_ready === true,
      voltageV: scale(d.voltage_dv, 10), currentA: scale(d.current_ma, 1000),
      uptimeMs: s.uptime_ms ?? null, rssi: Number.isInteger(s.rssi) ? s.rssi : null,
      protection: d.protection ?? null, timerRunning: d.timer_running ?? 0,
      timerEnd: Array.isArray(d.timer_end) ? d.timer_end : null,
      outlets: d.channels.map((o, index) => ({
        index: index + 1, name: o.name || 'مخرج ' + (index + 1),
        on: typeof o.on === 'boolean' ? o.on : null,
        powerW: scale(o.power_mw, 1000), energyWh: scale(o.meter_wh, 1),
        temperatureC: scale(o.temp_dc, 10), currentA: scale(o.current_ma, 1000),
        locked: o.locked === true
      }))
    };
  }
  async function aggregate() {
    const sources = await list();
    const results = await Promise.all(sources.map(async source => {
      try {
        const s = await http(source.url, '/api/status');
        if (!Number.isInteger(s.state) ||
            !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(s.mac)) fail('Unsupported firmware API');
        if (source.mac && source.mac.toUpperCase() !== s.mac.toUpperCase())
          fail('IP is now assigned to another MAC; rescan the Wi-Fi');
        const d = await http(source.url, '/api/device');
        if (!Array.isArray(d.channels) || d.channels.length !== 4) fail('Expected four outlets');
        const previous = cached.get(source.id);
        // Version changes only on firmware upgrade; avoid extra firmware HTTP
        // request on each fallback poll.
        let version = previous?.firmware;
        if (!version) {
          try { version = await http(source.url, '/api/version'); } catch { version = { version: 'Standalone' }; }
        }
        const item = { ...source, type: 'standalone', online: true,
          lastSyncAt: new Date().toISOString(), error: null, commissioning: null,
          devices: [convert(source, s, d, version)] };
        cached.set(source.id, { ...item, firmware: version });
        return item;
      } catch (e) {
        const old = cached.get(source.id);
        return { ...source, type: old?.type || 'unknown',
          online: false, error: e.message, lastSyncAt: old?.lastSyncAt || null,
          commissioning: null, devices: (old?.devices || []).map(d => ({
            ...d, reachable: false, controlAvailable: false
          })) };
      }
    }));
    const devices = results.flatMap(s => s.devices.map(d => ({
      ...d, bridgeId: s.id, bridgeName: s.name
    })));
    const active = devices.filter(d => d.reachable), outlets = active.flatMap(d => d.outlets);
    return { bridges: results, devices, summary: {
      bridges: results.length, bridgesOnline: results.filter(s => s.online).length,
      devices: devices.length, devicesOnline: active.length,
      outletsOn: outlets.filter(o => o.on === true).length,
      powerW: outlets.reduce((total, o) => total + (o.powerW ?? 0), 0),
      energyWh: outlets.reduce((total, o) => total + (o.energyWh ?? 0), 0)
    } };
  }
  async function sourceFor(bridge, mac) {
    if (!validId(bridge) || !validId(mac)) fail('Invalid device identifier');
    const sources = await list();
    const source = sources.find(s => s.id === bridge);
    if (!source) fail('Source not found');
    if (source.mac && macId(source.mac) !== mac.toUpperCase()) fail('Device MAC mismatch');
    const fresh = await http(source.url, '/api/status');
    if (macId(fresh.mac || '') !== mac.toUpperCase())
      fail('Physical device MAC changed; Wi-Fi rescan is required before writing');
    return source;
  }

  const emptyRule = () => ({ minute: 0, mode: 0, day: 0, channel: 0, on: 0 });
  function decodeSchedule(raw) {
    if (typeof raw !== 'string' || !/^[0-9a-f]{100}$/i.test(raw)) fail('Invalid schedule_hex');
    const bytes = fromHex(raw), v = new DataView(bytes.buffer);
    const rules = [];
    for (let i = 0; i < 8; i++) {
      const p = 2 + i * 6;
      rules.push({ minute: v.getUint16(p, true), mode: bytes[p + 2],
        day: bytes[p + 3], channel: bytes[p + 4], on: bytes[p + 5] });
    }
    return { timezone: v.getInt16(0, true), rules };
  }
  function encodeSchedule(s) {
    if (!s || !Array.isArray(s.rules) || s.rules.length !== 8) fail('Eight schedule rules required');
    num(s.timezone, -720, 840, 'timezone');
    if (s.timezone % 15) fail('Timezone must be in 15-minute steps');
    const bytes = new Uint8Array(50), v = new DataView(bytes.buffer);
    v.setInt16(0, s.timezone, true);
    s.rules.forEach((r, i) => {
      num(r.minute, 0, 1439, 'rule minute');
      const mode = num(r.mode, 0, 255, 'rule mode');
      const kind = mode & 127, day = num(r.day, 0, 127, 'rule day');
      num(r.channel, 0, 4, 'rule outlet'); num(r.on, 0, 1, 'rule action');
      if (kind > 4 || (!kind && (r.minute || r.day || r.channel || r.on || mode)) ||
        (kind === 2 && !day) || (kind === 3 && (day < 1 || day > 31)) ||
        ([1, 4].includes(kind) && day)) fail('Invalid repeat schedule');
      const p = 2 + i * 6;
      v.setUint16(p, r.minute, true); bytes[p + 2] = mode;
      bytes[p + 3] = day; bytes[p + 4] = r.channel; bytes[p + 5] = r.on;
    });
    return hex(bytes);
  }
  function validateTimers(minutes, scheduleHex) {
    if (!Array.isArray(minutes) || minutes.length !== 4) fail('Four timers required');
    minutes.forEach((m, i) => num(m, 0, 1440, 'timer ' + (i + 1)));
    const schedule = decodeSchedule(scheduleHex);
    if (schedule.rules.some(r => (r.mode & 127) &&
      minutes.some((m, i) => m && (r.channel === 4 || r.channel === i)))) {
      fail('Timer conflicts with scheduled outlet');
    }
  }
  function patchConfig(current, input) {
    if (!current || !Array.isArray(current.channels) || current.channels.length !== 4)
      fail('Invalid firmware configuration');
    const next = JSON.parse(JSON.stringify(current));
    let password;
    switch (input.section) {
      case 'names':
        next.device = stringField(input.device, 64, 'device name', true).trim();
        if (!Array.isArray(input.channels) || input.channels.length !== 4)
          fail('Four channel names required');
        next.channels = input.channels.map((n, i) => stringField(n, 64, 'outlet ' + i, true).trim());
        break;
      case 'locks':
        next.button_lock = num(input.button_lock, 0, 15, 'lock mask');
        break;
      case 'timers':
        next.timer_minutes = input.timer_minutes;
        break;
      case 'schedule':
        next.schedule_hex = encodeSchedule(input.schedule);
        break;
      case 'protection': {
        const p = input.protection || {};
        next.protection = {
          enabled: num(p.enabled, 0, 7, 'protection mask'),
          temperature: num(p.temperature, 50, 90, 'temperature'),
          current: num(p.current, 1000, 16000, 'current'),
          power: num(p.power, 100, 3000, 'power')
        };
        break;
      }
      case 'mqtt':
        next.broker = stringField(input.broker, 253, 'MQTT broker');
        next.user = stringField(input.user, 64, 'MQTT user');
        next.topic = stringField(input.topic, 64, 'MQTT topic');
        next.port = num(input.port, 1, 65535, 'MQTT port');
        if (typeof input.enabled !== 'boolean') fail('Invalid MQTT enabled value');
        next.enabled = input.enabled;
        if (input.password !== undefined && input.password !== '') {
          password = stringField(input.password, 64, 'MQTT password');
        }
        break;
      case 'language':
        next.language = num(input.language, 0, 1, 'language');
        break;
      default: fail('Unsupported settings section');
    }
    validateTimers(next.timer_minutes, next.schedule_hex);
    return { next, password, section: input.section };
  }
  function serializeConfig(c, password = '') {
    const names = [c.device, ...c.channels, '', '', c.broker, c.user, password, c.topic];
    const caps = [64,64,64,64,64,32,64,253,64,64,64];
    if (names.length !== 11) fail('Unexpected device settings format');
    const strings = names.map((n, i) => {
      stringField(n, caps[i], 'field '+i, i < 5);
      const bytes = encoder.encode(n);
      return Uint8Array.of(bytes.length, ...bytes);
    });
    const prot = c.protection, bytes = new Uint8Array(7),
      pv = new DataView(bytes.buffer);
    if (!prot) fail('No protection config');
    bytes[0] = num(prot.enabled, 0, 7, 'protection');
    pv.setUint16(1, num(prot.temperature, 50, 90, 'temperature'), true);
    pv.setUint16(3, num(prot.current, 1000, 16000, 'current'), true);
    pv.setUint16(5, num(prot.power, 100, 3000, 'power'), true);
    const head = Uint8Array.of(7, num(c.language, 0, 1, 'language'),
      c.enabled ? 1 : 0, c.port & 255, c.port >>> 8);
    const tail = new Uint8Array(9); tail[0] = num(c.button_lock, 0, 15, 'locks');
    const tv = new DataView(tail.buffer);
    c.timer_minutes.forEach((m, i) => tv.setUint16(1 + i * 2, m, true));
    const parts = [head, ...strings, bytes, fromHex(encodeSchedule(decodeSchedule(c.schedule_hex))), tail];
    const size = parts.reduce((a, b) => a + b.length, 0);
    if (size > 1024) fail('Device config is too large');
    const out = new Uint8Array(size); let cursor = 0;
    for (const part of parts) { out.set(part, cursor); cursor += part.length; }
    return out;
  }
  function configMatches(a, b, section, changed) {
    if (!b?.persistent) return false;
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    switch (section) {
      case 'names': return a.device === b.device && eq(a.channels, b.channels);
      case 'locks': return a.button_lock === b.button_lock;
      case 'timers': return eq(a.timer_minutes, b.timer_minutes);
      case 'schedule': return a.schedule_hex === b.schedule_hex;
      case 'protection': return eq(a.protection, b.protection);
      case 'language': return a.language === b.language;
      case 'mqtt': return a.broker === b.broker && a.port === b.port &&
        a.user === b.user && a.topic === b.topic && a.enabled === b.enabled &&
        (!changed || b.mqtt_password_set === true);
    }
    return false;
  }

  async function info(s) {
    const config = await http(s.url, '/api/config');
    const schedule = decodeSchedule(config.schedule_hex);
    async function optional(path) {
      try { return await http(s.url, path); } catch { return null; }
    }
    return { config, schedule, status: await optional('/api/status'),
      device: await optional('/api/device'),
      firmware: await optional('/api/firmware/status'),
      memory: await optional('/api/memory'),
      energy: await optional('/api/energy')
    };
  }
  const saving = new Set();
  async function saveSettings(s, id, patch) {
    const token = s.id + ':' + id;
    if (saving.has(token)) fail('Settings save already in progress');
    saving.add(token);
    let binary;
    try {
      const status = await http(s.url, '/api/status');
      if (![2, 5].includes(status.state)) fail('Device is not ready');
      const current = await http(s.url, '/api/config');
      const { next, password, section } = patchConfig(current, patch);
      binary = serializeConfig(next, password ?? '');
      let resultError = null;
      try {
        await http(s.url, '/api/config', 'POST', binary, {
          'Content-Type': 'application/octet-stream',
          'X-MTTL-Keep-Password': password === undefined ? '1' : '0'
        }, 6000);
      } catch (e) { resultError = e.message; }
      // Firmware may commit to flash before closing TCP; do not retry POST.
      for (let i = 0; i < 16; i++) {
        await sleep(350);
        try {
          const saved = await http(s.url, '/api/config');
          if (configMatches(next, saved, section, password !== undefined)) {
            return { ok: true, confirmed: true, config: saved,
              schedule: decodeSchedule(saved.schedule_hex) };
          }
        } catch {}
      }
      fail('Save not confirmed. Check original device UI before retrying. ' + (resultError || ''));
    } finally {
      binary?.fill(0);
      saving.delete(token);
    }
  }
  async function control(s, id, index, on) {
    if (!Number.isInteger(index) || index < 1 || index > 5 || typeof on !== 'boolean')
      fail('Invalid outlet state command');
    const status = await http(s.url, '/api/status');
    const device = await http(s.url, '/api/device');
    if (status.state !== 5 || !status.hardware_ready || !device.hardware_ready)
      fail('Device cannot accept controls right now');
    const payload = Uint8Array.of(index - 1, on ? 1 : 0);
    const response = await http(s.url, '/api/control', 'POST', payload,
      { 'Content-Type': 'application/octet-stream' });
    if (response.accepted !== true) fail('Device did not accept command');
    for (let i = 0; i < 16; i++) {
      await sleep(200);
      try {
        const d = await http(s.url, '/api/device');
        if (index === 5 && d.channels?.length === 4 &&
          d.channels.every(ch => ch.on === on)) return { confirmed: true, ok: true };
        if (index <= 4 && d.channels?.[index - 1]?.on === on)
          return { confirmed: true, ok: true };
      } catch {}
    }
    fail('Command was accepted, but relay state could not be confirmed. Refresh before retrying.');
  }
  async function wifiScan(s) {
    await http(s.url, '/api/scan', 'POST', '', { 'Content-Type': 'text/plain' });
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const result = await http(s.url, '/api/scan');
      if (result.pending) continue;
      if (result.failed) fail('Device Wi-Fi scan failed');
      return { networks: (result.networks || []).slice(0, 16).map(n => ({
        ssid: decoder.decode(fromHex(n.ssid_hex || '')), rssi: n.rssi,
        security: n.security
      })) };
    }
    fail('Wi-Fi scan timed out');
  }
  async function wifiConnect(s, data) {
    if (!data?.confirm || typeof data.ssid !== 'string' ||
      !data.ssid || encoder.encode(data.ssid).length > 32 ||
      typeof data.password !== 'string' || encoder.encode(data.password).length > 64)
      fail('Invalid Wi-Fi network/password or missing confirmation');
    try {
      const body = new URLSearchParams({ ssid: data.ssid, password: data.password }).toString();
      const response = await http(s.url, '/api/wifi', 'POST', body,
        { 'Content-Type': 'application/x-www-form-urlencoded' }, 6000);
      if (!response.accepted) fail('Wi-Fi setup rejected by strip');
      return { accepted: true, warning: 'Device IP may change after Wi-Fi reconnect. Rescan network.' };
    } catch (e) {
      fail('Wi-Fi change not confirmed; inspect device/SSID before retrying: ' + e.message);
    }
  }
  const FWR_KEY = [0x3f,0x5a,0x27,0xe8,0xd8,0xfb,0x85,0xf9,0xbd,0x4d,0x51,0x19,0x6c,0x4f,0x51,0x59];
  const TAIL = [0x52,0x54,0x4b,0x57,0x69,0x6e,0,0xff,0,1,1,0,0x95,0x81,1,1,0,0,0,0];
  function validateFwr(raw) {
    if (raw.length < 44 || raw.length > 0x70000) fail('Invalid FWR size');
    const bytes = raw.slice();
    for (let i = 16; i < bytes.length; i++) bytes[i] ^= FWR_KEY[i % 16];
    const v = new DataView(bytes.buffer);
    const body = v.getUint32(0, true), load = v.getUint32(4, true);
    if (load !== 0x10006000 || body < 24 || body > 0x6a000 ||
      body + 20 !== bytes.length || bytes.slice(8, 16).some(x => x !== 255))
      fail('Invalid FWR image header');
    const entry = v.getUint32(16, true);
    if (!(entry & 1) || (entry & ~1) < load + 24 || (entry & ~1) >= load + body ||
      TAIL.some((b, i) => bytes[20 + i] !== b)) fail('FWR startup/entry check failed');
    let sum = 0;
    for (let i = 0; i < bytes.length - 4; i++) sum = (sum + bytes[i]) >>> 0;
    if (sum !== v.getUint32(bytes.length - 4, true)) fail('FWR checksum mismatch');
  }
  async function firmwareUpload(s, body, headers) {
    const hash = headers['X-Voltra-FWR-SHA256'];
    if (headers['X-Voltra-Confirm'] !== 'FLASH' ||
      typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))
      fail('Firmware checksum and explicit FLASH confirmation required');
    const bytes = new Uint8Array(await body.arrayBuffer());
    try {
      validateFwr(bytes);
      if (!crypto?.subtle) fail('Secure hashing is unavailable');
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      if (digest !== hash.toLowerCase()) fail('FWR file does not match release SHA-256');
      const state = await http(s.url, '/api/firmware/status');
      if (state.ota_ready !== true) fail('Device reports OTA unavailable');
      // Flashing is intentionally one-shot: no repeat after timeout/reboot.
      return await http(s.url, '/api/firmware/upload', 'POST', bytes,
        { 'Content-Type': 'application/x-mttl-fwr' }, 90000);
    } finally { bytes.fill(0); }
  }

  async function route(path, method, options = {}) {
    if (path === '/api/bridges') {
      if (method === 'GET') return list();
      if (method === 'POST') {
        const input = JSON.parse(options.body || '{}');
        return (await native('add', input)).source;
      }
    }
    if (path === '/api/status' && method === 'GET') return aggregate();
    if (path === '/health' && method === 'GET') return { ok: true };
    let match = path.match(/^\/api\/bridges\/([^/]+)$/);
    if (match && method === 'DELETE') {
      return native('remove', { id: decodeURIComponent(match[1]) });
    }
    match = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)(.*)$/);
    if (!match) fail('Unknown mobile API route ' + path);
    const [, bridge, mac, suffix] = match;
    const s = await sourceFor(decodeURIComponent(bridge), decodeURIComponent(mac));
    if (suffix === '/refresh' && method === 'POST') return http(s.url, '/api/device');
    if (suffix.match(/^\/outlets\/\d+\/state$/) && method === 'POST') {
      const index = Number(suffix.split('/')[2]), request = JSON.parse(options.body || '{}');
      return control(s, mac, index, request.on);
    }
    if (suffix === '/standalone/settings') {
      if (method === 'GET') return info(s);
      if (method === 'POST') return saveSettings(s, mac, JSON.parse(options.body || '{}'));
    }
    if (suffix === '/standalone/wifi/scan' && method === 'POST') return wifiScan(s);
    if (suffix === '/standalone/wifi/connect' && method === 'POST')
      return wifiConnect(s, JSON.parse(options.body || '{}'));
    if (suffix === '/standalone/firmware/upload' && method === 'POST')
      return firmwareUpload(s, options.body, options.headers || {});
    fail('Unsupported Android API route ' + suffix);
  }

  // On Android there is no local Node.js HTTP process. Preserve the frontend's
  // fetch contract with a promise-based native transport and ordinary Response.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(url, options = {}) {
    const target = typeof url === 'string' ? url : url.url;
    if (!target.startsWith('/api/') && target !== '/health') return originalFetch(url, options);
    let path = target.split('?')[0];
    const method = String(options.method || 'GET').toUpperCase();
    try {
      const value = await route(path, method, options);
      return new Response(JSON.stringify(value), {
        status: method === 'POST' && path === '/api/bridges' ? 201 : 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message || String(error) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
  };

  // Native session events mimic EventSource so the existing Voltra SSE card
  // code works without any Node server or mobile browser cross-origin HTTP.
  const sources = new Set();
  class AndroidEventSource {
    constructor(path) {
      this.path = path; this.closed = false; this.listeners = new Map();
      sources.add(this);
      native('startStreams').catch(() => {});
    }
    addEventListener(type, cb) {
      const list = this.listeners.get(type) || [];
      list.push(cb); this.listeners.set(type, list);
    }
    emit(type, payload) {
      for (const cb of this.listeners.get(type) || []) {
        try { cb({ data: JSON.stringify(payload) }); } catch {}
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true; sources.delete(this);
      if (!sources.size) native('stopStreams').catch(() => {});
    }
  }
  window.EventSource = AndroidEventSource;
  window.__voltraNativeEvent = (kind, payload) => {
    try {
      const parsed = JSON.parse(payload);
      for (const source of sources) source.emit(kind, parsed);
    } catch {}
  };

  let scanning = false;
  async function scanNow(silent = false) {
    if (scanning) return;
    scanning = true;
    const button = document.getElementById('mobile-scan');
    if (button) { button.disabled = true; button.textContent = '◌ جاري البحث...'; }
    const status = document.getElementById('mobile-scan-status');
    if (status) status.textContent = 'بنبحث على شبكة Wi-Fi الحالية...';
    try {
      const result = await native('discover');
      if (status) status.textContent = 'آخر فحص: ' + result.subnet +
        ' • ' + result.discovered + ' مشترك تم التعرف عليه';
      if (!silent && window.notify) window.notify('تم العثور على ' + result.discovered + ' مشترك على الشبكة');
      if (window.refresh) await window.refresh();
    } catch (e) {
      if (status) status.textContent = 'تعذر الاكتشاف: ' + e.message;
      if (!silent && window.notify) window.notify(e.message, true);
    } finally {
      scanning = false;
      if (button) { button.disabled = false; button.textContent = '⌁ فحص Wi-Fi'; }
    }
  }
  window.VoltraMobile = { scanNow, native };
  window.addEventListener('load', () => {
    const actions = document.querySelector('.top-actions');
    if (actions) {
      const button = document.createElement('button');
      button.id = 'mobile-scan'; button.type = 'button';
      button.className = 'btn primary'; button.textContent = '⌁ فحص Wi-Fi';
      button.addEventListener('click', () => scanNow(false));
      actions.append(button);
    }
    const aside = document.querySelector('.sidebar');
    if (aside) {
      const message = document.createElement('p');
      message.id = 'mobile-scan-status'; message.className = 'mobile-scan-status';
      message.textContent = 'الاكتشاف التلقائي من شبكة Wi-Fi، بدون سيرفر';
      aside.prepend(message);
    }
    setTimeout(() => scanNow(true), 900);
    // Automatic discovery while the app is open; avoid background LAN scans.
    setInterval(() => {
      if (!document.hidden && !scanning) scanNow(true);
    }, 180000);
  });
})();

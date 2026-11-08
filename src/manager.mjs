import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isStandaloneStatus, standaloneDevice } from './standalone.mjs';

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function localHost(host) {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

export function normalizeBridge(input) {
  if (!input || typeof input !== 'object') throw new ApiError('Bridge details required');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 64 || typeof input.url !== 'string') throw new ApiError('Invalid bridge name or URL');
  let u;
  try { u = new URL(input.url); } catch { throw new ApiError('Invalid bridge URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
      u.pathname !== '/' || u.search || u.hash) throw new ApiError('Use a plain HTTP(S) origin');
  if (!localHost(u.hostname) && process.env.VOLTRA_ALLOW_PUBLIC_UPSTREAMS !== '1') {
    throw new ApiError('Only LAN IPs and .local/.lan hosts are allowed by default');
  }
  return {
    id: typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.id) ? input.id : randomUUID(),
    name, url: u.origin
  };
}

function cleanDevice(d) {
  if (!d || typeof d.id !== 'string' || !Array.isArray(d.outlets)) return null;
  return {
    id: d.id, name: typeof d.name === 'string' ? d.name : d.id,
    reachable: d.reachable === true, firmwareVersion: d.firmwareVersion ?? '',
    outlets: d.outlets.filter(o => o && Number.isInteger(Number(o.index)) && Number(o.index) >= 1 && Number(o.index) <= 4)
      .map(o => ({
        index: Number(o.index), on: o.on === true,
        powerW: o.powerW == null || !Number.isFinite(Number(o.powerW)) ? null : Number(o.powerW),
        energyWh: o.energyWh == null || !Number.isFinite(Number(o.energyWh)) ? null : Number(o.energyWh),
        temperatureC: o.temperatureC == null || !Number.isFinite(Number(o.temperatureC)) ? null : Number(o.temperatureC),
        overheatProtection: o.overheatProtection === true,
        overloadProtection: o.overloadProtection === true
      }))
  };
}

export function aggregate(bridges) {
  const devices = bridges.flatMap(b => b.devices.map(d => ({ ...d, bridgeId: b.id, bridgeName: b.name })));
  const outlets = devices.filter(d => d.reachable).flatMap(d => d.outlets);
  return {
    bridges, devices,
    summary: {
      bridges: bridges.length, bridgesOnline: bridges.filter(b => b.online).length,
      devices: devices.length, devicesOnline: devices.filter(d => d.reachable).length,
      outletsOn: outlets.filter(o => o.on).length,
      powerW: outlets.reduce((sum, o) => sum + (o.powerW ?? 0), 0),
      energyWh: outlets.reduce((sum, o) => sum + (o.energyWh ?? 0), 0)
    }
  };
}

export class BridgeManager {
  constructor(configFile, fetcher = fetch) {
    this.configFile = configFile; this.fetcher = fetcher;
    this.bridges = []; this.cache = new Map(); this.pending = Promise.resolve();
  }
  async load() {
    let data;
    try { data = JSON.parse(await readFile(this.configFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (data.version !== 1 || !Array.isArray(data.bridges)) throw new Error('Invalid bridge configuration');
    const bridges = data.bridges.map(normalizeBridge);
    if (bridges.length > 64 || new Set(bridges.map(b => b.id)).size !== bridges.length ||
        new Set(bridges.map(b => b.url)).size !== bridges.length) throw new Error('Duplicate bridge');
    this.bridges = bridges;
  }
  list() { return this.bridges.map(b => ({ ...b })); }
  get(id) {
    const b = this.bridges.find(b => b.id === id);
    if (!b) throw new ApiError('Bridge not found', 404);
    return b;
  }
  async change(operation) {
    const job = this.pending.then(async () => {
      const next = operation(this.bridges);
      await mkdir(dirname(this.configFile), { recursive: true });
      const tmp = this.configFile + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, bridges: next }, null, 2) + '\n', { mode: 0o600 });
        await rename(tmp, this.configFile);
      } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
      this.bridges = next;
    });
    this.pending = job.catch(() => {});
    return job;
  }
  async add(input) {
    const b = normalizeBridge(input);
    await this.change(current => {
      if (current.length >= 64) throw new ApiError('Maximum 64 bridges');
      if (current.some(item => item.url === b.url)) throw new ApiError('Bridge already registered', 409);
      return [...current, b];
    });
    return b;
  }
  async remove(id) {
    this.get(id);
    await this.change(current => current.filter(b => b.id !== id));
    this.cache.delete(id);
  }
  async request(id, path, { method = 'GET', body, svg = false } = {}) {
    const b = this.get(id);
    let response;
    try {
      response = await this.fetcher(b.url + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { Accept: svg ? 'image/svg+xml' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (e) { throw new ApiError('Bridge unavailable: ' + e.message, 502); }
    if (!response.ok) {
      let message = 'Bridge returned HTTP ' + response.status;
      try { const data = await response.json(); if (data && typeof data.error === 'string') message = data.error; }
      catch {}
      throw new ApiError(message, 502);
    }
    const text = await response.text();
    if (text.length > 2_000_000) throw new ApiError('Upstream response too large', 502);
    if (svg) {
      if (!/<svg[\s>]/i.test(text) || /<script|<foreignObject|onload\s*=/i.test(text)) {
        throw new ApiError('Invalid upstream SVG', 502);
      }
      return text;
    }
    try { return JSON.parse(text); } catch { throw new ApiError('Invalid upstream JSON', 502); }
  }

  async status() {
    const sources = await Promise.all(this.bridges.map(async b => {
      try {
        const data = await this.request(b.id, '/api/status');
        let snapshot;
        if (Array.isArray(data?.devices)) {
          snapshot = {
            ...b, type: 'matterbridge', online: true, error: null,
            lastSyncAt: new Date().toISOString(),
            commissioning: {
              commissioned: data.commissioning?.commissioned === true,
              manualPairingCode: String(data.commissioning?.manualPairingCode ?? '')
            },
            devices: data.devices.map(cleanDevice).filter(Boolean)
          };
        } else if (isStandaloneStatus(data)) {
          const device = await this.request(b.id, '/api/device');
          const version = await this.request(b.id, '/api/version').catch(() => null);
          snapshot = {
            ...b, type: 'standalone', online: true, error: null,
            lastSyncAt: new Date().toISOString(), commissioning: null,
            devices: [standaloneDevice(b, data, device, version)]
          };
        } else {
          throw new Error('Unknown API type. Direct Standalone expects /api/status with state + mac, while MatterBridge expects devices[].');
        }
        this.cache.set(b.id, snapshot);
        return snapshot;
      } catch (error) {
        const last = this.cache.get(b.id);
        return {
          ...b, type: last?.type ?? 'unknown', online: false,
          error: error.message, lastSyncAt: last?.lastSyncAt ?? null,
          commissioning: last?.commissioning ?? null,
          devices: (last?.devices ?? []).map(d => ({ ...d, reachable: false, controlAvailable: false }))
        };
      }
    }));
    return aggregate(sources);
  }

  async sourceForDevice(bridgeId, deviceId) {
    let source = this.cache.get(bridgeId);
    if (!source) {
      await this.status();
      source = this.cache.get(bridgeId);
    }
    if (!source || !source.devices.some(d => d.id === deviceId)) {
      throw new ApiError('Device not registered on this source', 404);
    }
    return source;
  }

  async refreshDevice(bridgeId, deviceId) {
    const source = await this.sourceForDevice(bridgeId, deviceId);
    if (source.type === 'standalone') return this.request(bridgeId, '/api/device');
    return this.request(bridgeId, '/devices/' + encodeURIComponent(deviceId) + '/refresh',
      { method: 'POST', body: {} });
  }

  async removeDevice(bridgeId, deviceId) {
    const source = await this.sourceForDevice(bridgeId, deviceId);
    if (source.type === 'standalone') {
      throw new ApiError('Remove this Standalone strip from the source list instead.');
    }
    return this.request(bridgeId, '/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' });
  }

  async setOutlet(bridgeId, deviceId, index, on) {
    const source = await this.sourceForDevice(bridgeId, deviceId);
    if (source.type !== 'standalone') {
      if (index === 5) throw new ApiError('All-on/off requires direct Standalone firmware', 400);
      return this.request(bridgeId, '/devices/' + encodeURIComponent(deviceId) +
        '/outlets/' + index + '/state', { method: 'POST', body: { on } });
    }
    const device = source.devices.find(d => d.id === deviceId);
    if (!device?.reachable || !device?.controlAvailable) {
      throw new ApiError('Standalone device hardware is not ready for switching', 409);
    }
    const liveIdentity = await this.request(bridgeId, '/api/status');
    if (!isStandaloneStatus(liveIdentity) ||
        liveIdentity.mac.replaceAll(':', '').toUpperCase() !== deviceId.toUpperCase()) {
      throw new ApiError('Device IP now belongs to another device. Update the source before controlling power.', 409);
    }
    const bridge = this.get(bridgeId);
    let response;
    try {
      // Firmware requires Origin matching its device URL and exactly two bytes.
      response = await this.fetcher(bridge.url + '/api/control', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { Origin: bridge.url, 'Content-Type': 'application/octet-stream' },
        body: Uint8Array.of(index - 1, on ? 1 : 0)
      });
    } catch (error) {
      throw new ApiError('Standalone command failed: ' + error.message, 502);
    }
    if (!response.ok) throw new ApiError('Standalone rejected control (HTTP ' + response.status + ')', 502);
    let ack;
    try { ack = await response.json(); }
    catch { throw new ApiError('Invalid Standalone control response', 502); }
    if (ack?.accepted !== true) throw new ApiError('Standalone command not accepted', 502);
    // Accepted is not confirmed. Read the actual relay state; never resend a command.
    for (let attempt = 0; attempt < 16; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      let current;
      try { current = await this.request(bridgeId, '/api/device'); }
      catch { continue; }
      if (index === 5 && current?.channels?.length === 4 &&
        current.channels.every(c => c.on === on)) return { ok: true, confirmed: true };
      if (index !== 5 && current?.channels?.[index - 1]?.on === on) return { ok: true, confirmed: true };
    }
    throw new ApiError('Control accepted but not confirmed; refresh before retrying', 504);
  }
}

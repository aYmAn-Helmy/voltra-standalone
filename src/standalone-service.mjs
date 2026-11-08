import { createHash } from 'node:crypto';
import { ApiError } from './manager.mjs';
import { decodeSchedule, patchConfiguration, serializeConfiguration, configMatches } from './standalone-config.mjs';
import { validateFwr } from './standalone-firmware.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeId = id => encodeURIComponent(id);

export class StandaloneService {
  constructor(manager) {
    this.manager = manager;
    this.inFlight = new Set();
  }

  async checked(bridgeId, deviceId) {
    const source = await this.manager.sourceForDevice(bridgeId, deviceId);
    if (source.type !== 'standalone') throw new ApiError('This feature requires Standalone firmware', 400);
    // DHCP may reassign a saved IP. Verify physical identity immediately before
    // any settings, Wi-Fi or firmware operation so we never modify the wrong strip.
    const liveStatus = await this.manager.request(bridgeId, '/api/status');
    if (typeof liveStatus?.mac !== 'string' ||
        liveStatus.mac.replaceAll(':', '').toUpperCase() !== deviceId.toUpperCase()) {
      throw new ApiError('This IP does not match the saved strip MAC. Recheck the device network.', 409);
    }
    return this.manager.get(bridgeId);
  }

  async info(bridgeId, deviceId) {
    await this.checked(bridgeId, deviceId);
    const c = await this.manager.request(bridgeId, '/api/config');
    const schedule = decodeSchedule(c.schedule_hex);
    const optional = async path => {
      try { return await this.manager.request(bridgeId, path); }
      catch { return null; }
    };
    // The strip's embedded HTTP server has very limited connection capacity.
    // Query in sequence rather than launching five simultaneous requests.
    const status = await optional('/api/status');
    const device = await optional('/api/device');
    const firmware = await optional('/api/firmware/status');
    const memory = await optional('/api/memory');
    const energy = await optional('/api/energy');
    // Firmware doesn't return plaintext Wi-Fi or MQTT password through its config API.
    return { config: c, schedule, status, device, firmware, memory, energy };
  }

  async update(bridgeId, deviceId, patch) {
    const source = await this.checked(bridgeId, deviceId);
    const key = bridgeId + ':' + deviceId;
    if (this.inFlight.has(key)) throw new ApiError('A settings save is already in progress', 409);
    this.inFlight.add(key);
    let body;
    try {
      const state = await this.manager.request(bridgeId, '/api/status');
      if (![2, 5].includes(state?.state)) throw new ApiError('Device is not ready to save settings', 409);
      const current = await this.manager.request(bridgeId, '/api/config');
      const { section, next, password } = patchConfiguration(current, patch);
      body = serializeConfiguration(next, password ?? '');
      let postError = null;
      try {
        const response = await this.manager.fetcher(source.url + '/api/config', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(6000),
          headers: {
            Origin: source.url, 'Content-Type': 'application/octet-stream',
            'X-MTTL-Keep-Password': password === undefined ? '1' : '0'
          },
          body
        });
        if (!response.ok) postError = 'HTTP ' + response.status;
      } catch (error) {
        // Firmware config POST may complete even when its response is lost.
        // Never replay; inspect the persisted configuration below instead.
        postError = error.message;
      }
      for (let i = 0; i < 16; i++) {
        await sleep(350);
        let saved;
        try { saved = await this.manager.request(bridgeId, '/api/config'); }
        catch { continue; }
        if (configMatches(next, saved, section, password !== undefined)) {
          return { ok: true, confirmed: true, config: saved, schedule: decodeSchedule(saved.schedule_hex) };
        }
      }
      throw new ApiError('Save not confirmed. Check device settings before retrying.' +
        (postError ? ' Last POST result: ' + postError : ''), 504);
    } finally {
      if (body) body.fill(0);
      this.inFlight.delete(key);
    }
  }

  async scan(bridgeId, deviceId) {
    const b = await this.checked(bridgeId, deviceId);
    const response = await this.manager.fetcher(b.url + '/api/scan', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { Origin: b.url }
    });
    if (!response.ok) throw new ApiError('Wi-Fi scan was not accepted (HTTP ' + response.status + ')', 502);
    for (let n = 0; n < 12; n++) {
      await sleep(500);
      const data = await this.manager.request(bridgeId, '/api/scan');
      if (data.pending) continue;
      if (data.failed) throw new ApiError('Device Wi-Fi scan failed', 502);
      if (!Array.isArray(data.networks) || data.networks.length > 16) {
        throw new ApiError('Invalid Wi-Fi scan response', 502);
      }
      return { networks: data.networks.map(item => {
        const valid = typeof item.ssid_hex === 'string' &&
          /^(?:[0-9a-f]{2}){1,32}$/i.test(item.ssid_hex);
        return valid ? {
          ssid: new TextDecoder().decode(Buffer.from(item.ssid_hex, 'hex')),
          rssi: Number.isInteger(item.rssi) ? item.rssi : null,
          security: item.security
        } : null;
      }).filter(Boolean) };
    }
    throw new ApiError('Wi-Fi scan still running; please check the device before scanning again', 504);
  }

  async wifi(bridgeId, deviceId, input) {
    const b = await this.checked(bridgeId, deviceId);
    if (!input || input.confirm !== true) throw new ApiError('Wi-Fi connection requires confirmation');
    if (typeof input.ssid !== 'string' || !input.ssid || Buffer.byteLength(input.ssid) > 32 ||
      typeof input.password !== 'string' || Buffer.byteLength(input.password) > 64) {
      throw new ApiError('Invalid Wi-Fi SSID or password');
    }
    const body = new URLSearchParams({ ssid: input.ssid, password: input.password }).toString();
    try {
      const r = await this.manager.fetcher(b.url + '/api/wifi', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        headers: { Origin: b.url, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!r.ok) throw new ApiError('Device declined Wi-Fi configuration (HTTP ' + r.status + ')', 502);
      const data = await r.json();
      if (data.accepted !== true) throw new ApiError('Wi-Fi request was not accepted', 502);
      return { accepted: true, warning: 'Device may disconnect and receive a new IP. Re-add/update its source if needed.' };
    } catch (error) {
      // Do not retry uncertain Wi-Fi writes. The device could be moving networks.
      if (error instanceof ApiError) throw error;
      throw new ApiError('Wi-Fi submission result unknown. Check the device network before retrying.', 504);
    }
  }

  async firmwareUpload(bridgeId, deviceId, binary, hash) {
    const b = await this.checked(bridgeId, deviceId);
    const digest = createHash('sha256').update(binary).digest('hex');
    if (!/^[a-f0-9]{64}$/i.test(hash) || digest !== hash.toLowerCase()) {
      throw new ApiError('The file does not match the expected SHA-256 checksum');
    }
    const details = validateFwr(binary);
    const state = await this.manager.request(bridgeId, '/api/firmware/status');
    if (state.ota_ready !== true) throw new ApiError('Firmware OTA is not supported/ready on this device', 409);
    try {
      const r = await this.manager.fetcher(b.url + '/api/firmware/upload', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
        headers: { Origin: b.url, 'Content-Type': 'application/x-mttl-fwr' },
        body: binary
      });
      if (!r.ok) throw new ApiError('OTA rejected by device: HTTP ' + r.status, 502);
      const data = await r.json();
      if (!data.written && !data.already_installed) throw new ApiError('Unrecognized OTA response', 502);
      return { ...data, checksum: digest, format: details.format };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // NEVER retry an interrupted firmware flash, as the device may be rebooting.
      throw new ApiError('OTA outcome unknown. Do not resend until you verify the installed build on the device.', 504);
    }
  }
}

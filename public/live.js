// Shared Voltra SSE browser client. One EventSource for the whole dashboard.
// Device firmware events are forwarded by the Voltra server (not polled here).
(() => {
  'use strict';

  const states = new Map(), rawStates = new Map(), relays = new Map(), history = new Map();
  let stream = null, callback = () => {}, connection = () => {};
  const key = (bridgeId, deviceId) => bridgeId + ':' + deviceId;
  const scaled = (x, factor) => typeof x === 'number' && Number.isFinite(x) ? x / factor : null;

  function validEnvelope(x) {
    return x && typeof x.bridgeId === 'string' && typeof x.deviceId === 'string' &&
      Number.isFinite(x.at) && x.at > 0;
  }
  function applyRelay(device, relay) {
    if (!relay || !Array.isArray(device?.outlets)) return device;
    device.outlets.forEach((o, i) => {
      const bit = 1 << i;
      o.on = relay.known & bit ? !!(relay.on & bit) : null;
    });
    if (relay.fault) device.controlAvailable = false;
    return device;
  }
  function applyDevice(device, raw, at) {
    if (!raw || !Array.isArray(raw.channels) || raw.channels.length !== 4) return false;
    const channels = raw.channels;
    if (channels.some(c => !c || typeof c !== 'object')) return false;
    device.name = typeof raw.name === 'string' && raw.name ? raw.name : device.name;
    device.powerW = scaled(raw.power_mw, 1000);
    device.energyWh = scaled(raw.meter_wh, 1);
    device.voltageV = scaled(raw.voltage_dv, 10);
    device.currentA = scaled(raw.current_ma, 1000);
    device.mqttState = raw.mqtt_state;
    device.hardwareReady = raw.hardware_ready === true;
    device.controlAvailable = device.reachable && device.hardwareReady;
    device.protection = raw.protection ?? device.protection;
    device.timerRunning = raw.timer_running ?? device.timerRunning;
    device.timerEnd = Array.isArray(raw.timer_end) ? raw.timer_end : device.timerEnd;
    channels.forEach((c, i) => {
      if (!device.outlets[i]) return;
      const outlet = device.outlets[i];
      if (typeof c.name === 'string' && c.name) outlet.name = c.name;
      outlet.on = typeof c.on === 'boolean' ? c.on : null;
      outlet.powerW = scaled(c.power_mw, 1000);
      outlet.energyWh = scaled(c.meter_wh, 1);
      outlet.temperatureC = scaled(c.temp_dc, 10);
      outlet.currentA = scaled(c.current_ma, 1000);
      outlet.locked = c.locked === true;
    });
    const latestRelay = relays.get(key(device.bridgeId, device.id));
    if (latestRelay && Date.now() - latestRelay.at < 25000 && latestRelay.at >= at)
      applyRelay(device, latestRelay.snapshot);
    device.liveAt = at;
    return true;
  }
  function receive(type, envelope, devices) {
    if (!validEnvelope(envelope)) return false;
    const d = devices.find(d => d.sourceType === 'standalone' &&
      d.bridgeId === envelope.bridgeId && d.id === envelope.deviceId);
    if (!d) return false;
    const id = key(d.bridgeId, d.id);
    if (type === 'relay') {
      const r = envelope.snapshot;
      if (!r || ![r.known, r.on, r.fault].every(Number.isInteger) ||
        r.known < 0 || r.known > 15 || r.on < 0 || r.on > 15) return false;
      relays.set(id, envelope);
      applyRelay(d, r);
    } else if (type === 'device') {
      if (!applyDevice(d, envelope.snapshot, envelope.at)) return false;
      rawStates.set(id, envelope);
      const watts = d.outlets.reduce((sum, o) => sum + (o.powerW ?? 0), 0);
      const samples = history.get(id) || [];
      if (!samples.length || envelope.at - samples[samples.length - 1].at >= 1000) {
        samples.push({ at: envelope.at, powerW: watts });
        if (samples.length > 60) samples.shift();
        history.set(id, samples);
      }
    } else return false;
    d.streamConnected = true;
    d.liveAt = envelope.at;
    return true;
  }
  // An HTTP status poll may finish after an SSE packet. For the following
  // 25 seconds, prefer newer SSE data over the poll response to avoid regressions.
  function hydrate(data) {
    for (const d of data.devices) {
      if (d.sourceType !== 'standalone') continue;
      const id = key(d.bridgeId, d.id);
      const raw = rawStates.get(id), relay = relays.get(id);
      if (d.reachable && raw && Date.now() - raw.at < 25000) {
        applyDevice(d, raw.snapshot, raw.at);
        if (relay && Date.now() - relay.at < 25000 && relay.at >= raw.at) {
          applyRelay(d, relay.snapshot);
        }
      }
      const state = states.get(id);
      d.streamConnected = state?.connected === true;
      d.liveAt = Math.max(raw?.at || 0, relay?.at || 0);
    }
  }

  function setSource(x) {
    if (!validEnvelope(x)) return;
    const id = key(x.bridgeId, x.deviceId);
    const state = { connected: x.connected === true, at: x.at };
    states.set(id, state);
    connection(x);
  }
  function start(onUpdate, onConnection) {
    callback = onUpdate;
    connection = onConnection || (() => {});
    if (stream || !window.EventSource) return;
    stream = new EventSource('/api/live/events');
    stream.addEventListener('source', evt => {
      try { setSource(JSON.parse(evt.data)); } catch {}
    });
    for (const eventName of ['device', 'relay']) {
      stream.addEventListener(eventName, evt => {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }
        if (!validEnvelope(data)) return;
        callback(eventName, data);
      });
    }
    stream.onerror = () => {
      for (const [id, state] of states) {
        if (state.connected) {
          states.set(id, { connected: false, at: Date.now() });
          const split = id.indexOf(':');
          connection({ bridgeId: id.slice(0, split), deviceId: id.slice(split + 1),
            connected: false, at: Date.now() });
        }
      }
    };
  }
  function stop() {
    if (stream) stream.close();
    stream = null;
    for (const [id] of states) {
      const split = id.indexOf(':');
      connection({ bridgeId: id.slice(0, split), deviceId: id.slice(split + 1),
        connected: false, at: Date.now() });
    }
    states.clear();
  }
  function invalidate(bridgeId, deviceId) {
    const id = key(bridgeId, deviceId);
    rawStates.delete(id);
    relays.delete(id);
  }
  function invalidateCommand(path) {
    const m = path.match(/^\/api\/bridges\/([^/]+)\/devices\/([^/]+)\//);
    if (!m) return;
    try { invalidate(decodeURIComponent(m[1]), decodeURIComponent(m[2])); } catch {}
  }
  function samples(bridgeId, deviceId) {
    return (history.get(key(bridgeId, deviceId)) || []).slice();
  }
  function liveCount() { return [...states.values()].filter(x => x.connected).length; }
  globalThis.VoltraLive = { start, stop, receive, hydrate, liveCount, invalidate,
    invalidateCommand, samples, states };
})();

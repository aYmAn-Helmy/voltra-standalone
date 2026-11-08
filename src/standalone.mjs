// Direct HTTP adapter for MTTL-W01 standalone firmware (af950833/mttl_w01_standalone).
const scaled = (v, factor) => typeof v === 'number' && Number.isFinite(v) ? v / factor : null;

export function isStandaloneStatus(data) {
  return !!data && Number.isInteger(data.state) && typeof data.mac === 'string' &&
    /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(data.mac);
}

export function standaloneDevice(source, status, device, version) {
  if (!Array.isArray(device?.channels) || device.channels.length !== 4)
    throw new Error('Invalid /api/device response: expected four channels');
  return {
    id: status.mac.replaceAll(':', '').toUpperCase(),
    name: device.name || source.name,
    sourceType: 'standalone',
    firmwareVersion: version?.version || 'Standalone',
    reachable: status.state === 5,
    controlAvailable: status.state === 5 && status.hardware_ready === true && device.hardware_ready === true,
    voltageV: scaled(device.voltage_dv, 10),
    currentA: scaled(device.current_ma, 1000),
    rssi: Number.isInteger(status.rssi) ? status.rssi : null,
    protection: device.protection ?? null,
    outlets: device.channels.map((o, index) => ({
      index: index + 1, name: o.name || 'Outlet ' + (index + 1),
      on: typeof o.on === 'boolean' ? o.on : null,
      powerW: scaled(o.power_mw, 1000),
      energyWh: scaled(o.meter_wh, 1),
      temperatureC: scaled(o.temp_dc, 10),
      currentA: scaled(o.current_ma, 1000),
      locked: o.locked === true
    }))
  };
}

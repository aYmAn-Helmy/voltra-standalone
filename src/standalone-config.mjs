// Standalone firmware v2.1.x settings codec.
// Source contract: af950833/mttl_w01_standalone
// source/standalone/ui/live.js, scheduler.js and timer.js.
import { ApiError } from './manager.mjs';

const fail = message => { throw new ApiError(message, 400); };
const intRange = (v, a, b, label) => {
  if (!Number.isInteger(v) || v < a || v > b) fail('Invalid ' + label);
  return v;
};
const utf8 = new TextEncoder();
const stringField = (v, max, label, nonempty = false) => {
  if (typeof v !== 'string' || utf8.encode(v).length > max ||
      (nonempty && !v.trim()) || /[\x00-\x1f\x7f]/.test(v)) fail('Invalid ' + label);
  return v;
};
const emptyRule = () => ({ minute: 0, mode: 0, day: 0, channel: 0, on: 0 });
export const defaultSchedule = () => ({ timezone: 120, rules: Array.from({ length: 8 }, emptyRule) });

export function validateSchedule(schedule) {
  if (!schedule || !Array.isArray(schedule.rules) || schedule.rules.length !== 8)
    fail('Schedule must contain exactly 8 rules');
  intRange(schedule.timezone, -720, 840, 'schedule timezone');
  if (schedule.timezone % 15) fail('Schedule timezone must be a multiple of 15 minutes');
  for (const r of schedule.rules) {
    if (!r) fail('Invalid schedule rule');
    const minute = intRange(r.minute, 0, 1439, 'rule minute');
    const mode = intRange(r.mode, 0, 255, 'rule mode');
    const day = intRange(r.day, 0, 127, 'rule day');
    const channel = intRange(r.channel, 0, 4, 'rule channel');
    const on = intRange(r.on, 0, 1, 'rule action');
    const kind = mode & 127;
    if (kind > 4 || (!kind && (mode || minute || day || channel || on)) ||
      (kind === 2 && !day) || (kind === 3 && (day < 1 || day > 31)) ||
      ([1, 4].includes(kind) && day)) fail('Invalid schedule repetition');
  }
  return schedule;
}

export function decodeSchedule(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{100}$/i.test(hex)) fail('Invalid schedule_hex');
  const b = Buffer.from(hex, 'hex');
  const schedule = { timezone: b.readInt16LE(0), rules: [] };
  for (let i = 0; i < 8; i++) {
    const p = 2 + i * 6;
    schedule.rules.push({
      minute: b.readUInt16LE(p), mode: b[p + 2], day: b[p + 3],
      channel: b[p + 4], on: b[p + 5]
    });
  }
  return validateSchedule(schedule);
}

export function encodeSchedule(schedule) {
  validateSchedule(schedule);
  const b = Buffer.alloc(50);
  b.writeInt16LE(schedule.timezone, 0);
  schedule.rules.forEach((r, i) => {
    const p = 2 + i * 6;
    b.writeUInt16LE(r.minute, p);
    b[p + 2] = r.mode; b[p + 3] = r.day;
    b[p + 4] = r.channel; b[p + 5] = r.on;
  });
  return b.toString('hex');
}

export function validateTimers(minutes, scheduleHex) {
  if (!Array.isArray(minutes) || minutes.length !== 4) fail('Must provide 4 timers');
  minutes.forEach((m, i) => intRange(m, 0, 1440, 'timer ' + (i + 1)));
  const schedule = decodeSchedule(scheduleHex);
  if (schedule.rules.some(r =>
    (r.mode & 127) !== 0 && minutes.some((m, i) => m > 0 && (r.channel === 4 || r.channel === i)))) {
    fail('Timer conflicts with a scheduled channel. Remove its schedule first.');
  }
}

export function patchConfiguration(current, input) {
  if (!current || !Array.isArray(current.channels) || current.channels.length !== 4)
    fail('Invalid firmware configuration');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid settings payload');
  const section = input.section;
  if (typeof section !== 'string') fail('Missing section');
  // No generic object spread of client input: each section has an explicit allowlist.
  const next = structuredClone(current);
  let password;
  switch (section) {
    case 'names':
      next.device = stringField(input.device, 64, 'device name', true).trim();
      if (!Array.isArray(input.channels) || input.channels.length !== 4)
        fail('Must provide 4 channel names');
      next.channels = input.channels.map((s, i) => stringField(s, 64, 'channel ' + (i + 1), true).trim());
      break;
    case 'locks':
      next.button_lock = intRange(input.button_lock, 0, 15, 'button lock mask');
      break;
    case 'timers':
      next.timer_minutes = input.timer_minutes;
      break;
    case 'schedule':
      next.schedule_hex = encodeSchedule(input.schedule);
      break;
    case 'protection':
      if (!input.protection || typeof input.protection !== 'object') fail('Invalid protection');
      next.protection = {
        enabled: intRange(input.protection.enabled, 0, 7, 'protection mask'),
        temperature: intRange(input.protection.temperature, 50, 90, 'temperature threshold'),
        current: intRange(input.protection.current, 1000, 16000, 'current threshold in mA'),
        power: intRange(input.protection.power, 100, 3000, 'power threshold')
      };
      break;
    case 'mqtt':
      next.broker = stringField(input.broker, 253, 'MQTT broker');
      next.user = stringField(input.user, 64, 'MQTT user');
      next.topic = stringField(input.topic, 64, 'MQTT topic');
      next.port = intRange(input.port, 1, 65535, 'MQTT port');
      if (typeof input.enabled !== 'boolean') fail('MQTT enabled must be boolean');
      next.enabled = input.enabled;
      if (input.password !== undefined && input.password !== '') {
        password = stringField(input.password, 64, 'MQTT password');
      }
      break;
    case 'language':
      next.language = intRange(input.language, 0, 1, 'language');
      break;
    default:
      fail('Unsupported settings section');
  }
  validateTimers(next.timer_minutes, next.schedule_hex);
  return { section, next, password };
}

export function serializeConfiguration(c, password = '') {
  const values = [c.device, ...c.channels, '', '', c.broker, c.user, password, c.topic];
  const caps = [64, 64, 64, 64, 64, 32, 64, 253, 64, 64, 64];
  if (values.length !== 11) fail('Invalid configuration field count');
  const port = intRange(c.port, 1, 65535, 'port');
  const language = intRange(c.language, 0, 1, 'language');
  const fields = values.map((v, i) => {
    stringField(v, caps[i], 'field ' + i, i < 5);
    const bytes = utf8.encode(v);
    return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
  });
  const protection = c.protection;
  if (!protection) fail('Missing protection');
  const p = Buffer.alloc(7);
  p[0] = intRange(protection.enabled, 0, 7, 'protection enabled');
  p.writeUInt16LE(intRange(protection.temperature, 50, 90, 'temperature'), 1);
  p.writeUInt16LE(intRange(protection.current, 1000, 16000, 'current'), 3);
  p.writeUInt16LE(intRange(protection.power, 100, 3000, 'power'), 5);
  const schedule = Buffer.from(encodeSchedule(decodeSchedule(c.schedule_hex)), 'hex');
  const locks = intRange(c.button_lock, 0, 15, 'button lock');
  validateTimers(c.timer_minutes, c.schedule_hex);
  const tail = Buffer.alloc(9);
  tail[0] = locks;
  c.timer_minutes.forEach((minutes, i) => tail.writeUInt16LE(minutes, 1 + i * 2));
  const head = Buffer.from([7, language, c.enabled ? 1 : 0, port & 255, port >>> 8]);
  const output = Buffer.concat([head, ...fields, p, schedule, tail]);
  if (output.length > 1024) fail('Firmware config body exceeds 1024 bytes');
  return output;
}

export function configMatches(a, b, section, passwordChanged) {
  if (!b?.persistent) return false;
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (section === 'names') return a.device === b.device && eq(a.channels, b.channels);
  if (section === 'locks') return a.button_lock === b.button_lock;
  if (section === 'timers') return eq(a.timer_minutes, b.timer_minutes);
  if (section === 'schedule') return a.schedule_hex === b.schedule_hex;
  if (section === 'protection') return eq(a.protection, b.protection);
  if (section === 'language') return a.language === b.language;
  if (section === 'mqtt') return a.broker === b.broker && a.port === b.port &&
    a.user === b.user && a.topic === b.topic && a.enabled === b.enabled &&
    (!passwordChanged || b.mqtt_password_set === true);
  return false;
}

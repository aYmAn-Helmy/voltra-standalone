import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSchedule, decodeSchedule, defaultSchedule, validateTimers,
  patchConfiguration, serializeConfiguration, configMatches
} from '../src/standalone-config.mjs';
import { validateFwr } from '../src/standalone-firmware.mjs';
import { createHash } from 'node:crypto';

const config = () => ({
  device: 'Living Room', channels: ['Socket 1', 'Socket 2', 'Socket 3', 'Socket 4'],
  language: 1, enabled: false, port: 1883, broker: '192.168.0.10',
  user: 'homeassistant', topic: 'mttl', button_lock: 0,
  protection: { enabled: 7, temperature: 90, current: 16000, power: 3000 },
  timer_minutes: [0, 0, 0, 0],
  schedule_hex: encodeSchedule(defaultSchedule()), persistent: true
});

test('schedule 50-byte codec matches upstream layout and roundtrips 8 rules', () => {
  const schedule = defaultSchedule();
  schedule.timezone = 120;
  schedule.rules[0] = { minute: 10 * 60 + 15, mode: 129, day: 0, channel: 4, on: 1 };
  schedule.rules[1] = { minute: 19 * 60, mode: 130, day: 31, channel: 2, on: 0 };
  schedule.rules[2] = { minute: 9 * 60, mode: 131, day: 28, channel: 0, on: 1 };
  const hex = encodeSchedule(schedule);
  assert.equal(hex.length, 100);
  assert.equal(hex.slice(0, 4), '7800');
  assert.equal(hex.slice(4, 16), '670281000401');
  assert.deepEqual(decodeSchedule(hex), schedule);
});

test('timer ranges and schedule conflicts are enforced', () => {
  const schedule = defaultSchedule();
  schedule.rules[0] = { minute: 600, mode: 129, day: 0, channel: 1, on: 1 };
  const hex = encodeSchedule(schedule);
  assert.throws(() => validateTimers([0, 10, 0, 0], hex), /conflict/i);
  assert.doesNotThrow(() => validateTimers([5, 0, 0, 0], hex));
  assert.throws(() => validateTimers([0, 1441, 0, 0], hex), /Invalid/i);
  assert.throws(() => encodeSchedule({ timezone: 122, rules: defaultSchedule().rules }), /timezone/i);
});

test('all seven config sections encode exact version 7 binary format', () => {
  const c = config();
  const names = patchConfiguration(c, {
    section: 'names', device: 'كهرباء', channels: ['الأول', 'الثاني', 'الثالث', 'الرابع']
  }).next;
  assert.equal(names.device, 'كهرباء');
  const body = serializeConfiguration(names);
  assert.equal(body[0], 7);
  assert.equal(body[1], 1);
  assert.equal(body[2], 0);
  assert.equal(body.readUInt16LE(3), 1883);
  assert.equal(body[5], Buffer.byteLength('كهرباء'));
  assert.equal(body.subarray(-9)[0], 0);
  assert.equal(body.subarray(-8).readUInt16LE(0), 0);
  assert.equal(c.device, 'Living Room');
  assert.equal(patchConfiguration(c, { section: 'locks', button_lock: 15 }).next.button_lock, 15);
  assert.equal(patchConfiguration(c, { section: 'timers', timer_minutes: [10, 0, 0, 60] }).next.timer_minutes[3], 60);
  assert.equal(patchConfiguration(c, { section: 'language', language: 0 }).next.language, 0);
  assert.equal(patchConfiguration(c, { section: 'protection', protection: {
    enabled: 3, temperature: 80, current: 10000, power: 2000
  } }).next.protection.current, 10000);
  assert.equal(patchConfiguration(c, { section: 'schedule', schedule: defaultSchedule() }).next.schedule_hex.length, 100);
  const mqtt = patchConfiguration(c, {
    section: 'mqtt', enabled: true, port: 1883, broker: '192.168.0.11',
    user: 'u', topic: 'mttl', password: 'secret'
  });
  assert.equal(mqtt.password, 'secret');
  assert.equal(mqtt.next.broker, '192.168.0.11');
  assert.doesNotThrow(() => serializeConfiguration(mqtt.next, mqtt.password));
  assert.equal(patchConfiguration(c, {
    section: 'mqtt', enabled: true, port: 1883, broker: '192.168.0.11',
    user: 'u', topic: 'mttl', password: ''
  }).password, undefined);
});

test('invalid settings fail closed without merging unknown client properties', () => {
  const c = config();
  assert.throws(() => patchConfiguration(c, { section: 'totally_fake', admin: true }));
  assert.throws(() => patchConfiguration(c, { section: 'names', device: 'ok', channels: ['a', 'b'] }));
  assert.throws(() => patchConfiguration(c, {
    section: 'names', device: 'ok', channels: Array.from({ length: 4 }, () => '😀'.repeat(17))
  }));
  assert.throws(() => patchConfiguration(c, { section: 'locks', button_lock: 16 }));
  assert.throws(() => patchConfiguration(c, { section: 'timers', timer_minutes: [0, 0, 0, 1441] }));
  assert.throws(() => patchConfiguration(c, { section: 'protection',
    protection: { enabled: 7, temperature: 100, current: 10000, power: 1000 } }));
  assert.throws(() => patchConfiguration(c, { section: 'mqtt', enabled: true, port: 0,
    broker: 'x', user: '', topic: '', password: '' }));
  assert.equal(configMatches(c, { ...c, device: 'other' }, 'names', false), false);
  assert.equal(configMatches(c, { ...c, persistent: false }, 'names', false), false);
  assert.equal(configMatches(c, c, 'names', false), true);
});

test('FWR parser accepts valid firmware XOR wrapper and rejects wrong images', () => {
  const size = 128;
  const clear = Buffer.alloc(size);
  clear.writeUInt32LE(size - 20, 0);
  clear.writeUInt32LE(0x10006000, 4);
  clear.fill(255, 8, 16);
  clear.writeUInt32LE(0x10006019, 16);
  Buffer.from([0x52,0x54,0x4b,0x57,0x69,0x6e,0,0xff,0,1,1,0,0x95,0x81,1,1,0,0,0,0]).copy(clear, 20);
  let sum = 0;
  for (let i = 0; i < size - 4; i++) sum = (sum + clear[i]) >>> 0;
  clear.writeUInt32LE(sum, size - 4);
  const secret = Buffer.from(clear);
  const key = [0x3f,0x5a,0x27,0xe8,0xd8,0xfb,0x85,0xf9,0xbd,0x4d,0x51,0x19,0x6c,0x4f,0x51,0x59];
  for (let i = 16; i < secret.length; i++) secret[i] ^= key[i % 16];
  const checksum = createHash('sha256').update(secret).digest('hex');
  assert.equal(checksum.length, 64);
  assert.equal(validateFwr(secret).format, 'LG U+ FWR (XOR)');
  assert.throws(() => validateFwr(clear), /Invalid/);
  secret[70] ^= 1;
  assert.throws(() => validateFwr(secret), /checksum/i);
});

// Validates FWR file structure before forwarding to the strip.
// Derived from MIT-licensed af950833/mttl_w01_standalone
// source/standalone/ui/firmware.js. Firmware itself repeats flash/slot validation.
import { ApiError } from './manager.mjs';

const LOAD = 0x10006000;
const RAM_SPAN = 0x10070000 - LOAD;
export const FWR_CAP = 0x70000;
const key = Uint8Array.from([0x3f,0x5a,0x27,0xe8,0xd8,0xfb,0x85,0xf9,0xbd,0x4d,0x51,0x19,0x6c,0x4f,0x51,0x59]);
const tail = Uint8Array.from([0x52,0x54,0x4b,0x57,0x69,0x6e,0,0xff,0,1,1,0,0x95,0x81,1,1,0,0,0,0]);

export function validateFwr(data) {
  if (!Buffer.isBuffer(data) || data.length < 44 || data.length > FWR_CAP) {
    throw new ApiError('FWR must be 44 bytes to 448 KiB', 400);
  }
  // This is the firmware's FWR XOR representation; raw BIN images are deliberately rejected.
  const b = Buffer.from(data);
  for (let i = 16; i < b.length; i++) b[i] ^= key[i % 16];
  const body = b.readUInt32LE(0), load = b.readUInt32LE(4);
  if (load !== LOAD || body < 24 || body > RAM_SPAN || body + 20 !== b.length ||
    b.subarray(8, 16).some(x => x !== 255)) throw new ApiError('Invalid FWR image header');
  const entry = b.readUInt32LE(16);
  if (!(entry & 1) || (entry & ~1) < LOAD + 24 || (entry & ~1) >= LOAD + body) {
    throw new ApiError('Invalid FWR entry point');
  }
  if (tail.some((byte, i) => b[20 + i] !== byte)) {
    throw new ApiError('Invalid FWR startup table');
  }
  let checksum = 0;
  for (let i = 0; i < b.length - 4; i++) checksum = (checksum + b[i]) >>> 0;
  if (checksum !== b.readUInt32LE(b.length - 4)) {
    throw new ApiError('FWR checksum mismatch');
  }
  return { format: 'LG U+ FWR (XOR)', bytes: b.length, entry };
}

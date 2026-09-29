/**
 * Generates the toolbar/extension icons (PNG) without dependencies:
 * `node scripts/icons.ts` → `icons/icon-{16,32,48,128}.png` (blue clock) and
 * `icons/icon-on-{16,32,48,128}.png` (green clock, shown while a work day is
 * open, next to the "ON" badge). The PNGs are committed; run this again only
 * to change the design.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT } from '../build/common.ts';

type RGB = [number, number, number];

const SIZES = [16, 32, 48, 128] as const;
const VARIANTS: { prefix: string; color: RGB }[] = [
  { prefix: 'icon', color: [37, 99, 235] }, // #2563eb
  { prefix: 'icon-on', color: [22, 163, 74] }, // #16a34a
];
const WHITE: RGB = [255, 255, 255];

// ---------- PNG encoder (RGBA 8-bit) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

// ---------- drawing (supersampled shapes in [-1, 1] coordinates) ----------

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Color at a point, or null (transparent). Small sizes get thicker strokes. */
function shade(x: number, y: number, size: number, color: RGB): RGB | null {
  const r = Math.hypot(x, y);
  if (r > 0.96) return null;
  const small = size <= 16;
  const face = small ? 0.62 : 0.7;
  if (r > face) return color; // colored rim
  const hand = small ? 0.17 : 0.11;
  const hour = distToSegment(x, y, 0, 0, 0, small ? -0.4 : -0.44) <= hand;
  const minute = distToSegment(x, y, 0, 0, small ? 0.38 : 0.46, 0) <= hand;
  if (hour || minute) return color;
  return WHITE;
}

function render(size: number, color: RGB): Uint8Array {
  const SS = 4;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = shade(x, y, size, color);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

const dir = join(ROOT, 'icons');
mkdirSync(dir, { recursive: true });
for (const v of VARIANTS) {
  for (const size of SIZES) {
    const file = join(dir, `${v.prefix}-${size}.png`);
    writeFileSync(file, encodePng(size, render(size, v.color)));
    console.log(file);
  }
}

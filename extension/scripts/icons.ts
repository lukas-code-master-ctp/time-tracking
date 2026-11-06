/**
 * Generates the toolbar/extension icons (PNG) without dependencies:
 * `node scripts/icons.ts` → `icons/icon-{16,32,48,128}.png` (Mi Pega HR logo:
 * a yellow sticky note with an ink "p") and `icons/icon-on-{16,32,48,128}.png`
 * (green note, shown while a work day is open, next to the "ON" badge). The
 * shape follows `portal/public/favicon.svg` (64×64 viewBox). The PNGs are
 * committed; run this again only to change the design.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT } from '../build/common.ts';

type RGB = [number, number, number];

const SIZES = [16, 32, 48, 128] as const;
interface Variant {
  prefix: string;
  note: RGB;
  fold: RGB;
}
const VARIANTS: Variant[] = [
  { prefix: 'icon', note: [255, 201, 60], fold: [230, 169, 31] }, // #ffc93c / #e6a91f
  { prefix: 'icon-on', note: [52, 196, 106], fold: [35, 145, 80] }, // #34c46a / #239150
];
const INK: RGB = [38, 51, 107]; // #26336b

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

const TILT = (6 * Math.PI) / 180; // the note is rotated -6° in the SVG

/**
 * Color at a point, or null (transparent). (x, y) are in [-1, 1]; they are
 * mapped to the SVG's 64×64 space and un-rotated before testing the shapes.
 * Small sizes get a thicker "p" so it stays legible at 16 px.
 */
function shade(x: number, y: number, size: number, v: Variant): RGB | null {
  const dx = x * 34;
  const dy = y * 34;
  const u = 32 + dx * Math.cos(TILT) - dy * Math.sin(TILT);
  const w = 32 + dx * Math.sin(TILT) + dy * Math.cos(TILT);
  if (u < 10 || u > 54 || w < 8 || w > 56 || u + w > 96) return null;
  const half = size <= 16 ? 3.6 : size <= 32 ? 3.1 : 2.75;
  const stem = distToSegment(u, w, 24, 22, 24, 46);
  const top = distToSegment(u, w, 24, 22, 31.5, 22);
  const bottom = distToSegment(u, w, 24, 37, 31.5, 37);
  const bowl = u >= 31.5 ? Math.abs(Math.hypot(u - 31.5, w - 29.5) - 7.5) : Infinity;
  if (Math.min(stem, top, bottom, bowl) <= half) return INK;
  if (u >= 40 && w >= 42) return v.fold;
  return v.note;
}

function render(size: number, v: Variant): Uint8Array {
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
          const c = shade(x, y, size, v);
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
    writeFileSync(file, encodePng(size, render(size, v)));
    console.log(file);
  }
}

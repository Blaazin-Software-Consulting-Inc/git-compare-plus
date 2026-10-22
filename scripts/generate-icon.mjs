/**
 * Draws media/icon.png (the Marketplace icon, 256×256) from simple shapes, with no image tools:
 * each pixel's colour is the coverage of every shape over a 4×4 grid of samples (anti-aliasing),
 * composited in order, then written as a PNG with Node's zlib.
 *
 * Why code instead of an exported SVG: the build has no SVG renderer, and a script keeps the icon
 * reproducible and reviewable. media/icon.svg is the same design for editing and previews; change
 * both together. Run with `npm run generate:icon`.
 *
 * Design: a dark rounded square; a trunk and a branch (git); a green "+"; and the green/red diff
 * bar shown on every changed file in the extension.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SAMPLES = 4;
const BG = [0x1f, 0x23, 0x28];
const FG = [0xe6, 0xed, 0xf3];
const GREEN = [0x3f, 0xb9, 0x50];
const RED = [0xf8, 0x51, 0x49];

// Signed distance helpers (negative = inside).
const roundRect = (x, y, w, h, r) => (px, py) => {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const disc = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) - r;
const segment = (ax, ay, bx, by, width) => (px, py) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - width / 2;
};
// A cubic Bézier stroke as a union of short segments.
const curve = (p0, p1, p2, p3, width, steps = 48) => {
  const at = (t) => {
    const u = 1 - t;
    return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
  };
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const [ax, ay] = at(i / steps);
    const [bx, by] = at((i + 1) / steps);
    parts.push(segment(ax, ay, bx, by, width));
  }
  return (px, py) => Math.min(...parts.map((part) => part(px, py)));
};

// Layers in drawing order: [shape, colour]. Rings are a filled disc with a background disc on top.
const ring = (cx, cy) => [
  [disc(cx, cy, 24), FG],
  [disc(cx, cy, 12), BG],
];
const layers = [
  [roundRect(0, 0, SIZE, SIZE, 48), BG],
  [segment(72, 58, 72, 198, 14), FG],
  [curve([72, 158], [72, 114], [144, 118], [144, 78], 14), FG],
  ...ring(72, 58),
  ...ring(72, 198),
  ...ring(144, 70),
  [segment(196, 52, 196, 96, 14), GREEN],
  [segment(174, 74, 218, 74, 14), GREEN],
  ...[0, 1, 2].map((i) => [roundRect(112 + i * 26, 174, 20, 28, 4), GREEN]),
  ...[3, 4].map((i) => [roundRect(112 + i * 26, 174, 20, 28, 4), RED]),
];

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    let [r, g, b, a] = [0, 0, 0, 0];
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        // Topmost layer covering this sample wins.
        let colour;
        for (const [shape, c] of layers) {
          if (shape(px, py) <= 0) {
            colour = c;
          }
        }
        if (colour !== undefined) {
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
    }
    const n = SAMPLES * SAMPLES;
    const covered = a / 255;
    // Straight (non-premultiplied) alpha: average colour of the covered samples.
    row.set(covered === 0 ? [0, 0, 0, 0] : [r / covered, g / covered, b / covered, a / n].map(Math.round), 1 + x * 4);
  }
  rows.push(row);
}

// PNG: signature, IHDR (RGBA 8-bit), IDAT (zlib of filter-0 rows), IEND.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png'), png);

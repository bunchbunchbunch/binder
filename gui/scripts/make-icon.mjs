#!/usr/bin/env node
// Draws the app icon (the TUI's pixel binder: a blue body with gold, green and
// purple index tabs and two ring holes) on a dark rounded square, writes
// build/icon.png at 1024px, then build/icon.icns with sips and iconutil.
//
//   node scripts/make-icon.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const LOGO = ['.YY.GG.PP', 'CCCCCCCCC', 'CCCCCCCCC', 'C.CCCCC.C', 'CCCCCCCCC', 'CCCCCCCCC'];
const COLORS = { C: [124, 196, 255], Y: [232, 192, 125], G: [152, 195, 121], P: [201, 160, 255] };

const S = 1024;
const px = new Uint8Array(S * S * 4);

// macOS icon grid: an 824px rounded square centered in the canvas.
const BOX = 824;
const R = 185;
const off = (S - BOX) / 2;
function inBox(x, y) {
  const lx = x - off;
  const ly = y - off;
  if (lx < 0 || ly < 0 || lx >= BOX || ly >= BOX) return false;
  const cx = Math.min(Math.max(lx, R), BOX - R);
  const cy = Math.min(Math.max(ly, R), BOX - R);
  return (lx - cx) ** 2 + (ly - cy) ** 2 <= R * R;
}

const CELL = 72;
const GAP = 8;
const logoW = LOGO[0].length * CELL;
const logoH = LOGO.length * CELL;
const lx0 = (S - logoW) / 2;
const ly0 = (S - logoH) / 2 + 10;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inBox(x, y)) continue;
    // A dark slate background, a little lighter at the top.
    const t = (y - off) / BOX;
    let rgb = [Math.round(44 - 18 * t), Math.round(47 - 18 * t), Math.round(56 - 20 * t)];
    const col = Math.floor((x - lx0) / CELL);
    const row = Math.floor((y - ly0) / CELL);
    const inCell = (x - lx0) % CELL < CELL - GAP && (y - ly0) % CELL < CELL - GAP;
    if (x >= lx0 && y >= ly0 && row < LOGO.length && col < LOGO[0].length && inCell) {
      const c = COLORS[LOGO[row][col]];
      if (c) rgb = c;
    }
    px.set([...rgb, 255], i);
  }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(S, 0);
header.writeUInt32BE(S, 4);
header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

const out = join(import.meta.dirname, '..', 'build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.png'), png);

const set = join(out, 'icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), join(out, 'icon.png'), '--out', join(set, name)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(out, 'icon.icns')]);
rmSync(set, { recursive: true });
console.log('wrote build/icon.png and build/icon.icns');

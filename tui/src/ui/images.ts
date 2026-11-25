import { styled } from './md/theme.js';
import { width as strWidth } from './md/text.js';

// Images in the transcript: a tool's result (a screenshot, a Read of a PNG)
// and the images sent with a prompt. iTerm2 draws an image in the rows
// binder leaves for it (OSC 1337); elsewhere, or with config.json showImages
// false, an image is a one-line caption. A placeholder row carries an
// invisible marker naming the image, so the frame stamper (lineAttrs.ts) can
// find where it landed on screen and draw it there once the rows settle.

export type ImageData = { mediaType: string; data: string };

export let inlineImages = process.env.TERM_PROGRAM === 'iTerm.app';
let showImages = true;

export function setInlineImages(on: boolean): void {
  inlineImages = on;
}

export function setShowImages(on: boolean): void {
  showImages = on;
}

/** Part of a cached rendering's key: whether images are drawn. */
export const imagesKey = (): string => (showImages && inlineImages ? 'img' : '');

/** Width and height in pixels from a PNG, GIF, JPEG or WebP header; null when unknown. */
export function imageSize(data: string): { width: number; height: number } | null {
  const b = Buffer.from(data.slice(0, 87384), 'base64');
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        // Start of frame (baseline, progressive, ...), not DHT (C4), JPG (C8) or DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    // a truncated header
  }
  return null;
}

const kb = (data: string) => {
  const bytes = Math.floor((data.length * 3) / 4);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** "PNG image, 800×600, 45 KB". */
export function imageCaption(img: ImageData): string {
  const kind = (img.mediaType.split('/')[1] ?? 'image').toUpperCase();
  const size = imageSize(img.data);
  return `${kind} image${size ? `, ${size.width}×${size.height}` : ''}, ${kb(img.data)}`;
}

const MAX_COLS = 60;
const MAX_ROWS = 16;

// A terminal cell is about twice as tall as it is wide.
function cells(size: { width: number; height: number }, maxCols: number): { cols: number; rows: number } {
  let cols = Math.max(1, Math.min(maxCols, MAX_COLS, Math.ceil(size.width / 8)));
  let rows = Math.max(1, Math.round((cols * size.height) / size.width / 2));
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS;
    cols = Math.max(1, Math.min(cols, Math.round((rows * 2 * size.width) / size.height)));
  }
  return { cols, rows };
}

// Images on screen, by id; ids are kept per image object (store blocks never change in place).
type Placed = { img: ImageData; cols: number; rows: number };
const ids = new WeakMap<ImageData, number>();
const placed = new Map<number, Placed>();
let nextId = 0;

// Zero-width characters, so the marker takes no column: U+2063 around the id in base 4.
const ZW = ['​', '‌', '‍', '⁠'];
const SEP = '⁣';
const MARK = /⁣([​‌‍⁠]+)⁣/;
const mark = (id: number) => SEP + id.toString(4).split('').map((d) => ZW[Number(d)]).join('') + SEP;

const DIM = { fg: '#7F848E' };

/** An image's rows in the transcript: its caption, then the rows iTerm2 draws it in. */
export function imageLines(img: ImageData, w: number, indent = '  '): string[] {
  const caption = indent + styled(`▣ ${imageCaption(img)}`, DIM);
  const size = imageSize(img.data);
  if (!showImages || !inlineImages || !size) return [caption];
  const { cols, rows } = cells(size, Math.max(4, w - strWidth(indent)));
  let id = ids.get(img);
  if (id === undefined) {
    id = nextId++;
    ids.set(img, id);
  }
  placed.set(id, { img, cols, rows });
  return [caption, indent + mark(id), ...Array.from({ length: rows - 1 }, () => '')];
}

/**
 * The escape sequences that draw the images whose rows are all on screen:
 * `lines` are the viewport's text rows, which start at screen row `top` and
 * column `left`; rows in `covered` have something drawn over them.
 */
export function drawImages(lines: string[], top: number, left: number, covered: Set<number>): string {
  let out = '';
  lines.forEach((line, i) => {
    const m = MARK.exec(line);
    if (!m) return;
    const id = parseInt(m[1].split('').map((c) => ZW.indexOf(c)).join(''), 4);
    const p = placed.get(id);
    if (!p || i + p.rows > lines.length) return;
    for (let r = 0; r < p.rows; r++) if (covered.has(top + i + r)) return;
    const col = left + strWidth(line.slice(0, m.index));
    out += `\x1b[${top + i + 1};${col + 1}H\x1b]1337;File=inline=1;width=${p.cols};height=${p.rows};preserveAspectRatio=1:${p.img.data}\x07`;
  });
  return out ? `\x1b7${out}\x1b8` : '';
}

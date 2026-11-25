import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawImages, imageCaption, imageLines, imageSize, setInlineImages, setShowImages } from '../src/ui/images.js';
import { initialState, reduce } from '../src/store.js';
import type { ClaudeEvent } from '../src/events.js';
import { wireState } from '../src/remote/wire.js';
import { FIXTURES } from './helpers.js';

const png = readFileSync(join(FIXTURES, 'orange.png')).toString('base64');
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');

describe('image sizes', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageSize(png)).toEqual({ width: 64, height: 64 });
    expect(imageSize(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02, 0, 0]))).toEqual({ width: 800, height: 600 });
    // SOI, an APP0 segment of 4 bytes, then SOF0: precision, height 480, width 640.
    expect(imageSize(b64([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 640, height: 480 });
    const vp8x = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0x57, 0x02, 0, 0, 0];
    expect(imageSize(b64(vp8x))).toEqual({ width: 800, height: 600 });
    expect(imageSize(b64([1, 2, 3]))).toBeNull();
  });

  it('captions an image with its kind, size and weight', () => {
    expect(imageCaption({ mediaType: 'image/png', data: png })).toBe('PNG image, 64×64, 1 KB');
  });
});

describe('images in the transcript', () => {
  afterEach(() => {
    setInlineImages(false);
    setShowImages(true);
  });

  it('is a caption outside iTerm2, and leaves rows to draw in where it can', () => {
    const img = { mediaType: 'image/png', data: png };
    setInlineImages(false);
    expect(imageLines(img, 80).map(plain)).toEqual(['  ▣ PNG image, 64×64, 1 KB']);
    setInlineImages(true);
    const rows = imageLines(img, 80);
    // 64×64 pixels: 8 columns, 4 rows (a cell is twice as tall as wide).
    expect(rows).toHaveLength(1 + 4);
    setShowImages(false);
    expect(imageLines(img, 80)).toHaveLength(1);
  });

  it('draws an image whose rows are all on screen, at its marker, unless something covers it', () => {
    setInlineImages(true);
    const img = { mediaType: 'image/png', data: png };
    const lines = ['before', ...imageLines(img, 80), 'after'];
    const seq = drawImages(lines, 3, 1, new Set());
    // Row 3 + 2 (the caption is at index 1, the marker at 2), column 1 + 2 (the indent).
    expect(seq).toContain(`\x1b[6;4H\x1b]1337;File=inline=1;width=8;height=4;preserveAspectRatio=1:${png}\x07`);
    expect(seq.startsWith('\x1b7') && seq.endsWith('\x1b8')).toBe(true);
    // Cut off at the bottom of the viewport, or under a box: not drawn.
    expect(drawImages(lines.slice(0, 4), 3, 1, new Set())).toBe('');
    expect(drawImages(lines, 3, 1, new Set([7]))).toBe('');
  });

  it("keeps a tool result's images, and the wire sends their size only", () => {
    let s = initialState('sid');
    for (const line of readFileSync(join(FIXTURES, 'image-result.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      if (s.tabs.length === 0) {
        s = reduce(s, { type: 'submit', prompt: 'look', tabId: 1, images: [{ mediaType: 'image/png', data: png }] });
        s = reduce(s, { type: 'sent', tabId: 1 });
      }
      s = reduce(s, { type: 'event', event: JSON.parse(line) as ClaudeEvent });
    }
    const call = s.tabs[0].blocks.find((b) => b.kind === 'tool_use');
    expect(call?.kind === 'tool_use' && call.result?.images).toEqual([{ mediaType: 'image/png', data: png }]);
    expect(s.tabs[0].images).toEqual([{ mediaType: 'image/png', data: png }]);
    const wire = wireState({ state: s, cwd: '/tmp' });
    const tool = wire.tabs[0].blocks.find((b) => b.kind === 'tool_use');
    expect(tool?.kind === 'tool_use' && tool.result?.images).toEqual([{ mediaType: 'image/png', bytes: 176 }]);
    expect(wire.tabs[0].images).toEqual([{ mediaType: 'image/png', bytes: 176 }]);
    expect(JSON.stringify(wire)).not.toContain(png);
  });
});

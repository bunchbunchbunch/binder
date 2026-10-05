import { describe, it, expect } from 'vitest';
import { glimmerAt, keywordColors, RAINBOW, RAINBOW_SHIMMER, ultrathinkRanges } from '../src/ui/ultrathink.js';
import { tabLines } from '../src/ui/tabLines.js';
import { wordColors } from './helpers.js';

describe('ultrathink', () => {
  it('finds the keyword as a whole word in any case, as Claude Code does', () => {
    expect(ultrathinkRanges('ultrathink: fix /ULTRATHINK, not ultrathinking')).toEqual([
      { start: 0, end: 10 },
      { start: 17, end: 27 },
    ]);
  });

  it('colors letters by their place in the word and brightens the three around the sweep', () => {
    const colors = keywordColors(12, [{ start: 2, end: 12 }], 5);
    expect(colors.slice(0, 2)).toEqual([undefined, undefined]);
    expect(colors.slice(2, 4)).toEqual([RAINBOW[0], RAINBOW[1]]);
    expect(colors.slice(4, 7)).toEqual([RAINBOW_SHIMMER[2], RAINBOW_SHIMMER[3], RAINBOW_SHIMMER[4]]);
    expect(colors[7]).toBe(RAINBOW[5]);
    expect(colors[9]).toBe(RAINBOW[0]); // the eighth letter starts the rainbow over
  });

  it('sweeps from 10 columns before the keyword to 10 after, then starts over', () => {
    const ranges = [{ start: 20, end: 30 }];
    expect(glimmerAt(ranges, 0)).toBe(10);
    expect(glimmerAt(ranges, 29)).toBe(39);
    expect(glimmerAt(ranges, 30)).toBe(10);
  });

  it("draws the keyword in rainbow colors in a tab's prompt", () => {
    const tab = { id: 1, prompt: 'please ultrathink about it', status: 'queued' as const, blocks: [], earlier: [] };
    const [first] = tabLines(tab, { width: 80, detail: false, expanded: false, renderText: () => [] }).lines;
    expect(wordColors(first, 'ultrathink')).toEqual([...'ultrathink'].map((_, i) => RAINBOW[i % RAINBOW.length]));
    expect(wordColors(first, 'please')).toEqual(Array(6).fill('#7CC4FF'));
  });
});

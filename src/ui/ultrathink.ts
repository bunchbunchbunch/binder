// "ultrathink" anywhere in a prompt asks for deeper reasoning on that turn.
// The child tells the model itself; binder draws the keyword the way Claude
// Code does: each letter a color of the rainbow, and in the composer a
// brighter band sweeping across it.

export const RAINBOW = ['#EB5F57', '#F58B57', '#FAC35F', '#91C882', '#82AADC', '#9B82C8', '#C882B4'];
export const RAINBOW_SHIMMER = ['#FA9B93', '#FFB989', '#FFE19B', '#B9E6B4', '#B4CDF0', '#C3B4E6', '#E6B4D2'];
// One sweep step per frame.
export const SWEEP_MS = 50;

export type Range = { start: number; end: number };

export function ultrathinkRanges(text: string): Range[] {
  return [...text.matchAll(/\bultrathink\b/gi)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

// The color of each character of the text (undefined outside the keyword).
// Letters within one column of `glimmer` take the brighter shade.
export function keywordColors(length: number, ranges: Range[], glimmer?: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(length);
  for (const r of ranges) {
    for (let i = r.start; i < r.end; i++) {
      const shade = glimmer !== undefined && Math.abs(i - glimmer) <= 1 ? RAINBOW_SHIMMER : RAINBOW;
      out[i] = shade[(i - r.start) % shade.length];
    }
  }
  return out;
}

// Where the sweep is after `tick` frames: it runs from 10 columns before the
// first keyword to 10 after the last, then starts over.
export function glimmerAt(ranges: Range[], tick: number): number {
  const start = ranges[0].start;
  const end = ranges[ranges.length - 1].end;
  return start - 10 + (tick % (end - start + 20));
}

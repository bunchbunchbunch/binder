import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { PromptInput } from '../src/ui/PromptInput.js';
import { shortcutColumns } from '../src/ui/Shortcuts.js';
import { RAINBOW, RAINBOW_SHIMMER } from '../src/ui/ultrathink.js';
import { wordColors } from './helpers.js';

// The cursor is an inverse cell, which Ink only draws when it sees color
// support. Set before Ink loads, and only for this file.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '3';
});
delete process.env.FORCE_COLOR;

// The text of the inverse cell (the cursor).
const cursorCell = (frame = '') => frame.match(/\x1b\[7m(.*?)\x1b\[27m/)?.[1];

describe('prompt placeholder', () => {
  it('puts the cursor on its first letter, where typing starts', () => {
    const ui = render(<PromptInput onSubmit={() => {}} isActive placeholder="Enter queues a new tab" width={60} />);
    expect(ui.lastFrame()?.replace(/\x1b\[[0-9;]*m/g, '')).toBe('❯ Enter queues a new tab');
    expect(cursorCell(ui.lastFrame())).toBe('E');
    ui.unmount();
  });

  it('shows no cursor while the prompt is inactive', () => {
    const ui = render(<PromptInput onSubmit={() => {}} isActive={false} placeholder="Enter queues a new tab" width={60} />);
    expect(ui.lastFrame()?.replace(/\x1b\[[0-9;]*m/g, '')).toBe('❯ Enter queues a new tab');
    expect(cursorCell(ui.lastFrame())).toBeUndefined();
    ui.unmount();
  });
});

describe('ultrathink in the prompt', () => {
  const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '');
  const until = async (check: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('draws the keyword in rainbow colors with a sweep, and says deeper reasoning was requested', async () => {
    const ui = render(<PromptInput onSubmit={() => {}} isActive initialValue="fix it, ultrathink" width={60} />);
    expect(wordColors(ui.lastFrame() ?? '', 'ultrathink')).toEqual([...'ultrathink'].map((_, i) => RAINBOW[i % RAINBOW.length]));
    await until(() => plain(ui.lastFrame()).includes('Deeper reasoning requested for this turn'));
    // The brighter band reaches the first letter after about half a second.
    await until(() => wordColors(ui.lastFrame() ?? '', 'ultrathink')[0] === RAINBOW_SHIMMER[0]);
    ui.stdin.write('\x15'); // Ctrl+U clears the prompt, and the notice goes with the keyword
    await until(() => !plain(ui.lastFrame()).includes('Deeper reasoning'));
    ui.unmount();
  });
});

describe('pasting into the prompt', () => {
  const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await sleep(20);
    }
  };
  // What a terminal sends for a paste while bracketed paste is on (iTerm2 ends lines with CR).
  const paste = (ui: { stdin: { write: (s: string) => void } }, text: string) => ui.stdin.write(`\x1b[200~${text}\x1b[201~`);

  it('keeps a short paste inline', async () => {
    const ui = render(<PromptInput onSubmit={() => {}} isActive width={60} />);
    paste(ui, 'one\rtwo');
    await until(() => plain(ui.lastFrame()).includes('two'));
    expect(plain(ui.lastFrame())).toContain('❯ one\ntwo');
    ui.unmount();
  });

  it('shows a paste with more than 2 line breaks as [Pasted text #1 +3 lines] and sends all of it', async () => {
    const sent: string[] = [];
    const ui = render(<PromptInput onSubmit={(text) => sent.push(text)} isActive width={60} />);
    ui.stdin.write('see ');
    await sleep(30);
    paste(ui, 'a $1 b\rline 2\rline 3\rline $& 4');
    await until(() => plain(ui.lastFrame()).includes('❯ see [Pasted text #1 +3 lines]'));
    ui.stdin.write('\r');
    await until(() => sent.length === 1);
    expect(sent[0]).toBe('see a $1 b\nline 2\nline 3\nline $& 4');
    ui.unmount();
  });

  it('shows a one-line paste over 800 characters as [Pasted text #1]', async () => {
    const sent: string[] = [];
    const ui = render(<PromptInput onSubmit={(text) => sent.push(text)} isActive width={60} />);
    paste(ui, 'x'.repeat(801));
    await until(() => plain(ui.lastFrame()).includes('❯ [Pasted text #1]'));
    ui.stdin.write('\r');
    await until(() => sent.length === 1);
    expect(sent[0]).toBe('x'.repeat(801));
    ui.unmount();
  });
});

describe('shortcuts popup', () => {
  const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await sleep(20);
    }
  };

  it('uses three columns when they fit, fewer when narrow, and keeps every shortcut', () => {
    const wide = shortcutColumns(120);
    expect(wide).toHaveLength(3);
    const narrow = shortcutColumns(70);
    expect(narrow.length).toBeLessThan(3);
    expect(narrow.flat()).toEqual(wide.flat());
  });

  it('"?" on an empty prompt opens it; Esc, "?" or typing closes it', async () => {
    const ui = render(<PromptInput onSubmit={() => {}} isActive width={120} />);
    const open = () => plain(ui.lastFrame()).includes('ctrl + n / p to switch tabs');
    ui.stdin.write('?');
    await until(open);
    expect(plain(ui.lastFrame()).split('\n')[0]).not.toContain('?'); // not typed
    ui.stdin.write('\x1b');
    await until(() => !open());
    ui.stdin.write('?');
    await until(open);
    ui.stdin.write('?');
    await until(() => !open());
    ui.stdin.write('?');
    await until(open);
    ui.stdin.write('a');
    await until(() => !open() && plain(ui.lastFrame()).startsWith('❯ a'));
    ui.stdin.write('?'); // with text in the prompt, "?" is just typed
    await until(() => plain(ui.lastFrame()).startsWith('❯ a?'));
    expect(open()).toBe(false);
    ui.unmount();
  });
});

describe('wrapping in the prompt', () => {
  const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '');
  const squash = (s: string) => s.replace(/\s/g, '');

  // Ink wraps by word, so a word that does not fit moves to the next row and
  // leaves the end of the row empty. The box must grow for it.
  it('shows every character while a long prompt is typed', () => {
    const text = 'aaaaaaaaa bbbbbbbbbbb cccccccc the quick brown fox jumps over a lazy dog';
    for (let n = 1; n <= text.length; n++) {
      const typed = text.slice(0, n);
      const ui = render(<Box width={20}><PromptInput onSubmit={() => {}} isActive initialValue={typed} width={20} /></Box>);
      expect(squash(plain(ui.lastFrame())), `after "${typed}"`).toBe(squash('❯ ' + typed));
      ui.unmount();
    }
  });
});

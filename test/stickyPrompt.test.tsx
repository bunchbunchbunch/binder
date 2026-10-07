import React from 'react';
import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { TabView } from '../src/ui/TabView.js';
import type { Block, Tab, Turn } from '../src/store.js';

const HOME = '\x1b[H';
const PAGE_UP = '\x1b[5~';
const CTRL_E = '\x05';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '');
// The viewport's rows, without its one-column padding.
const rows = (ui: { lastFrame: () => string | undefined }) => plain(ui.lastFrame()).split('\n').map((l) => l.replace(/^ /, '').trimEnd());

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(10);
  }
}

const answer = (name: string, n: number): Block => ({ kind: 'text', final: true, text: Array.from({ length: n }, (_, i) => `${name} ${i}`).join('\n\n') });
const turn = (prompt: string, blocks: Block[]): Turn => ({ prompt, status: 'done', blocks, result: { durationMs: 1200, costUsd: 0, numTurns: 1, isError: false } });
const tabOf = (latest: Turn, earlier: Turn[] = []): Tab => ({ ...latest, id: 1, earlier });

function mount(tab: Tab, sticky = true) {
  const ui = render(
    <Box height={20} flexDirection="column">
      <TabView tab={tab} width={60} detail={false} scrollActive questionPending={false} sticky={sticky} />
    </Box>,
  );
  return ui;
}

describe('sticky prompt', () => {
  it('pins the first rows of a long prompt over a long response, and Home shows it in full', async () => {
    const ui = mount(tabOf(turn('p1\np2\np3\np4\np5\np6', [answer('answer', 40)])));
    await until(() => rows(ui).some((l) => l.includes('answer 39')));
    const top = rows(ui).slice(0, 4);
    expect(top.slice(0, 3)).toEqual(['│ p1', '│ p2', '│ p3 …']);
    expect(top[3]).toMatch(/^╌+ \+3 lines · Home ╌$/);
    expect(rows(ui).at(-1)).toBe('1.2s');

    ui.stdin.write(HOME);
    await until(() => rows(ui)[0] === '│ p1');
    expect(rows(ui).slice(0, 7)).toEqual(['│ p1', '│ p2', '│ p3', '│ p4', '│ p5', '│ p6', '']);
    expect(plain(ui.lastFrame())).not.toContain('╌');
    ui.unmount();
  });

  it('pins a short prompt whole, with a plain rule', async () => {
    const ui = mount(tabOf(turn('what is new?', [answer('answer', 40)])));
    await until(() => rows(ui).some((l) => l.includes('answer 39')));
    expect(rows(ui)[0]).toBe('│ what is new?');
    expect(rows(ui)[1]).toMatch(/^╌+$/);
    ui.unmount();
  });

  it('leaves a response that fits on screen as it is', async () => {
    const ui = mount(tabOf(turn('what is new?', [answer('answer', 3)])));
    await until(() => rows(ui).some((l) => l.includes('answer 2')));
    expect(rows(ui).slice(0, 3)).toEqual(['│ what is new?', '', 'answer 0']);
    expect(plain(ui.lastFrame())).not.toContain('╌');
    ui.unmount();
  });

  it('is off unless asked for', async () => {
    const ui = mount(tabOf(turn('what is new?', [answer('answer', 40)])), false);
    await until(() => rows(ui).some((l) => l.includes('answer 39')));
    expect(plain(ui.lastFrame())).not.toContain('what is new?');
    ui.unmount();
  });

  it("shows the prompt of the turn on screen in a tab with follow-ups", async () => {
    const ui = mount(tabOf(turn('second ask', [answer('second', 30)]), [turn('first ask', [answer('first', 30)])]));
    await until(() => rows(ui).some((l) => l.includes('second 29')));
    expect(rows(ui)[0]).toBe('│ second ask');

    // Back up into the first turn's response.
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(PAGE_UP);
      await sleep(30);
    }
    await until(() => rows(ui)[0] === '│ first ask');
    expect(rows(ui).slice(2).some((l) => /^first \d+$/.test(l))).toBe(true);
    ui.unmount();
  });

  it('brings the work into view just under the header when Ctrl+E expands it', async () => {
    const tool: Block = { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, inputJson: '{"command":"ls"}', final: true, result: { content: 'a\nb', isError: false }, children: [] };
    const ui = mount(tabOf(turn('p1\np2\np3\np4\np5', [tool, answer('answer', 40)])));
    await until(() => rows(ui).some((l) => l.includes('answer 39')));
    ui.stdin.write(CTRL_E);
    await until(() => rows(ui).some((l) => l.includes('Ctrl+E to collapse')));
    const r = rows(ui);
    expect(r.slice(0, 3)).toEqual(['│ p1', '│ p2', '│ p3 …']);
    expect(r[3]).toMatch(/\+2 lines · Home/);
    expect(r[4]).toMatch(/^▾ 1 tool call \(Ctrl\+E to collapse\)$/);
    ui.unmount();
  });
});

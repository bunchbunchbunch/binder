import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { HelpView } from '../src/ui/HelpView.js';
import { mergeCommands } from '../src/slashCommands.js';
import { USAGE, parseArgs } from '../src/args.js';

// The help a user reads has to keep up with what binder registers.
describe('help text', () => {
  const plain = (frame = '') => frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');

  // Every command it names is one binder runs (the full list would not fit a short terminal).
  it('/help names only commands binder runs itself', () => {
    const ui = render(<HelpView commandCount={40} />);
    const text = plain(ui.lastFrame());
    const own = new Set(mergeCommands([]).flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const named = [...text.matchAll(/(?<![\w/.~])\/([a-z][a-z-]*)\b/g)].map((m) => m[1]);
    expect(named).toEqual(expect.arrayContaining(['fast', 'diff', 'btw', 'schedule', 'plugins']));
    for (const name of named) expect(own).toContain(name);
    expect(text).toContain('a file copied in Finder');
    ui.unmount();
  });

  it('binder --help lists schedule and the sessions flags', () => {
    expect(parseArgs(['--help'], '/x')).toEqual({ error: USAGE });
    for (const s of ['binder schedule', 'tick', '--search <text>', '--archive <id>', '--unarchive <id>']) expect(USAGE).toContain(s);
  });
});

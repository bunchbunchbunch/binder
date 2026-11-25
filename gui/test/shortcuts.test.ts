import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HelpView, Shortcuts } from '../src/renderer/src/components/Shortcuts';

// The help a user reads has to keep up with the keys and commands the app has.
describe('help and shortcuts', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  it('/help and the guide list the newer keys, and name every command the app runs itself', () => {
    const help = text(renderToStaticMarkup(createElement(HelpView, { commandCount: 40 })));
    for (const k of ['Ctrl+T', 'Ctrl+`', 'Ctrl+\\', 'Cmd+P', 'Cmd+\\', 'Cmd+,']) expect(help).toContain(k);
    expect(help).toMatch(/Ctrl\+V .*\[File #n: name\]/);
    // commands.ts's LocalCommandName: the commands the app runs rather than sending to Claude Code.
    const src = readFileSync(join(__dirname, '../src/renderer/src/lib/commands.ts'), 'utf8');
    const own = [.../export type LocalCommandName = ([^;]+);/.exec(src)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(own.length).toBeGreaterThan(20);
    for (const name of own) expect(help).toMatch(new RegExp(`/${name}\\b`));
  });

  it('the ? sheet lists ⌃\\', () => {
    expect(text(renderToStaticMarkup(createElement(Shortcuts)))).toContain('⌃\\');
  });
});

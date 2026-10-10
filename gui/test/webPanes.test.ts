import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPanes } from '../src/main/binder';
import { completeFolder, inHome, makeFolder, missingFolder, paneOpen, sameOrigin } from '../src/main/paneBridge';
import { appKey } from '../src/shared/keys';

const id = '00000000-0000-4000-8000-0000000000a1';

describe("config.json's panes", () => {
  it('reads terminal panes and web panes, and ignores a url that is not http or https', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bg-panes-')), 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        panes: [
          { name: 'Todos', command: 'npm run tui', cwd: '~/code/todo' },
          { name: 'Todo GUI', url: 'https://example.com/desk' },
          { name: 'Local', url: 'http://127.0.0.1:3000/' },
          { name: 'File', url: 'file:///etc/hosts' },
          { name: 'Script', url: 'javascript:alert(1)' },
          { name: 'Broken', url: 'https://' },
          { name: 'Both', command: 'top', url: 'https://example.com/' },
          { url: 'https://example.com/' },
        ],
      }),
    );
    expect(readPanes({ BINDER_CONFIG: path })).toEqual([
      { name: 'Todos', command: 'npm run tui', cwd: '~/code/todo' },
      { name: 'Todo GUI', url: 'https://example.com/desk' },
      { name: 'Local', url: 'http://127.0.0.1:3000/' },
      { name: 'Both', command: 'top' },
    ]);
  });
});

describe("the window's keys, as a web pane's page passes them on", () => {
  const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
    appKey({ code, meta: mods.meta ?? true, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false });

  it('are ⌘N, ⌘K, ⌘,, ⌘/, ⌘W, ⌘1-9, ⌘⇧[ ] and ⌃⌘S', () => {
    expect(key('KeyN')).toBe('new');
    expect(key('KeyK')).toBe('switcher');
    expect(key('Comma')).toBe('settings');
    expect(key('Slash')).toBe('guide');
    expect(key('KeyW')).toBe('close');
    expect(key('Digit1')).toBe(1);
    expect(key('Digit9')).toBe(9);
    expect(key('BracketLeft', { shift: true })).toBe('prev');
    expect(key('BracketRight', { shift: true })).toBe('next');
    expect(key('KeyS', { ctrl: true })).toBe('sidebar');
  });

  it("leave the page's own keys alone: editing, ⌘0, ⇧ variants, and anything without ⌘", () => {
    for (const code of ['KeyZ', 'KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyF', 'KeyR', 'Digit0', 'BracketLeft', 'Equal']) expect(key(code)).toBeNull();
    expect(key('KeyZ', { shift: true })).toBeNull();
    expect(key('Digit1', { shift: true })).toBeNull();
    expect(key('KeyN', { shift: true })).toBeNull();
    expect(key('KeyK', { alt: true })).toBeNull();
    expect(key('Digit1', { ctrl: true })).toBeNull();
    expect(key('KeyN', { meta: false })).toBeNull();
    expect(key('KeyS', { meta: false, ctrl: true })).toBeNull();
  });
});

describe('the bridge', () => {
  // realpath: macOS's tmpdir is a symlink, and paths are compared as written.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bg-home-')));
  for (const dir of ['code/app', 'code/api', 'code/web', 'notes', '.config', 'locked/inner']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, 'code/apple.txt'), '');
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'bg-elsewhere-')));
  symlinkSync(join(home, 'code/web'), join(home, 'code/apilink'));
  symlinkSync(join(home, 'missing'), join(home, 'code/apidead'));

  it('keeps a page to its origin', () => {
    expect(sameOrigin('https://example.com/a?b', 'https://example.com/desk')).toBe(true);
    expect(sameOrigin('http://example.com/desk', 'https://example.com/desk')).toBe(false);
    expect(sameOrigin('https://example.com:8443/', 'https://example.com/')).toBe(false);
    expect(sameOrigin('https://evil.example/', 'https://example.com/')).toBe(false);
    expect(sameOrigin('not a url', 'https://example.com/')).toBe(false);
  });

  it('counts home and what is under it as inside home, after ..', () => {
    expect(inHome(home, home)).toBe(true);
    expect(inHome(join(home, 'code'), home)).toBe(true);
    expect(inHome(join(home, '..'), home)).toBe(false);
    expect(inHome(`${home}-other`, home)).toBe(false);
    expect(inHome('/etc', home)).toBe(false);
  });

  it('completes folders as a terminal tab does', () => {
    expect(completeFolder('~', home)).toEqual({ value: '~/', options: [] });
    expect(completeFolder('~/no', home)).toEqual({ value: '~/notes/', options: [] });
    expect(completeFolder('no', home)).toEqual({ value: 'notes/', options: [] });
    expect(completeFolder(`${home}/no`, home)).toEqual({ value: `${home}/notes/`, options: [] });
    // Several: the common prefix, and the names; a link to a folder counts, files and dead links do not.
    expect(completeFolder('~/code/a', home)).toEqual({ value: '~/code/ap', options: ['api', 'apilink', 'app'] });
    expect(completeFolder('~/code/x', home)).toEqual({ value: '~/code/x', options: [] });
    // Dot-folders once a "." is typed.
    expect(completeFolder('~/', home).options).toEqual(['code', 'locked', 'notes']);
    expect(completeFolder('~/.c', home)).toEqual({ value: '~/.config/', options: [] });
    // A trailing slash, .. and // are normalized before the guard.
    expect(completeFolder('~/code//../no', home)).toEqual({ value: '~/code//../notes/', options: [] });
  });

  it('completes nothing outside home, or in a folder it cannot read', () => {
    expect(completeFolder('/', home)).toEqual({ value: '/', options: [] });
    expect(completeFolder(`${elsewhere}/`, home)).toEqual({ value: `${elsewhere}/`, options: [] });
    expect(completeFolder('~/../', home)).toEqual({ value: '~/../', options: [] });
    chmodSync(join(home, 'locked'), 0o000);
    try {
      expect(completeFolder('~/locked/i', home)).toEqual({ value: '~/locked/i', options: [] });
    } finally {
      chmodSync(join(home, 'locked'), 0o755);
    }
    expect(() => completeFolder(7, home)).toThrow('input must be a path');
  });

  it('names a missing folder, and makes it, only inside home', () => {
    expect(missingFolder('  ', home)).toBeNull();
    expect(missingFolder('~/code', home)).toBeNull();
    expect(missingFolder('~', home)).toBeNull();
    expect(missingFolder('~/code/new/deep/', home)).toBe(join(home, 'code/new/deep'));
    expect(missingFolder('drafts', home)).toBe(join(home, 'drafts'));
    expect(() => missingFolder(`${elsewhere}/new`, home)).toThrow('outside your home folder');
    expect(() => missingFolder('~/../new', home)).toThrow('outside your home folder');

    makeFolder(join(home, 'code/new/deep'), home);
    expect(existsSync(join(home, 'code/new/deep'))).toBe(true);
    expect(() => makeFolder(`${elsewhere}/new`, home)).toThrow('outside your home folder');
    expect(() => makeFolder(`${home}/../${home.split('/').pop()}-x`, home)).toThrow('outside your home folder');
    expect(existsSync(join(elsewhere, 'new'))).toBe(false);
    // Only folders: a file in the way is an error, not replaced.
    expect(() => makeFolder(join(home, 'code/apple.txt'), home)).toThrow();
  });

  it('opens a session as the control socket does, with claude flags only from the name', () => {
    expect(paneOpen({ cwd: `${home}/code//app/`, sessionId: id, draft: 'Pay rent', name: 'Pay rent' }, home)).toEqual({
      t: 'open',
      cwd: join(home, 'code/app'),
      sessionId: id,
      resume: false,
      draft: 'Pay rent',
      args: ['-n', 'Pay rent'],
    });
    expect(paneOpen({ cwd: home, sessionId: id, resume: true }, home)).toEqual({ t: 'open', cwd: home, sessionId: id, resume: true });
    // Raw flags are not a field a page can send.
    expect(paneOpen({ cwd: home, sessionId: id, args: ['--dangerously-skip-permissions'] }, home)).toEqual({ t: 'open', cwd: home, sessionId: id, resume: false });
  });

  it('refuses a request outside home, for a folder that is not there, or with bad fields', () => {
    const ok = { cwd: join(home, 'code/app'), sessionId: id };
    expect(paneOpen(null, home)).toBe('cwd must be an absolute path');
    expect(paneOpen({ ...ok, cwd: 'code/app' }, home)).toBe('cwd must be an absolute path');
    expect(paneOpen({ ...ok, cwd: `${home}/code/../..` }, home)).toBe('cwd must be inside your home folder');
    expect(paneOpen({ ...ok, cwd: elsewhere }, home)).toBe('cwd must be inside your home folder');
    expect(paneOpen({ ...ok, cwd: join(home, 'gone') }, home)).toBe(`cwd is not a folder: ${join(home, 'gone')}`);
    expect(paneOpen({ ...ok, cwd: join(home, 'code/apple.txt') }, home)).toBe(`cwd is not a folder: ${join(home, 'code/apple.txt')}`);
    expect(paneOpen({ ...ok, sessionId: 'abc' }, home)).toBe('sessionId must be a UUID');
    expect(paneOpen({ ...ok, sessionId: undefined }, home)).toBe('sessionId must be a UUID');
    expect(paneOpen({ ...ok, resume: 'yes' }, home)).toBe('resume must be true or false');
    expect(paneOpen({ ...ok, draft: 5 }, home)).toBe('draft must be a string of at most 25000 characters');
    expect(paneOpen({ ...ok, draft: 'x'.repeat(25001) }, home)).toBe('draft must be a string of at most 25000 characters');
    expect(paneOpen({ ...ok, draft: 'x'.repeat(25000) }, home)).toMatchObject({ t: 'open' });
    expect(paneOpen({ ...ok, name: 'x'.repeat(501) }, home)).toBe('name must be a string of at most 500 characters');
  });
});

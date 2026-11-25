import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_MAX, fileIndex, listDir, readText, writeText } from '../src/fileAccess.js';

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'binder-files-')));
  mkdirSync(join(dir, 'app', 'src'), { recursive: true });
  mkdirSync(join(dir, 'app', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'app', 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'app', 'README.md'), '# app\n');
  writeFileSync(join(dir, 'app', '.env'), 'X=1\n');
  writeFileSync(join(dir, 'app', '.DS_Store'), '');
  writeFileSync(join(dir, 'app', 'node_modules', 'x', 'i.js'), '');
  writeFileSync(join(dir, 'secret.txt'), 'outside\n');
  return join(dir, 'app');
}

describe('the file pane', () => {
  it('lists a folder, folders first; never .git or .DS_Store; nothing outside the session folder', async () => {
    const root = folder();
    expect(await listDir(root)).toEqual({ dir: '', entries: [{ name: 'node_modules', dir: true }, { name: 'src', dir: true }, { name: '.env', dir: false }, { name: 'README.md', dir: false }] });
    expect(await listDir(root, 'src')).toEqual({ dir: 'src', entries: [{ name: 'a.ts', dir: false }] });
    await expect(listDir(root, '..')).rejects.toThrow('.. is outside the session folder');
    // A symlink that leads out is refused too.
    symlinkSync(join(root, '..'), join(root, 'up'));
    await expect(listDir(root, 'up')).rejects.toThrow('up is outside the session folder');
    await expect(readText(root, 'up/secret.txt')).rejects.toThrow('outside the session folder');
    // Listed as a folder only when it leads to one inside.
    symlinkSync('src', join(root, 'code'));
    expect((await listDir(root)).entries).toEqual(expect.arrayContaining([{ name: 'code', dir: true }, { name: 'up', dir: false }]));
  });

  it("indexes git's files (tracked and untracked, not ignored), else walks past heavy folders", async () => {
    const root = folder();
    expect((await fileIndex(root)).files.sort()).toEqual(['.env', 'README.md', 'src/a.ts']);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', root, ...args]);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, '.gitignore'), '.env\nnode_modules\n');
    git('add', 'README.md');
    git('commit', '-qm', 'init');
    expect((await fileIndex(root)).files.sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts']);
  });

  it('reads text with its mtime; says when a file is binary; refuses one too big', async () => {
    const root = folder();
    const r = await readText(root, 'src/a.ts');
    expect(r).toMatchObject({ path: 'src/a.ts', size: 20, text: 'export const a = 1;\n' });
    expect(r.mtime).toBeGreaterThan(0);
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect(await readText(root, 'logo.png')).toMatchObject({ path: 'logo.png', binary: true });
    expect((await readText(root, 'logo.png')).text).toBeUndefined();
    writeFileSync(join(root, 'big.log'), Buffer.alloc(FILE_MAX + 1, 'a'));
    await expect(readText(root, 'big.log')).rejects.toThrow('big.log is 2,097,153 bytes, over the 2 MB limit: too big to open here');
    // Text in another encoding would not save back the same.
    writeFileSync(join(root, 'latin1.txt'), Buffer.from('café\n', 'latin1'));
    await expect(readText(root, 'latin1.txt')).rejects.toThrow('latin1.txt is not UTF-8 text, so it cannot be opened here');
    await expect(readText(root, 'src')).rejects.toThrow('src is not a file');
    await expect(readText(root, 'nope.ts')).rejects.toThrow(/ENOENT/);
  });

  it('saves only what was not changed on disk since it was read, unless forced', async () => {
    const root = folder();
    const r = await readText(root, 'src/a.ts');
    const saved = await writeText(root, 'src/a.ts', 'export const a = 2;\n', r.mtime);
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(saved).toMatchObject({ path: 'src/a.ts', size: 20 });
    // Changed since (Claude edited it): refused, then forced.
    utimesSync(join(root, 'src/a.ts'), new Date(), new Date(Date.now() + 5000));
    await expect(writeText(root, 'src/a.ts', 'mine\n', saved.mtime)).rejects.toThrow('src/a.ts changed on disk since it was opened');
    await writeText(root, 'src/a.ts', 'mine\n', saved.mtime, true);
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('mine\n');
    await expect(writeText(root, '../secret.txt', 'x')).rejects.toThrow('../secret.txt is outside the session folder');
    expect(readFileSync(join(root, '..', 'secret.txt'), 'utf8')).toBe('outside\n');
  });

  it('never writes outside through a symlinked folder, a broken symlink, or a symlink in a parent folder', async () => {
    const root = folder();
    const out = join(root, '..', 'out');
    mkdirSync(join(out, 'deep'), { recursive: true });
    symlinkSync(out, join(root, 'linkout'));
    symlinkSync(join(out, 'made.txt'), join(root, 'dangling'));
    symlinkSync('../../out', join(root, 'src', 'escape'));
    await expect(writeText(root, 'linkout/new.txt', 'x')).rejects.toThrow('linkout/new.txt is outside the session folder');
    await expect(writeText(root, 'dangling', 'x')).rejects.toThrow('dangling is a broken symlink');
    await expect(writeText(root, 'src/escape/deep/new.txt', 'x')).rejects.toThrow('src/escape/deep/new.txt is outside the session folder');
    expect(readdirSync(out)).toEqual(['deep']);
    expect(readdirSync(join(out, 'deep'))).toEqual([]);
    // A symlink to a file inside saves that file, and stays a link; a new file inside is made.
    symlinkSync('src/a.ts', join(root, 'alias.ts'));
    expect(await writeText(root, 'alias.ts', 'export const a = 3;\n')).toMatchObject({ path: 'src/a.ts' });
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 3;\n');
    expect(lstatSync(join(root, 'alias.ts')).isSymbolicLink()).toBe(true);
    await writeText(root, 'src/b.ts', 'b\n');
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('b\n');
  });

  it('never writes outside while the file or a folder on the way is swapped for a symlink', async () => {
    const root = folder();
    const out = join(root, '..', 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'x.txt'), 'outside\n');
    writeFileSync(join(root, 'x.txt'), 'inside\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'x.txt'), 'inside\n');
    // Flips x.txt and sub between the real thing and a symlink leading out, as fast as it can.
    const swapper = spawn(process.execPath, [
      '-e',
      `const fs = require('fs');
      const [root, out] = process.argv.slice(1);
      for (const end = Date.now() + 1500; Date.now() < end; ) {
        try { fs.symlinkSync(out + '/x.txt', root + '/l'); fs.renameSync(root + '/l', root + '/x.txt'); } catch {}
        try { fs.writeFileSync(root + '/t', 'inside\\n'); fs.renameSync(root + '/t', root + '/x.txt'); } catch {}
        try { fs.renameSync(root + '/sub', root + '/real'); fs.symlinkSync(out, root + '/sub'); } catch {}
        try { fs.unlinkSync(root + '/sub'); fs.renameSync(root + '/real', root + '/sub'); } catch {}
      }`,
      root,
      out,
    ]);
    let running = true;
    swapper.on('exit', () => (running = false));
    let saved = 0;
    while (running) await Promise.all(['x.txt', 'sub/x.txt'].map((p) => writeText(root, p, 'RACE\n').then(() => saved++, () => {})));
    expect(readFileSync(join(out, 'x.txt'), 'utf8')).toBe('outside\n');
    expect(saved).toBeGreaterThan(0);
  });
});

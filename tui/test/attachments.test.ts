import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachFile, attachmentBlocks, attachmentLabel, pastedPaths } from '../src/attachments.js';
import { FIXTURES } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'binder-attach-'));

describe('attachments', () => {
  it('takes images, PDFs and text files, and says why not for the rest', () => {
    expect(attachFile(join(FIXTURES, 'orange.png'))).toMatchObject({ mediaType: 'image/png', name: 'orange.png' });
    writeFileSync(join(dir, 'notes.pdf'), '%PDF-1.4');
    expect(attachFile(join(dir, 'notes.pdf'))).toEqual({ mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64'), name: 'notes.pdf' });
    writeFileSync(join(dir, 'plan.md'), '# Plan');
    expect(attachFile(join(dir, 'plan.md'))).toMatchObject({ mediaType: 'text/plain', name: 'plan.md' });
    // No extension, but it reads as text.
    writeFileSync(join(dir, 'Makefile'), 'all:\n\techo hi\n');
    expect(attachFile(join(dir, 'Makefile'))).toMatchObject({ mediaType: 'text/plain' });
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
    expect(attachFile(join(dir, 'blob.bin'))).toMatch(/not an image, a PDF or text/);
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(600 * 1024));
    expect(attachFile(join(dir, 'big.txt'))).toMatch(/over 512 KB/);
    expect(attachFile(join(dir, 'missing.pdf'))).toMatch(/No such file/);
  });

  it('becomes an image block, a document block, or the text fenced past any backticks in it', () => {
    const text = 'a ```b``` c';
    const blocks = attachmentBlocks([
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'application/pdf', data: 'BBBB', name: 'n.pdf' },
      { mediaType: 'text/plain', data: Buffer.from(text).toString('base64'), name: 't.md' },
    ]);
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(blocks[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' }, title: 'n.pdf' });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Attached file t.md:\n\n````\na ```b``` c\n````' });
    expect(attachmentLabel({ mediaType: 'application/pdf', data: '', name: 'n.pdf' }, 2)).toBe('[File #2: n.pdf]');
  });

  it('reads pasted paths as iTerm2 types them for dropped files', () => {
    expect(pastedPaths('/Users/me/My\\ Notes.pdf ')).toEqual([{ text: '/Users/me/My\\ Notes.pdf', path: '/Users/me/My Notes.pdf' }]);
    expect(pastedPaths('/tmp/a.pdf /tmp/b\\ c.png ')).toEqual([{ text: '/tmp/a.pdf', path: '/tmp/a.pdf' }, { text: '/tmp/b\\ c.png', path: '/tmp/b c.png' }]);
    expect(pastedPaths('look at /tmp/a.pdf')).toBeNull();
    expect(pastedPaths('/tmp/a b')).toBeNull();
    expect(pastedPaths(' ')).toBeNull();
    // Lines of paths are text someone copied, not files dropped.
    expect(pastedPaths('/etc/hosts\n/etc/shells')).toBeNull();
  });
});

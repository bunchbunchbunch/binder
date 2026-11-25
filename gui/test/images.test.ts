import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localImage } from '../src/main/images';

// Only fetchImage uses Electron.
vi.mock('electron', () => ({ net: {} }));

describe('a markdown image of a file here', () => {
  it('loads by its absolute or relative path, URL-encoded as markdown gives it (a space, an accent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-img-'));
    writeFileSync(join(dir, 'my pic é.png'), 'png');
    const want = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    expect(localImage(`${dir}/my%20pic%20%C3%A9.png`, '/')).toBe(want);
    expect(localImage(`file://${dir}/my%20pic%20%C3%A9.png`, '/')).toBe(want);
    expect(localImage('my%20pic%20%C3%A9.png', dir)).toBe(want);
  });
});

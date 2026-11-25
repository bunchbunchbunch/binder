import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewTarget, serverUrl } from '../src/shared/preview';
import { previewCommand } from '../src/main/devServer';

describe('the preview', () => {
  it("reads the address a dev server prints, ANSI and all", () => {
    expect(serverUrl('\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n')).toBe('http://localhost:5173/');
    expect(serverUrl('  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose')).toBe('http://localhost:5173/');
    expect(serverUrl('ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000')).toBe('http://localhost:3000');
    expect(serverUrl('Serving HTTP on :: port 8000 (http://[::]:8000/) ...')).toBe('http://localhost:8000/');
    expect(serverUrl('Listening on http://127.0.0.1:4321.')).toBe('http://127.0.0.1:4321');
    expect(serverUrl('compiling…')).toBeNull();
  });

  it('takes a URL, a port, host:port, or a command', () => {
    expect(previewTarget('5173')).toEqual({ url: 'http://localhost:5173/' });
    expect(previewTarget('localhost:3000/app')).toEqual({ url: 'http://localhost:3000/app' });
    expect(previewTarget('0.0.0.0:3000')).toEqual({ url: 'http://localhost:3000' });
    expect(previewTarget('[::]:8000/')).toEqual({ url: 'http://localhost:8000/' });
    expect(previewTarget('myhost:3000')).toEqual({ url: 'http://myhost:3000' });
    expect(previewTarget('dev.local:8080/x')).toEqual({ url: 'http://dev.local:8080/x' });
    expect(previewTarget('192.168.1.5:5173')).toEqual({ url: 'http://192.168.1.5:5173' });
    expect(previewTarget('https://example.com')).toEqual({ url: 'https://example.com' });
    expect(previewTarget('npm run dev -- --port 4000')).toEqual({ command: 'npm run dev -- --port 4000' });
    expect(previewTarget('  ')).toBeNull();
  });

  it("starts package.json's dev script (else start) with the package manager its lockfile names; config.json's previewCommand first", () => {
    const dir = (pkg: object | null, lock?: string) => {
      const d = mkdtempSync(join(tmpdir(), 'bprev-'));
      if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
      if (lock) writeFileSync(join(d, lock), '');
      return d;
    };
    expect(previewCommand(dir({ scripts: { dev: 'vite', start: 'node .' } }), null)).toBe('npm run dev');
    expect(previewCommand(dir({ scripts: { start: 'node .' } }), null)).toBe('npm start');
    expect(previewCommand(dir({ scripts: { dev: 'next dev' } }, 'pnpm-lock.yaml'), null)).toBe('pnpm run dev');
    expect(previewCommand(dir({ scripts: { start: 'x' } }, 'yarn.lock'), null)).toBe('yarn run start');
    expect(previewCommand(dir({ scripts: { test: 'x' } }), null)).toBeNull();
    expect(previewCommand(dir(null), null)).toBeNull();
    expect(previewCommand(dir(null), 'python3 -m http.server')).toBe('python3 -m http.server');
  });
});

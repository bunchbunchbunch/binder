import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ClipboardImage = { mediaType: 'image/png' | 'image/jpeg'; data: string };

const CLASSES: Array<{ cls: string; mediaType: ClipboardImage['mediaType'] }> = [
  { cls: '«class PNGf»', mediaType: 'image/png' },
  { cls: 'JPEG picture', mediaType: 'image/jpeg' },
];

function osascript(lines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Reads an image off the macOS clipboard (the way Claude Code's Ctrl+V does)
// and returns it base64-encoded, or null when the clipboard holds no image.
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== 'darwin') return null;
  const dir = mkdtempSync(join(tmpdir(), 'binder-clip-'));
  const file = join(dir, 'clip.bin');
  try {
    for (const { cls, mediaType } of CLASSES) {
      try {
        await osascript([
          `set f to open for access POSIX file "${file}" with write permission`,
          'set eof f to 0',
          `write (the clipboard as ${cls}) to f`,
          'close access f',
        ]);
        const buf = readFileSync(file);
        if (buf.length) return { mediaType, data: buf.toString('base64') };
      } catch {
        // not this format; the open-for-access handle is released when osascript exits
      }
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

import { net } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, resolve } from 'node:path';

// Markdown images for the window: a file on this Mac, or one from the web the
// person asked to load. Images only (by extension, or the server's content
// type), at most MAX_BYTES, as data URLs (the window's CSP allows no others).

const MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export function localImage(path: string, cwd: string): string {
  // Markdown gives the path URL-encoded (a space as %20), absolute or not.
  const p = decodeURIComponent(path.replace(/^file:\/\//, '')).replace(/^~(?=$|\/)/, homedir());
  const file = isAbsolute(p) ? p : resolve(cwd, p);
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error(`Not an image file: ${file}`);
  const size = statSync(file).size;
  if (size > MAX_BYTES) throw new Error(`Too large to show: ${file}`);
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

export async function fetchImage(url: string): Promise<string> {
  if (!/^https?:/i.test(url)) throw new Error('Only http and https images load');
  const r = await net.fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error(`Not an image (${type || 'no content type'})`);
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error('Too large to show');
  return `data:${type};base64,${body.toString('base64')}`;
}

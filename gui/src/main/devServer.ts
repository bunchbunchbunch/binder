import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// What starts a session's preview (/preview, main/preview.ts).

/** The dev server for a folder: config.json's previewCommand, else package.json's dev (or start) script, run by the package manager its lockfile names. */
export function previewCommand(cwd: string, configured: string | null): string | null {
  if (configured) return configured;
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')) ? 'bun' : 'npm';
  if (typeof scripts.dev === 'string') return `${pm} run dev`;
  if (typeof scripts.start === 'string') return pm === 'npm' ? 'npm start' : `${pm} run start`;
  return null;
}

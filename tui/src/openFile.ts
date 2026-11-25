import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Tab, Block } from './store.js';

// Files a session's tool calls touched, opened in your editor (config.json
// `editor`) or shown in Finder. `editor` is "open" (macOS opens the file in
// its default app), a command the path is added to ("code", "cursor", "zed"),
// or a command with {file} and {line} in it ("code -g {file}:{line}").

export const EDITOR_PRESETS: Array<[command: string, about: string]> = [
  ['open', "the file's default app (macOS)"],
  ['code -g {file}:{line}', 'Visual Studio Code, at the line'],
  ['cursor -g {file}:{line}', 'Cursor, at the line'],
  ['zed {file}:{line}', 'Zed, at the line'],
  ['subl {file}:{line}', 'Sublime Text, at the line'],
  ['idea --line {line} {file}', 'IntelliJ IDEA, at the line'],
];

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command that opens `file` (at `line`) with `editor`. */
export function editorCommand(editor: string, file: string, line?: number): string {
  if (editor.includes('{file}')) return editor.replaceAll('{file}', quote(file)).replaceAll('{line}', String(line ?? 1));
  return `${editor} ${quote(file)}`;
}

export function resolveFile(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
}

function run(command: string): void {
  const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Opens `file` in the editor; throws when the file is gone. */
export function openInEditor(file: string, editor = 'open', line?: number): void {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  run(editorCommand(editor, file, line));
}

/** Shows `file` in Finder (its folder elsewhere). */
export function revealFile(file: string): void {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  run(process.platform === 'darwin' ? `open -R ${quote(file)}` : `xdg-open ${quote(dirname(file))}`);
}

type FileRef = { path: string; line?: number; tool: string };

// The file a tool call names, and the line it starts at when it says.
export function toolFile(name: string, input: unknown): FileRef | undefined {
  const a = (input ?? {}) as Record<string, unknown>;
  if (['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(name) && typeof a.file_path === 'string') {
    return { path: a.file_path, tool: name, ...(name === 'Read' && Number(a.offset) > 0 && { line: Number(a.offset) }) };
  }
  if (name === 'Patch' && Array.isArray(a.changes) && a.changes.length === 1 && typeof (a.changes[0] as { path?: unknown }).path === 'string') {
    return { path: (a.changes[0] as { path: string }).path, tool: name };
  }
  return undefined;
}

/** The files the tab's tool calls touched, the latest first, each once. */
export function tabFiles(tab: Tab): FileRef[] {
  const seen = new Map<string, FileRef>();
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind !== 'tool_use') continue;
      const f = toolFile(b.name, b.input);
      if (f) {
        seen.delete(f.path);
        seen.set(f.path, f);
      }
      if (b.name === 'Patch' && Array.isArray((b.input as { changes?: unknown })?.changes)) {
        for (const c of (b.input as { changes: Array<{ path?: unknown }> }).changes) {
          if (typeof c.path !== 'string') continue;
          seen.delete(c.path);
          seen.set(c.path, { path: c.path, tool: 'Patch' });
        }
      }
      walk(b.children);
    }
  };
  for (const turn of [...tab.earlier, tab]) walk(turn.blocks);
  return [...seen.values()].reverse();
}

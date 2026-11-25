import { shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// A file from a tool call, opened in config.json's editor or shown in Finder,
// as bindertui's /files does (src/openFile.ts): "open" is the file's default
// app; a command gets the path last, or fills in {file} and {line}.

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function editorCommand(editor: string, file: string, line?: number): string {
  if (editor.includes('{file}')) return editor.replaceAll('{file}', quote(file)).replaceAll('{line}', String(line ?? 1));
  return `${editor} ${quote(file)}`;
}

export async function openPath(path: string, cwd: string, how: 'edit' | 'reveal', editor: string, env: NodeJS.ProcessEnv, line?: number): Promise<void> {
  const file = resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  if (how === 'reveal') return shell.showItemInFolder(file);
  if (editor === 'open') {
    const why = await shell.openPath(file);
    if (why) throw new Error(why);
    return;
  }
  const child = spawn('sh', ['-c', editorCommand(editor, file, line)], { env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

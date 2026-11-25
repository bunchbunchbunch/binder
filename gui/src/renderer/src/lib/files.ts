import type { WireBlock, WireTab } from '@shared/wire';

// The files a tab's tool calls named (bindertui's tabFiles), the latest first.
export type FileRef = { path: string; line?: number; tool: string };

export function tabFiles(tab: WireTab): FileRef[] {
  const seen = new Map<string, FileRef>();
  const add = (f: FileRef) => {
    seen.delete(f.path);
    seen.set(f.path, f);
  };
  const walk = (blocks: WireBlock[]) => {
    for (const b of blocks) {
      if (b.kind !== 'tool_use') continue;
      const a = (b.input ?? {}) as Record<string, unknown>;
      if (['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(b.name) && typeof a.file_path === 'string') {
        add({ path: a.file_path, tool: b.name, ...(b.name === 'Read' && Number(a.offset) > 0 && { line: Number(a.offset) }) });
      }
      if (b.name === 'Patch' && Array.isArray(a.changes)) for (const c of a.changes as Array<{ path?: unknown }>) if (typeof c.path === 'string') add({ path: c.path, tool: 'Patch' });
      walk(b.children);
    }
  };
  for (const turn of [...tab.earlier, tab]) walk(turn.blocks);
  return [...seen.values()].reverse();
}

/** A tool call's path made absolute (bindertui's resolveFile): ~ is home, and a relative path is in the session folder. */
export function resolveFile(path: string, cwd: string, home: string): string {
  const full = path.replace(/^~(?=$|\/)/, home);
  const parts: string[] = [];
  for (const p of (full.startsWith('/') ? full : `${cwd}/${full}`).split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return '/' + parts.join('/');
}

// The file pane's edit box. A textarea reads \r\n as \n, so a file's text goes
// in with \n and comes back out in the file's own line endings.
export const lfText = (text: string) => text.replace(/\r\n/g, '\n');
export const fileEndings = (text: string, file: string) => (file.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);

/**
 * Tab in the edit box (Shift+Tab with `out`): the text to put over [from, to),
 * and the selection after. No selection puts the indent at the caret; a
 * selection indents each line it touches; Shift+Tab takes one indent (a tab,
 * or up to two spaces) off each line. Null: nothing changes.
 */
export function indentEdit(text: string, start: number, end: number, indent: string, out: boolean): { from: number; to: number; insert: string; start: number; end: number } | null {
  if (start === end && !out) return { from: start, to: end, insert: indent, start: start + indent.length, end: start + indent.length };
  const from = start ? text.lastIndexOf('\n', start - 1) + 1 : 0;
  // A selection that ends at a line's start leaves that line alone.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', last);
  const to = nl < 0 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const cut = (line: string) => (line.startsWith('\t') ? 1 : /^ {0,2}/.exec(line)![0].length);
  const insert = lines.map((l) => (out ? l.slice(cut(l)) : l ? indent + l : l)).join('\n');
  if (insert === text.slice(from, to)) return null;
  if (start === end) {
    const caret = Math.max(from, start - cut(lines[0]));
    return { from, to, insert, start: caret, end: caret };
  }
  return { from, to, insert, start: from, end: from + insert.length };
}

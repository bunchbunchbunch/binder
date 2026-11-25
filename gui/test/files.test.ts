import { describe, it, expect } from 'vitest';
import { fileEndings, indentEdit, lfText, resolveFile } from '../src/renderer/src/lib/files';

// Tab and Shift+Tab as the edit box applies them: the text with the change put in, and the selection after.
function press(text: string, start: number, end: number, out = false, indent = '  ') {
  const r = indentEdit(text, start, end, indent, out);
  if (!r) return { text, start, end };
  return { text: text.slice(0, r.from) + r.insert + text.slice(r.to), start: r.start, end: r.end };
}

describe('the file pane', () => {
  const py = 'def f():\n    a = 1\n    b = 2\n    return a + b\n';
  const at = (s: string) => py.indexOf(s);

  it('Tab with no selection puts the indent at the caret', () => {
    expect(press('ab', 1, 1)).toEqual({ text: 'a  b', start: 3, end: 3 });
    expect(press('ab', 1, 1, false, '\t')).toEqual({ text: 'a\tb', start: 2, end: 2 });
  });

  it('Tab with a selection indents each line it touches, keeps them selected, and never deletes them', () => {
    // Lines 2-3, the selection ending at line 4's start.
    const r = press(py, at('    a = 1'), at('    return'));
    expect(r.text).toBe('def f():\n      a = 1\n      b = 2\n    return a + b\n');
    expect(r.text.slice(r.start, r.end)).toBe('      a = 1\n      b = 2');
    // Part of one line indents that line.
    expect(press(py, at('a = 1'), at('a = 1') + 1).text).toBe('def f():\n      a = 1\n    b = 2\n    return a + b\n');
    // From the very start; empty lines get no trailing spaces.
    expect(press('a\n\nb', 0, 4).text).toBe('  a\n\n  b');
    expect(press('\tx\n\ty', 0, 5, false, '\t').text).toBe('\t\tx\n\t\ty');
  });

  it('Shift+Tab takes one indent off each selected line, or the caret line', () => {
    const r = press(py, at('    a = 1'), at('    return'), true);
    expect(r.text).toBe('def f():\n  a = 1\n  b = 2\n    return a + b\n');
    expect(r.text.slice(r.start, r.end)).toBe('  a = 1\n  b = 2');
    expect(press('\t\tx\n\ty\nz', 0, 7, true)).toEqual({ text: '\tx\ny\nz', start: 0, end: 4 });
    // No selection: the caret's line, the caret moving with its text.
    expect(press('x\n   y', 5, 5, true)).toEqual({ text: 'x\n y', start: 3, end: 3 });
    expect(press('x\n  y', 3, 3, true)).toEqual({ text: 'x\ny', start: 2, end: 2 });
    // Nothing to take off: no change.
    expect(indentEdit('x\ny', 0, 3, '  ', true)).toBeNull();
  });

  it('edits a CRLF file with \\n and saves it with \\r\\n; an LF file stays LF', () => {
    const win = 'alpha\r\nbeta\r\n';
    expect(lfText(win)).toBe('alpha\nbeta\n');
    expect(fileEndings('#alpha\nbeta\n', win)).toBe('#alpha\r\nbeta\r\n');
    expect(fileEndings(lfText(win), win)).toBe(win);
    expect(fileEndings('a\nb\n', 'x\ny\n')).toBe('a\nb\n');
  });

  it("/files copies a tool call's path made absolute, as bindertui does", () => {
    expect(resolveFile('/abs/a.ts', '/w/app', '/Users/me')).toBe('/abs/a.ts');
    expect(resolveFile('src/a.ts', '/w/app', '/Users/me')).toBe('/w/app/src/a.ts');
    expect(resolveFile('./src/../b.ts', '/w/app', '/Users/me')).toBe('/w/app/b.ts');
    expect(resolveFile('~/notes.md', '/w/app', '/Users/me')).toBe('/Users/me/notes.md');
    expect(resolveFile('~x/notes.md', '/w/app', '/Users/me')).toBe('/w/app/~x/notes.md');
  });
});

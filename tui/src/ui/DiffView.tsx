import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { diffRows, sessionDiff, type SessionDiff } from '../gitDiff.js';
import { styled } from './md/theme.js';
import { clean, truncate } from './md/text.js';
import { findingRows } from './toolView.js';
import { samePath, type Finding } from '../findings.js';

// /diff: the session's changes in place of the transcript, every file in
// turn: its working tree against `base` (HEAD, or a branch). Up/Down and
// PgUp/PgDn scroll, n/p jump to the next/previous file, Esc closes. The latest
// code review's findings show under their lines (or their file's name, for a
// line the diff does not show).

const ADD = { fg: '#61AFEF' };
const DEL = { fg: '#D19A66' };
const DIM = { fg: '#7F848E' };
const FILE = { fg: '#C9A0FF', bold: true };

function render(diff: SessionDiff, width: number, findings: Finding[]): { lines: string[]; files: number[] } {
  const lines: string[] = [];
  const files: number[] = [];
  // Under its line, a finding needs no place; above the file's rows, its line.
  const note = (fs: Finding[], place = false) => findingRows(fs, Math.max(10, width - 8), false, place).map((l) => '      ▲ ' + l);
  for (const f of diff.files) {
    files.push(lines.length);
    lines.push(styled(`▸ ${clean(f.path)}`, FILE) + styled(`  ${f.status}${f.cut ? ', cut short' : ''}`, DIM));
    const rows = diffRows(f.patch);
    const mine = findings.filter((x) => samePath(x.file, f.path));
    const shown = new Set(rows.filter((r) => r.kind !== 'del' && r.new !== undefined).map((r) => r.new));
    lines.push(...note(mine.filter((x) => !x.line || !shown.has(x.line)), true));
    for (const r of rows) {
      const num = String(r.new ?? r.old ?? '').padStart(5);
      if (r.kind === 'hunk') lines.push(styled(`  ⋯ ${clean(r.text)}`, DIM));
      else if (r.kind === 'note') lines.push(styled(`  ${clean(r.text)}`, DIM));
      else {
        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
        const style = r.kind === 'add' ? ADD : r.kind === 'del' ? DEL : DIM;
        lines.push(styled(num + ' ', DIM) + styled(truncate(`${sign} ${clean(r.text)}`, Math.max(10, width - 8)), style));
        if (r.kind !== 'del') lines.push(...note(mine.filter((x) => x.line === r.new)));
      }
    }
    lines.push('');
  }
  return { lines, files };
}

export function DiffView({ cwd, base, onClose, findings = [] }: { cwd: string; base?: string; onClose: () => void; findings?: Finding[] }) {
  const { columns, rows } = useWindowSize();
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  useEffect(() => {
    sessionDiff(cwd, base).then(setDiff, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [cwd, base]);
  const view = useMemo(() => (diff ? render(diff, columns - 2, findings) : { lines: [], files: [] }), [diff, columns, findings]);
  // What is left of the screen once the tab bar, prompt and status rows have theirs.
  const height = Math.max(5, rows - 10);
  const max = Math.max(0, view.lines.length - height);
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.downArrow) setTop((t) => Math.min(max, t + 1));
    else if (key.upArrow) setTop((t) => Math.max(0, t - 1));
    else if (key.pageDown) setTop((t) => Math.min(max, t + height - 2));
    else if (key.pageUp) setTop((t) => Math.max(0, t - height + 2));
    else if (input === 'n') setTop((t) => Math.min(max, view.files.find((f) => f > t) ?? t));
    else if (input === 'p') setTop((t) => [...view.files].reverse().find((f) => f < t) ?? 0);
  });
  const head = error
    ? error
    : !diff
      ? 'reading the changes…'
      : `${diff.files.length} file${diff.files.length === 1 ? '' : 's'} changed against ${diff.base} · ↑↓ PgUp/PgDn scroll · n/p next/previous file · esc closes`;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor wrap="truncate-end">{head}</Text>
      {diff && !diff.files.length ? <Text dimColor>No changes.</Text> : null}
      <Text>{view.lines.slice(top, top + height).join('\n')}</Text>
    </Box>
  );
}

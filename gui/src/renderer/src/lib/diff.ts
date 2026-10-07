// Line diff for Edit tool calls: an LCS over lines, shown with a little
// context (bindertui src/ui/diff.ts). Inputs are one edit, so O(n*m) is fine.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };
export type DiffRow = DiffLine | { kind: 'skip'; count: number };

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Changed lines plus `context` unchanged lines around them; the rest collapse into skips. */
export function withContext(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipping = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipping) out.push({ kind: 'skip', count: skipping });
      skipping = 0;
      out.push(l);
    } else skipping++;
  });
  if (skipping) out.push({ kind: 'skip', count: skipping });
  return out;
}

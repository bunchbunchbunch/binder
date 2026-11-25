// A code review's findings (/code-review): what each says is wrong, where, and
// how bad, for the findings card (config.json findingsCard), /findings, and
// /diff. Claude Code reports them three ways: the ReportFindings tool; at
// medium effort and up, a forked review whose JSON Claude Code turns into text
// ("4 findings (…):" then "1. 🔴 Important `file:line`: …", each with its
// "Failure scenario:"); at low effort, one line each from the model
// ("file:line", a dash, "important", a dash, "what. Fix: …").

export type Severity = 'important' | 'pre_existing' | 'nit';
export type Finding = { file: string; line?: number; severity?: Severity; summary: string; scenario?: string };

export const SEVERITIES: Severity[] = ['important', 'pre_existing', 'nit'];
export const severityName = (s?: Severity): string => (s === 'pre_existing' ? 'pre-existing' : (s ?? ''));

function severityOf(v: unknown): Severity | undefined {
  const k = String(v ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return (SEVERITIES as string[]).includes(k) ? (k as Severity) : undefined;
}

const LABEL: Record<string, Severity> = { '🔴 Important': 'important', '🟣 Pre-existing': 'pre_existing', '🟡 Nit': 'nit' };

// "src/a.ts:12" → file and line; a path alone has no line.
function place(at: string): { file: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(at.trim());
  return m ? { file: m[1], line: Number(m[2]) } : { file: at.trim() };
}

/** ReportFindings' input: `{findings: [{file, line, summary, failure_scenario, severity}]}`. */
export function reportedFindings(input: unknown): Finding[] {
  const list = (input as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((f: Record<string, unknown>) => {
    if (!f || typeof f.file !== 'string' || typeof f.summary !== 'string') return [];
    const line = Number(f.line);
    return [{ file: f.file, ...(line > 0 && { line }), severity: severityOf(f.severity), summary: f.summary.trim(), ...(typeof f.failure_scenario === 'string' && f.failure_scenario.trim() && { scenario: f.failure_scenario.trim() }) }];
  });
}

/** The findings in a review's text, in either of Claude Code's shapes; null when it has none. */
export function findingsInText(text: string): Finding[] | null {
  // Claude Code's own: a header, then numbered items whose later lines are indented.
  if (/^\d+ findings?\b[^\n]*:\s*$/m.test(text)) {
    const items = text.split(/^(?=\d+\. )/m).slice(1);
    const out = items.flatMap((item) => {
      const lines = item.replace(/\s+$/, '').split('\n');
      const pad = /^\d+\. /.exec(lines[0])![0].length;
      const body = [lines[0].slice(pad), ...lines.slice(1).map((l) => l.replace(new RegExp(`^ {0,${pad}}`), ''))].join('\n');
      const m = /^(?:(🔴 Important|🟣 Pre-existing|🟡 Nit) )?`([^`]+)`: ([\s\S]*)$/u.exec(body);
      if (!m) return [];
      const [summary, scenario] = m[3].split(/\n\s*Failure scenario: /);
      return [{ ...place(m[2]), severity: m[1] ? LABEL[m[1]] : undefined, summary: summary.trim(), ...(scenario?.trim() && { scenario: scenario.trim() }) }];
    });
    return out.length ? out : null;
  }
  // The low effort review's lines.
  const out: Finding[] = [];
  for (const l of text.split('\n')) {
    const m = /^\s*(?:[-*]\s+|\d+\.\s+)?`?([^\s`]+?:\d+)`?\s+[—–-]+\s+\**(important|pre[_-]existing|nit)\**\s+[—–-]+\s+(.+)$/i.exec(l);
    if (m) out.push({ ...place(m[1]), severity: severityOf(m[2]), summary: m[3].trim() });
  }
  return out.length ? out : null;
}

// Enough of a block (bindertui's or the wire's) to find findings in.
type BlockLike = { kind: string; final: boolean; text?: string; name?: string; input?: unknown };
type TurnLike<B extends BlockLike = BlockLike> = { prompt: string; blocks: B[] };

// A turn that ran the review: "/code-review …", or Claude calling its skill.
function isReview(turn: TurnLike): boolean {
  return /^\/code-review\b/.test(turn.prompt.trim()) || turn.blocks.some((b) => b.kind === 'tool_use' && b.name === 'Skill' && (b.input as { skill?: unknown } | undefined)?.skill === 'code-review');
}

/** A turn's findings and the block they came from (its latest ReportFindings call, or the review's text). */
export function turnFindings<B extends BlockLike>(turn: TurnLike<B>): { block: B; findings: Finding[]; fromText: boolean } | null {
  const review = isReview(turn);
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i];
    if (!b.final) continue;
    if (b.kind === 'tool_use' && b.name === 'ReportFindings') {
      const findings = reportedFindings(b.input);
      if (findings.length) return { block: b, findings, fromText: false };
    }
    if (review && b.kind === 'text' && b.text) {
      const findings = findingsInText(b.text);
      if (findings) return { block: b, findings, fromText: true };
    }
  }
  return null;
}

/** The findings /findings and /diff work on, and the tab they came from: the active tab's latest, else the newest tab's. */
export function tabsFindings(tabs: Array<TurnLike & { id: number; earlier: TurnLike[] }>, active: number): { tabId: number; findings: Finding[] } | null {
  const order = [tabs[active], ...tabs.filter((_, i) => i !== active).reverse()].filter(Boolean);
  for (const tab of order) {
    const findings = latestFindings([...tab.earlier, tab]);
    if (findings) return { tabId: tab.id, findings };
  }
  return null;
}

/** The latest findings among `turns` (oldest first). */
export function latestFindings(turns: TurnLike[]): Finding[] | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const found = turnFindings(turns[i]);
    if (found) return found.findings;
  }
  return null;
}

const where = (f: Finding) => (f.line ? `${f.file}:${f.line}` : f.file);

function described(f: Finding): string {
  return `${where(f)}${f.severity ? ` (${severityName(f.severity)})` : ''}: ${f.summary}${f.scenario ? `\nFailure scenario: ${f.scenario}` : ''}`;
}

/** "Fix this one": the prompt for one finding. */
export function fixPrompt(f: Finding): string {
  return `Fix this finding from the code review:\n\n${described(f)}`;
}

/** "Apply fixes": the prompt for every finding. */
export function fixAllPrompt(findings: Finding[]): string {
  if (findings.length === 1) return fixPrompt(findings[0]);
  const items = findings.map((f, i) => `${i + 1}. ${described(f).replace(/\n/g, '\n   ')}`);
  return `Fix these findings from the code review, most severe first:\n\n${items.join('\n\n')}`;
}

/** "calc.js:3"; the place a finding names. */
export const findingPlace = where;

/** Does a finding's file name this diff path (relative to the repo)? Findings name files from the repo root, the session folder, or in full. */
export function samePath(finding: string, path: string): boolean {
  const f = finding.replace(/^\.\//, '');
  return f === path || f.endsWith('/' + path) || path.endsWith('/' + f);
}

/** "2 important, 1 nit". */
export function severityCounts(findings: Finding[]): string {
  return SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${severityName(s)}`)
    .join(', ');
}

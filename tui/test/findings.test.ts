import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingsInText, fixAllPrompt, fixPrompt, reportedFindings, samePath, severityCounts, tabsFindings, turnFindings } from '../src/findings.js';
import { FIXTURES } from './helpers.js';

// Claude Code's text for a forked review (recorded: /code-review medium on a two-bug diff).
const forked = readFileSync(join(FIXTURES, 'code-review.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((m) => m.type === 'assistant' && m.parent_tool_use_id === null && m.local_command_source).message.content[0].text as string;

// The low effort review's lines, as a model wrote them (with hyphens, not the dashes asked for).
const low = "calc.js:3 - important - The loop is off by one: it starts at `i = 1`. Fix: restore `for (const x of xs) sum += x;`.\n\ncalc.js:7 — nit — `max` starts at 0. Fix: start from `xs[0]`.";

const text = (t: string) => ({ kind: 'text', text: t, final: true });

describe('code review findings', () => {
  it("reads Claude Code's text for a forked review: severity, place, summary and failure scenario", () => {
    const f = findingsInText(forked)!;
    expect(f).toHaveLength(4);
    expect(f.map((x) => [x.severity, x.file, x.line])).toEqual([
      ['important', 'calc.js', 3],
      ['important', 'calc.js', 7],
      ['pre_existing', 'calc.js', 4],
      ['nit', 'calc.js', 7],
    ]);
    expect(f[0].summary).toMatch(/^average\(\) returns NaN for every non-empty array\. .* Fix: restore the original iteration/s);
    expect(f[0].summary).not.toContain('Failure scenario');
    expect(f[0].scenario).toBe('average([2, 4, 6]) → sum is 4 + 6 + undefined = NaN, so the result is NaN instead of 4. The original code returned 4.');
    expect(severityCounts(f)).toBe('2 important, 1 pre-existing, 1 nit');
    expect(findingsInText('1 finding:\n\n1. `src/a.ts`: The file is gone.')).toEqual([{ file: 'src/a.ts', severity: undefined, summary: 'The file is gone.' }]);
    expect(findingsInText('Code review found no issues.')).toBeNull();
  });

  it("reads the low effort review's one line per finding, and ReportFindings' input", () => {
    expect(findingsInText(low)).toEqual([
      { file: 'calc.js', line: 3, severity: 'important', summary: 'The loop is off by one: it starts at `i = 1`. Fix: restore `for (const x of xs) sum += x;`.' },
      { file: 'calc.js', line: 7, severity: 'nit', summary: '`max` starts at 0. Fix: start from `xs[0]`.' },
    ]);
    expect(reportedFindings({ findings: [{ file: 'a.ts', line: 2, summary: ' Wrong. ', failure_scenario: 'x → y', severity: 'Pre-existing' }, { file: 'b.ts', summary: 'No line.' }, { summary: 'no file' }] })).toEqual([
      { file: 'a.ts', line: 2, severity: 'pre_existing', summary: 'Wrong.', scenario: 'x → y' },
      { file: 'b.ts', severity: undefined, summary: 'No line.' },
    ]);
  });

  it("finds them only in a review's turn (or ReportFindings anywhere), latest first, once final", () => {
    expect(turnFindings({ prompt: '/code-review medium', blocks: [text(forked)] })?.findings).toHaveLength(4);
    expect(turnFindings({ prompt: 'explain this output', blocks: [text(forked)] })).toBeNull();
    expect(turnFindings({ prompt: 'review my change', blocks: [{ kind: 'tool_use', name: 'Skill', input: { skill: 'code-review' }, final: true }, text(low)] })?.findings).toHaveLength(2);
    expect(turnFindings({ prompt: '/code-review', blocks: [{ ...text(low), final: false }] })).toBeNull();
    const report = { kind: 'tool_use', name: 'ReportFindings', input: { findings: [{ file: 'a.ts', line: 1, summary: 'Bad.' }] }, final: true };
    expect(turnFindings({ prompt: 'anything', blocks: [report, text('Done.')] })).toMatchObject({ block: report, fromText: false, findings: [{ file: 'a.ts' }] });
    // The active tab's review, else the newest tab's.
    const tab = (id: number, prompt: string, blocks: object[]) => ({ id, prompt, blocks: blocks as never[], earlier: [] });
    const tabs = [tab(1, '/code-review', [text(low)]), tab(2, 'hi', [text('hello')]), tab(3, '/code-review', [text(forked)])];
    expect(tabsFindings(tabs, 0)?.tabId).toBe(1);
    expect(tabsFindings(tabs, 1)?.tabId).toBe(3);
    expect(tabsFindings([tabs[1]], 0)).toBeNull();
  });

  it('asks Claude to fix one with its place, severity and failure scenario, or all in one prompt', () => {
    const f = findingsInText(forked)!;
    expect(fixPrompt(f[0])).toBe(`Fix this finding from the code review:\n\ncalc.js:3 (important): ${f[0].summary}\nFailure scenario: ${f[0].scenario}`);
    const all = fixAllPrompt(f);
    expect(all).toMatch(/^Fix these findings from the code review, most severe first:\n\n1\. calc\.js:3 \(important\): /);
    expect(all).toContain('\n   Failure scenario: average([2, 4, 6])');
    expect(all).toContain('\n\n4. calc.js:7 (nit): ');
    expect(samePath('calc.js', 'calc.js')).toBe(true);
    expect(samePath('./src/a.ts', 'src/a.ts')).toBe(true);
    expect(samePath('/Users/me/code/app/src/a.ts', 'src/a.ts')).toBe(true);
    expect(samePath('a.ts', 'src/a.ts')).toBe(true);
    expect(samePath('b.ts', 'src/a.ts')).toBe(false);
  });
});

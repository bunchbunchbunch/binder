import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowLine, workflowMeta, workflowRun } from '../src/workflow.js';
import { FIXTURES } from './helpers.js';

const fixture = readFileSync(join(FIXTURES, 'workflow.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('workflows', () => {
  it("reads a script's meta: name, description and phase titles", () => {
    const script = fixture[1].message.content[0].input.script;
    expect(workflowMeta(script)).toEqual({ name: 'hello-probe', description: 'Single agent call that replies with one word', phases: ['Greet', 'Check'] });
    expect(workflowMeta('return 1')).toEqual({ phases: [] });
    // On one line; a ] or } in a string; comments, quoted keys and a trailing comma.
    expect(workflowMeta("export const meta = { name: 'one-liner', description: 'All on one line', phases: [{ title: 'A' }, { title: 'B' }] }\nphase('A')\n")).toEqual({ name: 'one-liner', description: 'All on one line', phases: ['A', 'B'] });
    expect(workflowMeta(`export const meta = {\n  name: "brackets", // the name\n  phases: [\n    { title: 'Read', detail: 'files [a] and {b}' },\n    /* next */ { "title": \`Fix\`, },\n  ],\n}\n`)).toEqual({ name: 'brackets', phases: ['Read', 'Fix'] });
    expect(workflowMeta('export const meta = { name: NAME }')).toEqual({ phases: [] });
    expect(workflowMeta(undefined)).toEqual({ phases: [] });
  });

  it("keeps a run's phases and agents, and says where it is", () => {
    const start = workflowRun(fixture.find((l) => l.subtype === 'task_progress').workflow_progress)!;
    expect(start).toEqual({ phases: ['Greet'], agents: [{ label: 'Reply with the single word ok', phase: 'Greet', state: 'start', model: 'claude-haiku-5-5' }] });
    expect(workflowLine(start)).toBe('Greet · 0/1 agents done');
    const done = workflowRun(fixture.filter((l) => l.subtype === 'task_progress')[1].workflow_progress)!;
    expect(done.agents[0]).toMatchObject({ state: 'done', durationMs: 1106, result: 'ok', tokens: 26340 });
    expect(workflowLine(done)).toBe('Greet · 1/1 agents done');
    expect(workflowRun([])).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { currentPlan, sessionChecklist } from '../src/checklist.js';
import type { Block, Tab } from '../src/store.js';

let n = 0;
const call = (name: string, input: unknown, result?: string, isError = false): Block => ({ kind: 'tool_use', id: `t${n++}`, name, input, inputJson: '', final: true, children: [], ...(result !== undefined && { result: { content: result, isError } }) });
const tab = (id: number, ...blocks: Block[]): Tab => ({ id, prompt: 'p', status: 'done', blocks, earlier: [], seq: id });

describe('the pinned checklist', () => {
  it('is the latest TodoWrite list', () => {
    const list = sessionChecklist([
      tab(1, call('TodoWrite', { todos: [{ content: 'old', status: 'pending' }] })),
      tab(2, call('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }] })),
    ]);
    expect(list).toEqual({ source: 'todos', items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress', active: 'Doing b' }] });
  });

  it('follows the Task tools by the number each task got, and their updates and deletions', () => {
    const list = sessionChecklist([
      tab(1, call('TaskCreate', { subject: 'Write tests' }, 'Task #1 created successfully: Write tests'), call('TaskCreate', { subject: 'Ship' }, 'Task #2 created successfully: Ship'), call('TaskCreate', { subject: 'Oops' }, 'Task #3 created successfully: Oops')),
      tab(2, call('TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status'), call('TaskUpdate', { taskId: '3', status: 'deleted' }, 'Updated task #3 deleted'), call('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Ship it' }, 'Updated task #2 status, subject')),
    ]);
    expect(list).toEqual({ source: 'tasks', items: [{ text: 'Write tests', status: 'completed' }, { text: 'Ship it', status: 'in_progress' }] });
  });

  it('shows whichever Claude touched last, and nothing before either', () => {
    expect(sessionChecklist([tab(1, call('Bash', { command: 'ls' }))])).toBeNull();
    const both = [tab(1, call('TaskCreate', { subject: 'T' }, 'Task #1 created successfully: T')), tab(2, call('TodoWrite', { todos: [{ content: 'W', status: 'pending' }] }))];
    expect(sessionChecklist(both)?.source).toBe('todos');
  });

  it('knows the latest plan and whether it was approved', () => {
    expect(currentPlan([tab(1, call('Bash', {}))])).toBeNull();
    const plan = currentPlan([tab(1, call('ExitPlanMode', { plan: '# One' }, 'User has approved your plan.')), tab(2, call('ExitPlanMode', { plan: '# Two' }, 'kept planning', true))]);
    expect(plan).toMatchObject({ plan: '# Two', tabId: 2, answered: true, approved: false });
  });
});

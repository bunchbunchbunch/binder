import type { ToolBlock, WireTab, WireTurn } from '@shared/wire';

// The pinned panel's content (bindertui's src/checklist.ts): the session's
// latest todo list, from TodoWrite or the Task tools, whichever Claude touched
// last, and its current plan (the latest ExitPlanMode).

export type CheckItem = { text: string; status: 'pending' | 'in_progress' | 'completed'; active?: string };
export type Checklist = { items: CheckItem[]; source: 'todos' | 'tasks' };
export type CurrentPlan = { plan: string; tabId: number; toolUseId: string; answered: boolean; approved: boolean };

// Every top-level tool call, in the order the turns were sent (a follow-up into
// an older tab comes after a newer tab's turns). An older host sends no seq:
// then tabs go in creation order and their turns in order.
function calls(tabs: WireTab[]): Array<{ block: ToolBlock; tabId: number }> {
  const turns: Array<{ turn: WireTurn; tabId: number; at: number }> = [];
  for (const tab of tabs) [...tab.earlier, tab].forEach((turn, i) => turns.push({ turn, tabId: tab.id, at: turn.seq ?? tab.id * 1000 + i }));
  turns.sort((a, b) => a.at - b.at);
  return turns.flatMap(({ turn, tabId }) => turn.blocks.filter((b): b is ToolBlock => b.kind === 'tool_use').map((block) => ({ block, tabId })));
}

const STATUSES = ['pending', 'in_progress', 'completed'];
const status = (s: unknown): CheckItem['status'] => (STATUSES.includes(s as string) ? (s as CheckItem['status']) : 'pending');

export function sessionChecklist(tabs: WireTab[]): Checklist | null {
  let todos: CheckItem[] | null = null;
  const tasks = new Map<string, CheckItem>();
  let last: Checklist['source'] | null = null;
  for (const { block } of calls(tabs)) {
    const a = (block.input ?? {}) as Record<string, unknown>;
    if (block.name === 'TodoWrite' && Array.isArray(a.todos)) {
      todos = (a.todos as Array<Record<string, unknown>>).map((t) => ({ text: String(t.content ?? ''), status: status(t.status), ...(typeof t.activeForm === 'string' && { active: t.activeForm }) }));
      last = 'todos';
    } else if (block.name === 'TaskCreate' && block.result && !block.result.isError) {
      const id = /Task #(\w+) created/.exec(block.result.content)?.[1];
      if (!id) continue;
      tasks.set(id, { text: String(a.subject ?? ''), status: 'pending', ...(typeof a.activeForm === 'string' && { active: a.activeForm }) });
      last = 'tasks';
    } else if (block.name === 'TaskUpdate' && block.result && !block.result.isError) {
      const id = String(a.taskId ?? '');
      const task = tasks.get(id);
      if (!task) continue;
      if (a.status === 'deleted') tasks.delete(id);
      else tasks.set(id, { ...task, ...(typeof a.subject === 'string' && { text: a.subject }), ...(a.status !== undefined && { status: status(a.status) }), ...(typeof a.activeForm === 'string' && { active: a.activeForm }) });
      last = 'tasks';
    }
  }
  if (last === 'todos' && todos?.length) return { items: todos, source: 'todos' };
  if (last === 'tasks' && tasks.size) return { items: [...tasks.values()], source: 'tasks' };
  return null;
}

export function currentPlan(tabs: WireTab[]): CurrentPlan | null {
  const last = calls(tabs)
    .filter(({ block }) => block.name === 'ExitPlanMode' && typeof (block.input as { plan?: unknown })?.plan === 'string')
    .at(-1);
  if (!last) return null;
  const r = last.block.result;
  return { plan: (last.block.input as { plan: string }).plan, tabId: last.tabId, toolUseId: last.block.id, answered: Boolean(r), approved: Boolean(r && !r.isError) };
}

export function planTitle(plan: string): string {
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => l.startsWith('#')) ?? lines[0] ?? 'Plan').replace(/^#+\s*/, '');
}

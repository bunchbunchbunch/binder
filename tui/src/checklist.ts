import type { Block, Tab, Turn } from './store.js';

// What the pinned panel shows: the session's latest todo list and its
// current plan. Claude keeps todos with TodoWrite (the whole list each time;
// Codex's plan updates come as TodoWrite too) or with the Task tools
// (TaskCreate adds one and says its number, TaskUpdate changes one). The
// list is whichever Claude touched last. Subagents' lists are their own.

export type CheckItem = { text: string; status: 'pending' | 'in_progress' | 'completed'; active?: string };
export type Checklist = { items: CheckItem[]; source: 'todos' | 'tasks' };
export type CurrentPlan = { plan: string; tabId: number; toolUseId: string; answered: boolean; approved: boolean };

type Call = { block: Extract<Block, { kind: 'tool_use' }>; tabId: number };

// Every top-level tool call, in the order the turns were sent.
function calls(tabs: Tab[]): Call[] {
  const turns: Array<{ turn: Turn; tabId: number; at: number }> = [];
  for (const tab of tabs) [...tab.earlier, tab].forEach((turn, i) => turns.push({ turn, tabId: tab.id, at: turn.seq ?? tab.id * 1000 + i }));
  turns.sort((a, b) => a.at - b.at);
  return turns.flatMap(({ turn, tabId }) => turn.blocks.filter((b): b is Call['block'] => b.kind === 'tool_use').map((block) => ({ block, tabId })));
}

const STATUSES = ['pending', 'in_progress', 'completed'];
const status = (s: unknown): CheckItem['status'] => (STATUSES.includes(s as string) ? (s as CheckItem['status']) : 'pending');

export function sessionChecklist(tabs: Tab[]): Checklist | null {
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

/** The latest plan Claude asked to start on (ExitPlanMode), and whether it was answered and approved. */
export function currentPlan(tabs: Tab[]): CurrentPlan | null {
  const plans = calls(tabs).filter(({ block }) => block.name === 'ExitPlanMode' && typeof (block.input as { plan?: unknown })?.plan === 'string');
  const last = plans.at(-1);
  if (!last) return null;
  const r = last.block.result;
  return { plan: (last.block.input as { plan: string }).plan, tabId: last.tabId, toolUseId: last.block.id, answered: Boolean(r), approved: Boolean(r && !r.isError) };
}

/** "2/5" and the item being worked on, for the one-line summary. */
export function checklistSummary(list: Checklist): { done: number; total: number; now?: CheckItem } {
  return { done: list.items.filter((i) => i.status === 'completed').length, total: list.items.length, now: list.items.find((i) => i.status === 'in_progress') };
}

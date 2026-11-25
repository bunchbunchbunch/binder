import { useEffect, useMemo, useState } from 'react';
import type { ToolBlock, WireTab } from '@shared/wire';
import { currentPlan, planTitle, sessionChecklist } from '../lib/checklist';
import { request } from '../store';
import { Markdown } from './Markdown';

// Above the prompt (config.json todoPanel): the session's latest todo list and
// its current plan, one line each until opened (a click, or Ctrl+T for both).

const MARK = { completed: '☑', in_progress: '◐', pending: '☐' } as const;

// A plan longer than the wire carries comes whole from the host.
const CUT = /… \[\d+ more characters\]$/;

export function Pinned({ conn, tabs, open, onToggle }: { conn: string; tabs: WireTab[]; open: boolean; onToggle: () => void }) {
  const list = useMemo(() => sessionChecklist(tabs), [tabs]);
  const plan = useMemo(() => currentPlan(tabs), [tabs]);
  const [planOpen, setPlanOpen] = useState(false);
  const [full, setFull] = useState<{ id: string; plan: string } | null>(null);
  const showPlan = open || planOpen;
  useEffect(() => {
    if (!plan || !showPlan || !CUT.test(plan.plan) || full?.id === plan.toolUseId) return;
    request(conn, 'tool_detail', { tabId: plan.tabId, toolUseId: plan.toolUseId })
      .then((r) => setFull({ id: plan.toolUseId, plan: String(((r.block as ToolBlock).input as { plan?: unknown }).plan ?? plan.plan) }))
      .catch(() => {});
  }, [plan?.toolUseId, showPlan]);
  const listShown = list && (open || list.items.some((i) => i.status !== 'completed'));
  if (!listShown && !plan) return null;
  const done = list ? list.items.filter((i) => i.status === 'completed').length : 0;
  const now = list?.items.find((i) => i.status === 'in_progress');
  const text = plan && full?.id === plan.toolUseId ? full.plan : plan?.plan;
  return (
    <div className="pinned">
      {listShown && list && (
        <div className="pinned-todos">
          <button className="pinned-head" onClick={onToggle} title="Ctrl+T opens or closes the todos and the plan">
            <span className="chev">{open ? '▾' : '▸'}</span> Todos {done}/{list.items.length}
            {!open && now && <span className="now"> · ◐ {now.active ?? now.text}</span>}
          </button>
          {open && (
            <ul className="todos pinned-list">
              {list.items.map((item, i) => (
                <li key={i} className={item.status}>
                  <span className="mark">{MARK[item.status]}</span> {item.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {plan && (
        <div className="pinned-plan">
          <button className="pinned-head" onClick={() => setPlanOpen(!showPlan)}>
            <span className="chev">{showPlan ? '▾' : '▸'}</span> Plan: {planTitle(plan.plan)}
            <span className="dim"> · {plan.approved ? 'approved' : plan.answered ? 'kept planning' : 'waiting for you'}</span>
          </button>
          {showPlan && text && (
            <div className="pinned-plan-body">
              <Markdown text={text} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

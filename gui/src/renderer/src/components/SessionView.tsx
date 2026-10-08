import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@shared/api';
import { localCommand, visibleCommands, type LocalCommandName } from '../lib/commands';
import { elapsed, plural, shortPath } from '../lib/format';
import { turnVerb } from '../lib/work';
import { closeConn, errText, getState, openSession, reopen, request, setActiveTab, setState, toast, useApp, type Conn } from '../store';
import type { BackgroundTask } from '@shared/wire';
import { ConfirmPanel } from './Picker';
import { ArtifactsPanel, ChromePanel, EffortPanel, McpPanel, ModelPanel, openLatestArtifact, RewindPanel } from '../panels/SessionPanels';
import { Composer, type ComposerHandle } from './Composer';
import { QuestionCard } from './QuestionCard';
import { HelpView } from './Shortcuts';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';
import { PromptText, Transcript, type PendingPrompt } from './Transcript';
import { Welcome } from './Welcome';

// One session: its tabs, the active tab's transcript, the status row, the
// prompt (or a question in its place), and binder's panels. While it is the
// session on screen it takes the TUI's keys.

type Panel = { kind: 'model' | 'effort' | 'mcp' | 'chrome' | 'rewind' | 'artifacts' } | { kind: 'confirm'; title: string; question: string; yes: string; onYes: () => void };

const DOUBLE_ESC_MS = 600;

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

type Props = {
  conn: Conn;
  visible: boolean;
  // A window-wide panel (session switcher, new session) has the keys.
  appPanelOpen: boolean;
  onSwitcher: (scope: 'folder' | 'all') => void;
  onSettings: () => void;
};

export function SessionView({ conn: c, visible, appPanelOpen, onSwitcher, onSettings }: Props) {
  const s = c.state;
  const detail = useApp((st) => st.detail);
  const sticky = useApp((st) => st.stickyPrompt);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [help, setHelp] = useState(false);
  // The queued prompt (by tab and text) the composer is editing.
  const [editing, setEditing] = useState<{ tabId: number; prompt: string } | null>(null);
  // Ctrl+E per tab, until the turn's automatic state changes (as in the TUI).
  const [overrides, setOverrides] = useState<Record<number, { value: boolean; auto: boolean }>>({});
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const lastEsc = useRef(0);

  // The active tab; while a just-sent prompt's tab has not arrived yet (it
  // comes with the host's next patch), the one shown before stays.
  const shown = useRef<number | null>(null);
  const tab = s?.tabs.find((t) => t.id === c.activeTab) ?? s?.tabs.find((t) => t.id === shown.current) ?? s?.tabs.at(-1) ?? null;
  shown.current = tab?.id ?? null;
  const questionPending = Boolean(s?.question && s.running === tab?.id);
  const auto = tab?.status === 'running' && !questionPending;
  const o = tab ? overrides[tab.id] : undefined;
  const expanded = o && o.auto === auto ? o.value : auto;
  const expandEarlier = Boolean(o && o.auto === auto && o.value);
  const busy = Boolean(s && (s.running !== null || s.queue.length > 0 || s.steer));

  // When the running turn started, for the status row's timer.
  const runningId = s?.running ?? null;
  const started = useRef<{ id: number | null; at: number }>({ id: null, at: 0 });
  if (started.current.id !== runningId) started.current = { id: runningId, at: Date.now() };
  // And background tasks' timers.
  const ticking = runningId !== null || Boolean(s?.backgroundTasks?.length);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // Follow the bottom while output streams, until the user scrolls up.
  const toBottom = () => {
    const el = scroller.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toBottom);

  // The sticky prompt (config.json stickyPrompt), as in the TUI: the tab's
  // latest prompt, held under the tabs in place of the transcript's. Its
  // first 3 lines; Home or a click shows it whole, until the next scroll.
  const pinned = sticky && tab && !help ? tab : null;
  const [full, setFull] = useState(false);
  const [cut, setCut] = useState(0);
  const pinnedText = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const p = pinnedText.current;
    if (!p) return;
    // Lines the three cut off.
    const measure = () => setCut(full ? 0 : Math.round((p.scrollHeight - p.clientHeight) / parseFloat(getComputedStyle(p).lineHeight)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    return () => ro.disconnect();
  }, [pinned?.prompt, full]);

  useEffect(() => {
    if (!content.current) return;
    const ro = new ResizeObserver(toBottom);
    ro.observe(content.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    follow.current = true;
    setFull(false);
    toBottom();
  }, [c.activeTab, tab?.status === 'running']);

  const pending = useMemo(() => {
    const list: PendingPrompt[] = [];
    if (!s || !tab) return list;
    if (s.steer && s.steer.tabId === tab.id) list.push({ prompt: s.steer.prompt, sending: true });
    for (const q of s.queue) if (q.followup && q.tabId === tab.id) list.push({ prompt: q.prompt, sending: false });
    return list;
  }, [s?.steer, s?.queue, tab?.id]);

  const toggleWork = () => {
    if (!tab) return;
    setOverrides((cur) => ({ ...cur, [tab.id]: { value: !expanded, auto } }));
    if (!expanded) {
      // Expanding brings the start of the work into view.
      follow.current = false;
      requestAnimationFrame(() => scroller.current?.querySelector('[data-work]')?.scrollIntoView({ block: 'start' }));
    } else follow.current = true;
  };

  const changeDir = (arg: string, trust?: string) => {
    if (!arg) return toast(`Working directory: ${s?.cwd}`);
    request(c.id, 'cd', { path: arg, ...(trust && { trust }) })
      .then((r) => {
        if (r.status === 'ok') toast(`Now in ${shortPath(String(r.cwd))}`);
        else if (r.status === 'rejected') toast(String(r.message), true);
        else
          setPanel({
            kind: 'confirm',
            title: 'Trust this folder?',
            question: `Claude Code will be able to read, edit and run things in ${r.directory}`,
            yes: 'Yes, trust it',
            onYes: () => changeDir(arg, String(r.directory)),
          });
      })
      .catch((e) => toast(`cd failed: ${errText(e)}`, true));
  };

  const run = (t: string, fields?: Record<string, unknown>) =>
    request(c.id, t, fields)
      .then((r) => {
        if (typeof r.message === 'string') toast(r.message);
      })
      .catch((e) => toast(errText(e), true));

  const runLocal = (name: LocalCommandName, args: string) => {
    switch (name) {
      case 'help':
        return setHelp(true);
      case 'exit':
        return closeConn(c.id);
      case 'settings':
        return onSettings();
      case 'artifacts':
      case 'mcp':
      case 'chrome':
        return setPanel({ kind: name });
      case 'model':
      case 'effort': {
        if (!args) return setPanel({ kind: name });
        const [t, field, label] = name === 'model' ? ['set_model', 'model', 'Model'] : ['set_effort', 'level', 'Effort'];
        request(c.id, t, { [field]: args })
          .then(() => toast(`${label}: ${args}`))
          .catch((e) => toast(`/${name}: ${errText(e)}`, true));
        return;
      }
      case 'resume': {
        if (!args) return onSwitcher('folder');
        const hit = getState().sessions.find((r) => r.id.startsWith(args));
        return hit ? openSession({ cwd: hit.cwd, sessionId: hit.id, resume: true, title: hit.title }) : toast(`No session ${args}`, true);
      }
    }
    if (busy) return toast(`Wait for the running turn to finish (or press Esc) before /${name}`, true);
    switch (name) {
      case 'clear':
        return void run('clear');
      case 'fork':
        return void run('fork', { title: args });
      case 'rewind':
        return setPanel({ kind: 'rewind' });
      case 'cd':
        return changeDir(args);
    }
  };

  // Up on an empty prompt, or a queued prompt's Edit, opens it in the
  // composer. Enter saves it in place (empty removes it); Esc leaves it as it was.
  const lastQueued = s?.queue.filter((q) => q.tabId === tab?.id).at(-1);
  const editQueued = (tabId: number, prompt: string) => {
    if (composer.current?.hasText()) return toast('Send or clear the prompt first', true);
    setEditing({ tabId, prompt });
    composer.current?.setText(prompt);
  };
  const cancelEdit = () => {
    setEditing(null);
    composer.current?.setText('');
  };
  const saveEdit = (text: string) => {
    const { tabId, prompt } = editing!;
    setEditing(null);
    request(c.id, 'edit_queued', { tabId, prompt, text })
      .then(() => {
        if (!text.trim()) toast('Removed the queued prompt');
      })
      .catch((e) => {
        // It left the queue (sent, or removed elsewhere) first: the edit stays in the prompt.
        composer.current?.setText(text);
        toast(errText(e), true);
      });
  };
  const removeQueued = (tabId: number, prompt: string) => void request(c.id, 'edit_queued', { tabId, prompt, text: '' }).catch((e) => toast(errText(e), true));

  const send = (text: string, images: ImageAttachment[], followup: boolean) => {
    setHelp(false);
    if (editing) return saveEdit(text);
    const local = /^!\s*\S/.test(text) ? null : localCommand(text);
    if (local) return runLocal(local.name, local.args);
    // Ctrl+Enter keeps the prompt in the current tab: on a running turn it is
    // sent at once (Claude Code's "send now"), otherwise it waits its turn.
    const into = followup && tab && !tab.bash ? tab.id : undefined;
    request(c.id, 'send', { text, ...(images.length && { images }), ...(into !== undefined && { tabId: into }) })
      .then((r) => {
        if (typeof r.tabId === 'number') setActiveTab(c.id, r.tabId);
        follow.current = true;
      })
      .catch((e) => toast(errText(e), true));
  };

  const moveTab = (delta: number) => {
    if (!s?.tabs.length) return;
    const n = s.tabs.length;
    const i = Math.max(0, s.tabs.findIndex((t) => t.id === c.activeTab));
    setActiveTab(c.id, s.tabs[(((i + delta) % n) + n) % n].id);
  };

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || appPanelOpen) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const take = () => e.preventDefault();
    if (ctrl && e.key === ']') return take(), void openLatestArtifact(c.id);
    if (panel) return;
    if (help && e.key === 'Escape') return take(), setHelp(false);
    if (ctrl && e.key === 'r') {
      take();
      if (c.status === 'detached' || c.status === 'failed') reopen(c.id);
      else if (s?.childExit) void run('restart');
      return;
    }
    if (!s || c.status !== 'attached') return;
    if (e.key === 'Escape' && !s.question) {
      take();
      if (editing) return cancelEdit();
      if (tab?.bash && tab.status === 'running') return void run('stop_bash', { tabId: tab.id });
      if (s.running !== null) return void run('interrupt');
      // Esc twice while idle: rewind, as in Claude Code.
      const now = Date.now();
      if (now - lastEsc.current < DOUBLE_ESC_MS) {
        lastEsc.current = 0;
        runLocal('rewind', '');
      } else lastEsc.current = now;
      return;
    }
    if (ctrl && e.key === 'o') return take(), setState((st) => ({ detail: !st.detail }));
    if (ctrl && e.key === 'e') return take(), toggleWork();
    if (ctrl && (e.key === 'n' || e.key === 'ArrowRight')) return take(), moveTab(1);
    if (ctrl && (e.key === 'p' || e.key === 'ArrowLeft')) return take(), moveTab(-1);
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      take();
      const t = s.tabs[Number(e.code.slice(5)) - 1];
      if (t) setActiveTab(c.id, t.id);
      return;
    }
    const el = scroller.current;
    if (el && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && ['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      take();
      const page = Math.max(40, el.clientHeight - 60);
      setFull(e.key === 'Home');
      if (e.key === 'PageUp') el.scrollBy({ top: -page });
      else if (e.key === 'PageDown') el.scrollBy({ top: page });
      else if (e.key === 'Home') {
        follow.current = false;
        el.scrollTop = 0;
      } else {
        follow.current = true;
        toBottom();
      }
      return;
    }
    // Typing while the transcript has focus goes to the prompt.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !isEditable(e.target) && !s.question) composer.current?.focus();
  };
  useEffect(() => {
    if (!visible) return;
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [visible]);

  const renderPanel = (p: Panel) => {
    const common = { conn: c.id, close: () => setPanel(null), active: visible && !appPanelOpen };
    switch (p.kind) {
      case 'model':
        return <ModelPanel {...common} current={s?.model ?? null} />;
      case 'effort':
        return <EffortPanel {...common} model={s?.model ?? null} current={s?.effort ?? null} />;
      case 'mcp':
        return <McpPanel {...common} />;
      case 'chrome':
        return <ChromePanel {...common} />;
      case 'rewind':
        return <RewindPanel {...common} onRewound={(text) => text && composer.current?.setText(text)} />;
      case 'artifacts':
        return <ArtifactsPanel {...common} />;
      case 'confirm':
        return (
          <ConfirmPanel
            active={common.active}
            title={p.title}
            question={p.question}
            yes={p.yes}
            onAnswer={(ok) => {
              setPanel(null);
              if (ok) p.onYes();
            }}
          />
        );
    }
  };

  const runningTab = s?.tabs.find((t) => t.id === s.running);
  const answering = Boolean(s?.question);
  const turnStatus =
    runningTab && s && !answering
      ? `${turnVerb(runningTab.blocks, s.activity, s.interrupting)}… (${elapsed(Date.now() - started.current.at)} · esc to interrupt)${runningTab.id !== tab?.id ? ` · tab ${runningTab.id}` : ''}`
      : '';
  const commands = useMemo(() => visibleCommands(c.commands), [c.commands]);

  return (
    <div className="session" hidden={!visible}>
      <div className="titlebar">
        {s ? <TabBar tabs={s.tabs} active={tab?.id ?? null} onSelect={(id) => setActiveTab(c.id, id)} /> : <div className="no-tabs" />}
      </div>
      {pinned && (
        <div className={`sticky-prompt${full ? ' full' : ''}`} onClick={() => setFull(!full)} title={full ? 'Show the first lines' : 'Show the whole prompt'}>
          <div className="sticky-column">
            <div className={`prompt${pinned.bash ? ' bash' : ''}`}>
              <div ref={pinnedText} className="clamp">
                <PromptText text={pinned.prompt} />
              </div>
            </div>
            {cut > 0 && <div className="sticky-more">+{plural(cut, 'line')}</div>}
          </div>
        </div>
      )}
      {c.status === 'opening' && <div className="banner info">Starting the session…</div>}
      {c.status === 'failed' && (
        <div className="banner">
          <span className="err">Could not open the session.</span> {c.error}
          <div className="turn-note">
            <kbd>⌃R</kbd> tries again · <kbd>⌘W</kbd> closes it
          </div>
        </div>
      )}
      {c.status === 'detached' && (
        <div className="banner info">
          {c.error ?? 'The session ended'}. <kbd>⌃R</kbd> reopens it.
        </div>
      )}
      {s?.childExit && (
        <div className="banner">
          <span className="err">claude exited (code {String(s.childExit.code)}).</span> Press <kbd>⌃R</kbd> to restart and resume.
          {s.childExit.stderr.length > 0 && <pre>{s.childExit.stderr.slice(-5).join('\n')}</pre>}
        </div>
      )}
      <div
        className="scroller"
        ref={scroller}
        // Any move up stops following the output; reaching the bottom again resumes it.
        onWheel={(e) => {
          if (e.deltaY < 0) follow.current = false;
          setFull(false);
        }}
        onScroll={() => {
          const el = scroller.current!;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
          if (atBottom) follow.current = true;
          else if (el.scrollTop < lastTop.current) follow.current = false;
          lastTop.current = el.scrollTop;
        }}
      >
        <div ref={content}>
          {help ? (
            <HelpView commandCount={commands.length} />
          ) : s && tab ? (
            <Transcript tab={tab} ctx={{ conn: c.id, tabId: tab.id, cwd: s.cwd, detail }} expanded={expanded} expandEarlier={expandEarlier} onToggle={toggleWork} pending={pending} pinned={Boolean(pinned)} queued={{ edit: (p) => editQueued(tab.id, p), remove: (p) => removeQueued(tab.id, p) }} />
          ) : s ? (
            <Welcome model={s.model} effort={s.effort} cwd={s.cwd} />
          ) : null}
        </div>
      </div>
      {s && (
        <div className="dock">
          <div className="activity">
            <span className="now">
              {turnStatus && <span className="spin">✻</span>} {turnStatus}
            </span>
            <span className="side">{s.queue.length ? `${s.queue.length} queued` : ''}</span>
          </div>
          {s.backgroundTasks?.length ? <BackgroundTasks tasks={s.backgroundTasks} /> : null}
          {s.question && (
            <QuestionCard
              key={s.question.requestId}
              question={s.question}
              active={visible && !panel && !appPanelOpen}
              onAnswer={(answers) => void run('answer', { requestId: s.question!.requestId, answers })}
              onDeny={s.question.kind === 'permission' ? () => void run('deny', { requestId: s.question!.requestId }) : undefined}
            />
          )}
          {/* Hidden, not unmounted, under a question: the draft stays. */}
          <div hidden={answering}>
            <Composer
              ref={composer}
              conn={c.id}
              cwd={s.cwd}
              commands={commands}
              suggestion={s.suggestion}
              running={s.running !== null}
              active={visible && !answering && !panel && !appPanelOpen && c.status === 'attached'}
              draft={c.draft}
              onEditQueued={lastQueued && !editing ? () => editQueued(lastQueued.tabId, lastQueued.prompt) : undefined}
              editing={editing !== null}
              onSubmit={send}
            />
          </div>
          <StatusBar s={s} />
          <Toast />
        </div>
      )}
      {panel && renderPanel(panel)}
    </div>
  );
}

// Background shells and agents still running, one row each under the status
// row: what each is doing, and its kind, tab and running time, so one that
// hangs is plain to see.
const BG_ROWS = 4;

const taskKind = (type: string) => (type === 'local_bash' ? 'shell' : type.replace(/^local_/, '').replace(/_/g, ' '));

function BackgroundTasks({ tasks }: { tasks: BackgroundTask[] }) {
  const shown = tasks.length > BG_ROWS ? tasks.slice(0, BG_ROWS - 1) : tasks;
  const now = Date.now();
  return (
    <div className="bg-tasks">
      {shown.map((t) => (
        <div key={t.id} className="bg-task">
          <span className="what">
            ◷ {t.description}
            {t.progress && <span className="step"> · {t.progress}</span>}
          </span>
          <span className="meta">{[taskKind(t.type), t.tabId !== undefined && `tab ${t.tabId}`, t.startedAt !== undefined && elapsed(Math.max(0, now - t.startedAt))].filter(Boolean).join(' · ')}</span>
        </div>
      ))}
      {shown.length < tasks.length && <div className="bg-task more">+{plural(tasks.length - shown.length, 'more background task')}</div>}
    </div>
  );
}

function Toast() {
  const t = useApp((st) => st.toast);
  if (!t) return null;
  return <div className={`toast${t.error ? ' error' : ''}`}>{t.text}</div>;
}

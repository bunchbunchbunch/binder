import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import stringWidth from 'string-width';
import type { SessionHost, RewindMode } from '../host.js';
import { firstPrompt } from '../store.js';
import { buildPayload, fallbackStatusLine, runStatusLine } from '../statusline.js';
import { localCommand, type LocalCommandName, type SlashCommand } from '../slashCommands.js';
import { addHistory, loadHistory } from '../history.js';
import { sessionArtifacts } from '../artifacts.js';
import { openExternal } from '../openUrl.js';
import type { SessionSummary } from '../transcripts.js';
import { TabBar } from './TabBar.js';
import { TabView } from './TabView.js';
import type { PendingPrompt } from './tabLines.js';
import { PromptInput } from './PromptInput.js';
import { QuestionView } from './QuestionView.js';
import { StatusBar } from './StatusBar.js';
import { HelpView } from './HelpView.js';
import { Shortcuts } from './Shortcuts.js';
import { Welcome } from './Welcome.js';
import { ArtifactsPanel, ChromePanel, ConfirmPanel, EffortPanel, McpPanel, ModelPanel, ResumePanel, RewindPanel, rewindTargets } from './panels.js';
import { SPINNER, elapsed, turnVerb } from './tabLayout.js';
import { MARKDOWN_STYLES, markdownStyle, setMarkdownStyle } from './md/theme.js';


// "──────── title ─", with the title right-aligned like Claude Code's composer.
function titledRule(width: number, title: string): string {
  const tail = ` ${title} ─`;
  return '─'.repeat(Math.max(0, width - tail.length)) + tail;
}

function permissionModeLine(mode?: string): { text: string; color: string } | undefined {
  switch (mode) {
    case 'bypassPermissions':
      return { text: ' ▸▸ bypass permissions on', color: 'red' };
    case 'acceptEdits':
      return { text: ' ▸▸ accept edits on', color: 'blue' };
    case 'plan':
      return { text: ' ⏸ plan mode on', color: 'green' };
    case 'dontAsk':
      return { text: ' ▸▸ dont ask on', color: 'yellow' };
    default:
      return undefined;
  }
}

const DOUBLE_ESC_MS = 600;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// binder's own panels, shown in place of the transcript.
type Panel =
  | { kind: 'resume' | 'mcp' | 'model' | 'effort' | 'chrome' | 'rewind' | 'artifacts' }
  | { kind: 'confirm'; title: string; question: string; yes: string; onYes: () => void };


export type AppProps = {
  host: SessionHost;
  configDir: string;
  statusLineCommand?: string;
  /** Text the prompt starts with, unsent. */
  draft?: string;
  onQuit: () => void;
};

export function App({ host, configDir, statusLineCommand, draft, onQuit }: AppProps) {
  const state = useSyncExternalStore(host.subscribe, host.getState);
  const dispatch = host.dispatch.bind(host);
  const session = host.session;
  const [detail, setDetail] = useState(false);
  const [frame, setFrame] = useState(0);
  const [statusLine, setStatusLine] = useState('');
  const [notice, setNotice] = useState<string | undefined>();
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const quitArmed = useRef<NodeJS.Timeout | null>(null);
  // Text is selected in the prompt, so Ctrl+C copies it instead of quitting.
  const selecting = useRef(false);
  const onSelectionChange = useCallback((selected: boolean) => {
    selecting.current = selected;
  }, []);
  const [commands, setCommands] = useState<SlashCommand[]>(() => host.commands);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [help, setHelp] = useState(false);
  const [mdStyle, setMdStyle] = useState(markdownStyle);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [cwd, setCwd] = useState(host.cwd);
  const [history, setHistory] = useState<string[]>(() => loadHistory(host.cwd));
  const [effort, setEffortLevel] = useState<string | undefined>(host.effort);
  const [plan, setPlan] = useState<string | undefined>(host.plan);
  // Remounting the prompt with new text (a rewind puts the prompt back).
  const [fill, setFill] = useState({ key: 0, text: draft ?? '' });
  const lastEsc = useRef(0);

  useEffect(() => setHistory(loadHistory(cwd)), [cwd]);

  // What the host learns from the child, or from a remote viewer's commands.
  useEffect(() => {
    const onCommands = (list: SlashCommand[]) => setCommands(list);
    const onCwd = (dir: string) => setCwd(dir);
    host.on('commands', onCommands);
    host.on('cwd', onCwd);
    host.on('effort', setEffortLevel);
    host.on('plan', setPlan);
    return () => {
      host.off('commands', onCommands);
      host.off('cwd', onCwd);
      host.off('effort', setEffortLevel);
      host.off('plan', setPlan);
    };
  }, [host]);

  // Spinner while a turn runs.
  const running = state.running !== null;
  // When the running turn started, for the status row's timer.
  const turnStart = useRef<{ id: number | null; at: number }>({ id: null, at: 0 });
  if (turnStart.current.id !== state.running) turnStart.current = { id: state.running, at: Date.now() };
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  // Status bar: the user's own statusline command, refreshed on changes and every 30s.
  const refreshStatus = useCallback(() => {
    const input = { sessionId: state.sessionId, model: state.model, cwd, usage: state.usage };
    if (!statusLineCommand) {
      setStatusLine(fallbackStatusLine(configDir, input));
      return;
    }
    runStatusLine(statusLineCommand, buildPayload(input), cwd)
      .then((out) => setStatusLine(out || fallbackStatusLine(configDir, input)))
      .catch(() => setStatusLine(fallbackStatusLine(configDir, input)));
  }, [state.sessionId, state.model, state.usage, cwd, configDir, statusLineCommand]);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 30000);
    return () => clearInterval(t);
  }, [refreshStatus, running]);

  const quit = useCallback(() => {
    onQuit();
    exit();
  }, [onQuit, exit]);

  const answering = state.question !== undefined;

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? undefined : n)), 4000);
  };
  const closePanel = () => setPanel(null);
  // Runs a host command, flashing its message or the reason it could not run.
  const attempt = (fn: () => string | void) => {
    try {
      const msg = fn();
      if (msg) flash(msg);
    } catch (e) {
      flash(errText(e));
    }
  };

  const resumeSession = (s: SessionSummary) => {
    setPanel(null);
    attempt(() => host.resume(s));
  };

  const rewind = async (target: { uuid: string; prompt: string }, mode: RewindMode) => {
    setPanel(null);
    try {
      const r = await host.rewind(target.uuid, mode);
      if (mode !== 'code') setFill((f) => ({ key: f.key + 1, text: r.prefill ?? target.prompt }));
      flash(r.message);
    } catch (e) {
      flash(`Rewind failed: ${errText(e)}`);
    }
  };

  const changeDir = async (arg: string, trust?: string) => {
    if (!arg) return flash(`Working directory: ${cwd}`);
    try {
      const r = await host.changeDir(arg, trust);
      if (r.status === 'ok') return flash(`Now in ${r.cwd}`);
      if (r.status === 'rejected') return flash(r.message);
      setPanel({
        kind: 'confirm',
        title: 'Trust this folder?',
        question: `Claude Code will be able to read, edit and run things in ${r.directory}`,
        yes: 'Yes, trust it',
        onYes: () => void changeDir(arg, r.directory),
      });
    } catch (e) {
      flash(`cd failed: ${errText(e)}`);
    }
  };

  const setModel = (model: string) => {
    host
      .setModel(model)
      .then(() => flash(`Model: ${model}`))
      .catch((e) => flash(`/model: ${errText(e)}`));
  };

  const applyEffort = (level: string) => {
    host
      .setEffort(level)
      .then(() => flash(`Effort: ${level}`))
      .catch((e) => flash(`/effort: ${errText(e)}`));
  };

  const openLatestArtifact = () => {
    const latest = sessionArtifacts(state.tabs).at(-1);
    if (!latest) return flash('No artifact published in this session yet');
    openExternal(latest.url);
    flash(`Opened ${latest.url}`);
  };

  const runLocal = (name: LocalCommandName, args: string) => {
    switch (name) {
      case 'help':
        return setHelp(true);
      case 'exit':
        return quit();
      case 'artifacts':
      case 'mcp':
      case 'chrome':
        return setPanel({ kind: name });
      case 'model':
        return args ? setModel(args) : setPanel({ kind: 'model' });
      case 'effort':
        return args ? applyEffort(args) : setPanel({ kind: 'effort' });
      case 'markdown': {
        // A named style, or the next one in turn.
        const named = MARKDOWN_STYLES.find((s) => s === args);
        const next = named ?? MARKDOWN_STYLES[(MARKDOWN_STYLES.indexOf(mdStyle) + 1) % MARKDOWN_STYLES.length];
        setMarkdownStyle(next);
        setMdStyle(next);
        return flash(`Markdown: ${next}`);
      }
    }
    if (host.busy) return flash(`Wait for the running turn to finish (or press Esc) before /${name}`);
    switch (name) {
      case 'clear':
        return attempt(() => host.clear());
      case 'resume': {
        if (!args) return setPanel({ kind: 'resume' });
        const hit = host.findSession(args);
        return hit ? resumeSession(hit) : flash(`No session ${args}`);
      }
      case 'fork':
        return attempt(() => host.fork(args));
      case 'rewind':
        return rewindTargets(state.tabs).length ? setPanel({ kind: 'rewind' }) : flash('No prompts to rewind to yet');
      case 'cd':
        return void changeDir(args);
    }
  };

  const active = state.tabs[state.active];

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (selecting.current) return;
      if (quitArmed.current) {
        clearTimeout(quitArmed.current);
        quit();
      } else {
        setNotice('Press Ctrl+C again to quit');
        quitArmed.current = setTimeout(() => {
          quitArmed.current = null;
          setNotice(undefined);
        }, 1500);
      }
      return;
    }
    if ((key.ctrl && input === ']') || input === '\x1d') return openLatestArtifact();
    if (panel) return; // the panel has the keys
    if (key.escape && help) return setHelp(false);
    if (key.escape && !answering && !menuOpen) {
      if (active?.bash && active.status === 'running') return host.stopBash(active.id);
      if (running) return host.interrupt();
      // Esc twice while idle: rewind, as in Claude Code.
      const now = Date.now();
      if (now - lastEsc.current < DOUBLE_ESC_MS) {
        lastEsc.current = 0;
        runLocal('rewind', '');
      } else lastEsc.current = now;
      return;
    }
    if (key.ctrl && input === 'o') return setDetail((d) => !d);
    if ((key.ctrl && input === 'n') || (key.ctrl && key.rightArrow)) return dispatch({ type: 'select_relative', delta: 1 });
    if ((key.ctrl && input === 'p') || (key.ctrl && key.leftArrow)) return dispatch({ type: 'select_relative', delta: -1 });
    if (key.meta && /^[1-9]$/.test(input)) return dispatch({ type: 'select', index: Number(input) - 1 });
    if (state.childExit && key.ctrl && input === 'r') host.restart();
  });

  const onAnswer = (answers: Record<string, string>) => {
    if (state.question) attempt(() => host.answer(state.question!.requestId, answers));
  };
  const onDeny = () => {
    if (state.question) attempt(() => host.deny(state.question!.requestId));
  };

  const renderPanel = (p: Panel) => {
    const common = { session, flash, close: closePanel };
    switch (p.kind) {
      case 'resume':
        return <ResumePanel {...common} cwd={cwd} configDir={configDir} currentId={state.sessionId} onResume={resumeSession} />;
      case 'mcp':
        return <McpPanel {...common} />;
      case 'model':
        return <ModelPanel {...common} current={state.model} onModel={(m) => dispatch({ type: 'model', model: m })} />;
      case 'effort':
        return <EffortPanel {...common} model={state.model} current={effort} onEffort={(level) => host.noteEffort(level)} />;
      case 'chrome':
        return <ChromePanel {...common} onChrome={(on) => attempt(() => host.setChrome(on))} />;
      case 'rewind':
        return <RewindPanel {...common} tabs={state.tabs} onRewind={(t, mode) => void rewind(t, mode)} />;
      case 'artifacts':
        return <ArtifactsPanel {...common} tabs={state.tabs} />;
      case 'confirm':
        return (
          <ConfirmPanel
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

  const runningTab = state.tabs.find((t) => t.id === state.running);
  // Like Claude Code's "✻ Thinking… (12s · esc to interrupt)" above the prompt.
  const turnStatus =
    runningTab && !answering
      ? `${SPINNER[frame % SPINNER.length]} ${turnVerb(runningTab.blocks, state.activity, state.interrupting)}… (${elapsed(Date.now() - turnStart.current.at)} · esc to interrupt)`
      : '';
  // Background shells and agents still running, like Claude Code's panel under
  // the prompt: named when the row is free, counted beside a running turn.
  const bg = state.backgroundTasks;
  const bgCount = bg.length ? `${bg.length} background ${bg.length > 1 ? 'tasks' : 'task'}` : '';
  // Ctrl+Enter follow-ups for the active tab that have not started yet.
  const activeId = active?.id;
  const pendingFollowups = useMemo(() => {
    const list: PendingPrompt[] = [];
    if (state.steer && state.steer.tabId === activeId) list.push({ prompt: state.steer.prompt, sending: true });
    for (const q of state.queue) if (q.followup && q.tabId === activeId) list.push({ prompt: q.prompt, sending: false });
    return list;
  }, [state.steer, state.queue, activeId]);
  // Rows the status line takes once wrapped, so a notice under it is never clipped.
  const statusRows = Math.max(1, statusLine.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(stringWidth(l) / Math.max(1, columns - 2))), 0)) + (notice ? 1 : 0);
  const title = state.tabs[0] ? firstPrompt(state.tabs[0]).split('\n')[0].trim().slice(0, 40) : state.sessionId.slice(0, 8);
  const mode = permissionModeLine(state.permissionMode);
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <TabBar tabs={state.tabs} active={state.active} width={columns} frame={frame} />
      {/* flexBasis 0: the transcript takes only leftover rows, so a long response can never squeeze the tab bar, prompt or status line out of view. */}
      <Box flexGrow={1} flexBasis={0} flexDirection="column" borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false} borderBottom={false}>
        {panel ? (
          renderPanel(panel)
        ) : help ? (
          <HelpView commandCount={commands.length} />
        ) : active ? (
          <TabView key={active.id} tab={active} width={columns} detail={detail} scrollActive={!answering} questionPending={answering && state.running === active.id} pending={pendingFollowups} mdStyle={mdStyle} />
        ) : (
          <Welcome model={state.model} effort={effort} plan={plan} cwd={cwd} width={columns} />
        )}
        {state.childExit && (
          <Box paddingX={1} flexDirection="column">
            <Text color="red">claude exited (code {String(state.childExit.code)}). Press Ctrl+R to restart and resume.</Text>
            {state.childExit.stderr.slice(-5).map((l, i) => <Text key={i} dimColor>{l}</Text>)}
          </Box>
        )}
        {/* "?" pops the shortcuts out over the bottom of the transcript, just above the prompt. */}
        {shortcuts && (
          <Box position="absolute" bottom={0} left={0}>
            <Shortcuts width={columns} />
          </Box>
        )}
      </Box>
      <Box justifyContent="space-between" height={1} paddingLeft={1}>
        {turnStatus || !bg.length ? (
          <Text color="#E8C07D" wrap="truncate-end">{turnStatus}</Text>
        ) : (
          <Text color="#7CC4FF" wrap="truncate-end">{`◷ ${bgCount}: ${bg.map((t) => t.description).join(', ')}`}</Text>
        )}
        <Text dimColor>{[turnStatus && bgCount, state.contextTokens ? `${state.contextTokens} tokens` : ''].filter(Boolean).join(' · ')}</Text>
      </Box>
      <Text dimColor>{titledRule(columns, title)}</Text>
      {answering && state.question && (
        <QuestionView question={state.question} onAnswer={onAnswer} onDeny={state.question.toolName === 'AskUserQuestion' ? undefined : onDeny} />
      )}
      {/* Hidden, not unmounted, under a question: remounting would bring back the initial text and drop what was typed. */}
      <Box display={answering ? 'none' : 'flex'} flexDirection="column">
        <PromptInput
          key={fill.key}
          initialValue={fill.text}
          width={columns}
          isActive={!answering && !panel}
          commands={commands}
          history={history}
          cwd={cwd}
          onMenuChange={setMenuOpen}
          onShortcutsChange={setShortcuts}
          onSelectionChange={onSelectionChange}
          onSubmit={(text, images, followup) => {
            setHelp(false);
            addHistory(cwd, text);
            setHistory((h) => (h[h.length - 1] === text ? h : h.concat(text)));
            const local = /^!\s*\S/.test(text) ? null : localCommand(text);
            if (local) return runLocal(local.name, local.args);
            // Ctrl+Enter keeps the prompt in the current tab: on a running turn it
            // is sent at once (Claude Code's "send now"), otherwise it waits its turn.
            host.send(text, images, followup && !active?.bash ? active?.id : undefined);
          }}
          placeholder={running ? 'Enter queues a new tab, Ctrl+Enter adds to this one' : '? for shortcuts'}
          suggestion={state.suggestion}
        />
      </Box>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      <Box height={statusRows} paddingX={1}>
        <StatusBar line={statusLine} notice={notice} />
      </Box>
      {mode && (
        <Text color={mode.color}>{mode.text}</Text>
      )}
    </Box>
  );
}

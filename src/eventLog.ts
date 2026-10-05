import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';
import { parseEventLine } from './events.js';
import { initialState, reduce, type State } from './store.js';

// Append-only record of one session as seen by binder: every child stdout line
// except stream_event (the final `assistant` lines carry the same content),
// plus a marker line for each prompt binder sent. Replaying it through the
// reducer rebuilds the tabs without depending on Claude Code's transcript format.

// `kind` is absent for a prompt that opened its tab, 'followup' for one sent
// into an existing tab after its turn ended, 'steer' for one sent mid-turn.
// (The 'hc_prompt' type predates the rename and stays for existing logs.)
export type PromptMarker = { type: 'hc_prompt'; prompt: string; tabId: number; kind?: 'followup' | 'steer'; uuid?: string };

// Binder's own entries: a `!command` it ran (start, then its output), and a rewind.
export type LocalMarker =
  | { type: 'hc_bash'; tabId: number; command: string }
  | { type: 'hc_bash_done'; tabId: number; output: string; exitCode: number | null }
  | { type: 'hc_rewind'; uuid: string };

export function logPath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.events.jsonl`);
}

export function appendRaw(sessionId: string, line: string): void {
  if (line.includes('"type":"stream_event"')) {
    const e = parseEventLine(line);
    if (e?.type === 'stream_event') return;
  }
  appendFileSync(logPath(sessionId), line + '\n');
}

export function appendPrompt(sessionId: string, marker: Omit<PromptMarker, 'type'>): void {
  appendFileSync(logPath(sessionId), JSON.stringify({ type: 'hc_prompt', ...marker }) + '\n');
}

export function appendLocal(sessionId: string, marker: LocalMarker): void {
  appendFileSync(logPath(sessionId), JSON.stringify(marker) + '\n');
}

export function replay(sessionId: string): State {
  let state = initialState(sessionId);
  const path = logPath(sessionId);
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const e = parseEventLine(line);
    if (!e) continue;
    if (e.type === 'hc_prompt') {
      const m = e as unknown as PromptMarker;
      if (m.kind === 'steer') {
        state = reduce(state, { type: 'steer', tabId: m.tabId, prompt: m.prompt, uuid: m.uuid ?? '' });
      } else if (m.kind === 'followup') {
        state = reduce(state, { type: 'followup', tabId: m.tabId, prompt: m.prompt });
        state = reduce(state, { type: 'sent', tabId: m.tabId, uuid: m.uuid });
      } else {
        state = reduce(state, { type: 'submit', prompt: m.prompt, tabId: m.tabId });
        state = reduce(state, { type: 'sent', tabId: m.tabId, uuid: m.uuid });
      }
    } else if (e.type === 'hc_bash') {
      const m = e as unknown as Extract<LocalMarker, { type: 'hc_bash' }>;
      state = reduce(state, { type: 'bash_start', command: m.command, tabId: m.tabId });
    } else if (e.type === 'hc_bash_done') {
      const m = e as unknown as Extract<LocalMarker, { type: 'hc_bash_done' }>;
      state = reduce(state, { type: 'bash_done', tabId: m.tabId, output: m.output, exitCode: m.exitCode });
    } else if (e.type === 'hc_rewind') {
      state = reduce(state, { type: 'rewind', uuid: (e as unknown as { uuid: string }).uuid });
    } else {
      state = reduce(state, { type: 'event', event: e });
    }
  }
  // A turn that never got its result (binder quit mid-turn) is over now, and
  // so is a follow-up or prompt that never started.
  if (state.running !== null || state.steer || state.unstarted) {
    state = reduce(state, { type: 'child_exit', code: null, stderr: [] });
    state = reduce(state, { type: 'child_restarted' });
  }
  // A `!command` cut off by quitting.
  for (const tab of state.tabs) {
    if (tab.bash && tab.status === 'running') state = reduce(state, { type: 'bash_done', tabId: tab.id, output: '', exitCode: null });
  }
  // Background work ended with the child that ran it.
  return { ...state, bashContext: [], notices: [], backgroundTasks: [] };
}

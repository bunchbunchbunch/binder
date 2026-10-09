import { useEffect, useRef } from 'react';

// The "?" popout above the prompt (any key closes it), /help's longer list,
// and the guide (⌘/): why the app works this way, then the same list.
// The keys are the TUI's, plus ⌘ shortcuts for the session sidebar.

const SHORTCUTS: [key: string, action: string][] = [
  ['!', 'for bash mode'],
  ['/', 'for commands'],
  ['@', 'for file paths'],
  ['tab', 'to complete'],
  ['↑ ↓', 'for earlier prompts'],
  ['⇧ ⏎', 'for newline'],
  ['⏎', 'to send in a new tab'],
  ['⌃ ⏎', 'to send in this tab'],
  ['esc', 'to interrupt'],
  ['esc esc', 'to rewind'],
  ['⌃E', 'to expand the work'],
  ['⌃O', 'for full detail'],
  ['⌃L', 'to pick a model'],
  ['⌃P', 'to cycle models'],
  ['⇧ tab', 'to cycle effort'],
  ['⌃← / ⌃→', 'to switch tabs'],
  ['⌥1-9', 'to jump to a tab'],
  ['pgup / pgdn', 'to scroll'],
  ['⌃V', 'to paste an image'],
  ['⌃]', 'for the latest artifact'],
  ['⌘N', 'for a new session'],
  ['⌘K', 'to open a session'],
  ['⌘1-9', 'to switch sessions'],
  ['⌘W', 'to close a session'],
  ['⌃⌘S', 'to hide the sidebar'],
  ['⌘/', 'for the guide'],
  ['/help', 'for more'],
];

export function Shortcuts() {
  return (
    <div className="shortcuts">
      {SHORTCUTS.map(([k, a]) => (
        <div key={k}>
          <span className="k">{k}</span>
          <span className="a">{a}</span>
        </div>
      ))}
    </div>
  );
}

const KEYS: [string, string][] = [
  ['Enter', 'Send the prompt in a new tab (queued if a turn is running)'],
  ['Ctrl+Enter', 'Send into the current tab: on a running turn it is sent now, otherwise after it'],
  ['Shift+Enter, Alt+Enter, \\ Enter', 'Newline'],
  ['Up / Down', 'Earlier / later prompts from this folder (inside a multi-line prompt, move between lines first)'],
  ['Up (empty prompt)', "Edit the tab's queued prompt in place: Enter saves it, Enter on an empty prompt removes it, Esc leaves it. Queued prompts also have Edit and Remove buttons"],
  ['Tab, @', 'Complete a path (after !, a command name)'],
  ['Tab, Right (empty prompt)', 'Take the suggested next prompt'],
  ['!command', 'Bash mode: run it in the session folder; the model sees the output with your next prompt'],
  ['Ctrl+Right / Ctrl+Left', 'Next / previous tab (also Ctrl+N, and Option+1-9 to jump)'],
  ['Ctrl+L', 'Pick the model (/model)'],
  ['Ctrl+P / Shift+Ctrl+P', 'Switch to the next / previous model, as in pi'],
  ['Shift+Tab', "Switch to the model's next effort level, as in pi"],
  ['PgUp / PgDn, Home / End', 'Scroll the tab'],
  ['Esc', 'Interrupt the running turn (or stop a bash command); twice when idle: rewind'],
  ['Ctrl+E', 'Expand or collapse the work (thinking and tool calls) behind a response'],
  ['Ctrl+O', 'Full tool output, thinking, and subagent detail'],
  ['Ctrl+V', 'Paste the clipboard: an image as [Image #n], or its text. Cmd+V and drag and drop work too'],
  ['Ctrl+]', 'Open the latest artifact'],
  ['Ctrl+R', 'Restart claude after it exits, or reopen a session that ended'],
  ['Ctrl+C', 'Copy the selection; twice with nothing selected quits'],
];

// The ⌘ keys: the window's, which the TUI has no need for.
const WINDOW_KEYS: [string, string][] = [
  ['Cmd+N', 'New session in a folder'],
  ['Cmd+K', 'Open a session (search all of them)'],
  ['Cmd+1-9, Cmd+Shift+[ / ]', 'Switch between open sessions'],
  ['Cmd+W', 'Close the session in the app (its host keeps running until idle)'],
  ['Ctrl+Cmd+S', 'Hide or show the sidebar'],
  ['Cmd+/', 'This guide: the keys and the thinking behind them'],
];

function KeyTable({ keys }: { keys: [string, string][] }) {
  return (
    <table>
      <tbody>
        {keys.map(([k, d]) => (
          <tr key={k}>
            <td>
              <kbd>{k}</kbd>
            </td>
            <td>{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HelpView({ commandCount }: { commandCount: number }) {
  return (
    <div className="help">
      <h2>Keys</h2>
      <KeyTable keys={[...KEYS, ...WINDOW_KEYS]} />
      <h2>Commands</h2>
      <p>
        Type / to browse all {commandCount}. Binder runs /help, /resume, /clear, /fork, /rewind, /cd, /model, /effort, /mcp, /chrome, /artifacts and /exit itself; the rest
        go to Claude Code.
      </p>
      <p style={{ color: 'var(--text-faint)' }}>Esc closes this.</p>
    </div>
  );
}

// What the guide says before the keys. Edit freely: it is the app's pitch.
const PRINCIPLES: [lead: string, rest: string][] = [
  ['Keyboard first.', 'Every action has a key, and most are one chord. The mouse works too, but nothing needs it.'],
  ["The terminal's keys.", "These are binder's TUI keys, so your hands work the same in a terminal and here. The only additions are ⌘ keys, and they act on the window: sessions, the sidebar, settings."],
  ['One shape for every panel.', 'Sessions, folders, models, settings: each is a list. Type to filter, ↑↓ to move, ⏎ to pick, esc to back out.'],
  ['A GUI where it pays.', 'Responses render as documents, with real heading sizes, tables, highlighted code, and diffs, which a terminal can only approximate.'],
  ['Sessions outlive the window.', 'As with tmux, the app attaches to a session host. The TUI and the phone can attach to the same session, and quitting the app leaves a running turn running.'],
];

/** ⌘/ (and Help > Binder Guide): the GTUI idea, then every key. Esc closes it. */
export function Guide({ close }: { close: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  // The body takes focus so ↑↓, PgUp/PgDn, and space scroll it.
  useEffect(() => body.current?.focus(), []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [close]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="picker guide">
        <div className="picker-head">
          <div className="picker-title">Binder is a GTUI</div>
          <div className="picker-sub">A graphic terminal user interface</div>
        </div>
        <div className="guide-body" ref={body} tabIndex={-1}>
          <p>
            It keeps what makes a terminal app quick (a key for everything, and getting around without the mouse) and draws it as a Mac app.
          </p>
          <ul>
            {PRINCIPLES.map(([lead, rest]) => (
              <li key={lead}>
                <strong>{lead}</strong> {rest}
              </li>
            ))}
          </ul>
          <p className="dim">
            <kbd>?</kbd> on an empty prompt shows the short list, <kbd>/help</kbd> the long one, and <kbd>⌘/</kbd> this guide.
          </p>
          <h2>In a session</h2>
          <KeyTable keys={KEYS} />
          <h2>In the window</h2>
          <KeyTable keys={WINDOW_KEYS} />
        </div>
        <div className="picker-hint">↑↓ scroll · esc close</div>
      </div>
    </div>
  );
}

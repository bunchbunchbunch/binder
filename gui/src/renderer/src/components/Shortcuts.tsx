// The "?" popout above the prompt (any key closes it), and /help's longer list.
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
  ['⌃N / ⌃P', 'to switch tabs'],
  ['⌥1-9', 'to jump to a tab'],
  ['pgup / pgdn', 'to scroll'],
  ['⌃V', 'to paste an image'],
  ['⌃]', 'for the latest artifact'],
  ['⌘N', 'for a new session'],
  ['⌘K', 'to open a session'],
  ['⌘1-9', 'to switch sessions'],
  ['⌘W', 'to close a session'],
  ['⌃⌘S', 'to hide the sidebar'],
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
  ['Ctrl+N / Ctrl+P', 'Next / previous tab (also Ctrl+Right / Left, and Option+1-9 to jump)'],
  ['PgUp / PgDn, Home / End', 'Scroll the tab'],
  ['Esc', 'Interrupt the running turn (or stop a bash command); twice when idle: rewind'],
  ['Ctrl+E', 'Expand or collapse the work (thinking and tool calls) behind a response'],
  ['Ctrl+O', 'Full tool output, thinking, and subagent detail'],
  ['Ctrl+V', 'Paste the clipboard: an image as [Image #n], or its text. Cmd+V and drag and drop work too'],
  ['Ctrl+]', 'Open the latest artifact'],
  ['Ctrl+R', 'Restart claude after it exits, or reopen a session that ended'],
  ['Ctrl+C', 'Copy the selection; twice with nothing selected quits'],
  ['Cmd+N', 'New session in a folder'],
  ['Cmd+K', 'Open a session (search all of them)'],
  ['Cmd+1-9, Cmd+Shift+[ / ]', 'Switch between open sessions'],
  ['Cmd+W', 'Close the session in the app (its host keeps running until idle)'],
  ['Ctrl+Cmd+S', 'Hide or show the sidebar'],
];

export function HelpView({ commandCount }: { commandCount: number }) {
  return (
    <div className="help">
      <h2>Keys</h2>
      <table>
        <tbody>
          {KEYS.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Commands</h2>
      <p>
        Type / to browse all {commandCount}. Binder runs /help, /resume, /clear, /fork, /rewind, /cd, /model, /effort, /mcp, /chrome, /artifacts and /exit itself; the rest
        go to Claude Code.
      </p>
      <p style={{ color: 'var(--text-faint)' }}>Esc closes this.</p>
    </div>
  );
}

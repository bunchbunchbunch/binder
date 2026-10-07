# Binder for Mac

A Mac app for [binder](../README.md): the same Claude Code sessions in tabs, with responses
rendered as real documents (heading sizes, tables, highlighted code, task lists) and the TUI's
keys. Everything runs from the keyboard; the mouse works too.

The app is a viewer. Each session runs in a binder session host (`binder host`), and the app
attaches to it over the host's unix socket, the same protocol the phone client uses
(`docs/remote-protocol.md` in the TUI). So the app, a binder TUI, and the phone can all watch
and drive one session at once, and a session keeps running when the app quits (a host with
nobody attached exits after 15 idle minutes).

## Requirements

- macOS on Apple silicon, Node 22 or newer.
- The TUI installed so `binder` is on your PATH (`npm install && npm run build && npm link` in
  `../tui`), at a version that has `binder sessions`. The app finds `node` and `binder` through
  your login shell, so it works when started from the Dock. `BINDER_BIN` (the path to the TUI's
  `bin/binder.mjs`) overrides the lookup.
- Your binder setup applies unchanged: `~/.config/binder/config.json` (`permissionMode`,
  `configDirs` for a second account, `stickyPrompt`), and everything Claude Code reads.
  Settings (`⌘,`) changes that file. The app also reads `appearance` and `panes` there (see
  [Settings](#settings) and [Panes](#panes-and-the-control-socket)).

## Run it

```sh
npm install
npx install-electron     # Electron 44 downloads its binary on request
npm run dev              # with hot reload
npm run dist             # builds release/mac-arm64/Binder.app (ad-hoc signed)
```

Copy `release/mac-arm64/Binder.app` to `/Applications` to keep it. `npm run icon` redraws the
icon from the TUI's pixel logo.

## Layout

- **Sidebar:** the panes, if config.json has any, and the sessions open in the app (`⌘1` to
  `⌘9`, panes first), then recent ones from
  `binder sessions`: live sessions first (a green dot; gold while a turn runs), then what
  `/resume` offers, across every config dir in `configDirs`.
- **Tab bar:** each prompt and its response is a tab, as in the TUI.
- **Transcript:** the prompt, the work (thinking and tool calls) folded into a one-line summary
  once the answer lands, then the answer. Tool calls have the TUI's views: Edit as a diff (blue
  added, orange removed), Write as the new file, Bash with its output, TodoWrite as a checklist,
  Read and Grep as one line with counts. Click a call to open it; output binder cut short loads
  in full on request. Once sent, the tab's latest prompt stays under the tabs while the
  transcript scrolls below it (its first 3 lines, with `+N lines` when it is longer); `Home` or
  a click shows it whole until the next scroll. `"stickyPrompt": false` in config.json turns
  this off.
- **Prompt:** with a status row above it (`Thinking… (12s · esc to interrupt)`, background
  tasks) and a status bar under it (folder, model and effort, permission mode, context size, and
  the 5-hour and 7-day usage).
- Open sessions come back on the next launch: live ones reattach, and the one on screen is
  resumed if its host had exited.
- Outside the window: the Dock icon shows how many sessions are waiting for an answer and
  bounces when a question arrives while you are in another app. Quitting while a turn runs asks
  first, since the turn keeps going in the background.

## Keys

The TUI's keys work the same way; `?` on an empty prompt lists them and `/help` explains them.

| Key | Action |
|-----|--------|
| `Enter` | send in a new tab (queued if a turn is running) |
| `Ctrl+Enter` | send into this tab: on a running turn it is sent now, otherwise after it |
| `Shift+Enter`, `Alt+Enter`, `\` `Enter` | newline |
| `Up` / `Down` | earlier / later prompts from this folder |
| `Tab`, `@` | complete a path (after `!`, a command) |
| `Tab` or `Right` (empty prompt) | take the suggested next prompt |
| `/` | command menu: Claude Code's commands plus binder's own |
| `!command` | bash mode, in its own tab |
| `Esc` | interrupt the turn (or stop a bash command); twice when idle: rewind |
| `Ctrl+N` / `Ctrl+P`, `Ctrl+Right` / `Ctrl+Left`, `Option+1-9` | switch tabs |
| `PgUp` / `PgDn`, `Home` / `End` | scroll the tab |
| `Ctrl+E` | expand or collapse the work behind a response |
| `Ctrl+O` | full tool output, thinking, and subagent detail |
| `Ctrl+V` | paste an image as `[Image #n]`, or text (`Cmd+V` and dropping files work too) |
| `Ctrl+]` | open the latest artifact |
| `Ctrl+R` | restart claude after it exits, or reopen a session that ended |
| `Ctrl+C` | copy the selection; twice with nothing selected quits |

Added for the sidebar:

| Key | Action |
|-----|--------|
| `⌘N` | new session: pick a recent folder, type a path, or choose one in Finder |
| `⌘K` | open a session: search every session (`Ctrl+A` all projects, `Ctrl+W` this repo's worktrees, `Ctrl+B` this branch) |
| `⌘1` to `⌘9`, `⌘⇧[` / `⌘⇧]` | switch between panes and open sessions |
| `⌘W` | close the session in the app (its host keeps running until idle) |
| `⌘,` | settings: binder's `config.json` (also Binder > Settings… and `/settings`) |
| `⌃⌘S` | hide or show the sidebar |

## Settings

`⌘,` shows binder's `config.json` and changes it, as `/settings` does in the TUI: the
permission mode for new sessions, the sticky prompt, the app's appearance, and config dirs
(add one by typing or choosing its folder, then its config dir; pick one to remove it). The
file is written in place, so a symlink into a dotfiles repo stays one, and keys the app does
not know stay. The sticky prompt and appearance change at once; open sessions keep the
permission mode and config dir they started with. The TUI's markdown style is there in the TUI
only.

Appearance is `"appearance": "light"` or `"dark"` in config.json; without it (Auto) the app is
light or dark as macOS is. The TUI ignores it: a terminal's colors are the terminal's.

Slash commands behave as in the TUI, with two differences: `/resume` opens the session picker
and shows the session alongside the others instead of replacing this one, and `/exit` closes the
session in the app rather than quitting.

## Panes and the control socket

A pane runs a program of yours in a terminal beside the sessions: a task list, a log, anything
with a terminal UI. List them in config.json:

```json
"panes": [{ "name": "Todos", "command": "npm run tui", "cwd": "~/code/todo" }]
```

Each pane is a sidebar entry, before the open sessions. Its command runs through your shell
when the app starts, in `cwd` (default: home), and keeps running while the app does; if it
exits, `Enter` in the pane starts it again. Keys go to the program, except `⌘` ones, which stay
the app's. The pane on screen at quit is on screen at the next launch, and the first pane is
when no session is.

The control socket lets programs drive the app. Panes, and the session hosts the app starts
(so Claude and the commands it runs), get its path in `BINDER_GUI_SOCKET`. Send one JSON line,
read one back:

```sh
printf '%s\n' '{"t":"open","cwd":"/path/to/project","sessionId":"<uuid>","draft":"Fix the bug","args":["-n","Fix the bug"]}' | nc -U "$BINDER_GUI_SOCKET"
# {"ok":true}
printf '%s\n' '{"t":"close","sessionId":"<uuid>","show":"Todos"}' | nc -U "$BINDER_GUI_SOCKET"
# {"ok":true,"closed":true}
```

- `open` shows the session, switching to it if the app has it open, otherwise opening it as
  `⌘K` does. `"resume": true` resumes `sessionId`; without it, a new session starts under that
  id. `draft` goes in the prompt, unsent, and `args` are flags for claude (binder's
  `-- <claude args>`), for a session this starts.
- `close` lets the session go from the app, as `⌘W` does; its host keeps running until idle.
  If the session was on screen, pane `show` takes its place. `closed` says whether the app had
  it open.
- A bad request gets `{"ok":false,"error":"..."}`.

So a task list in a pane can open a session for a task, and a skill in that session can close
it again and bring the list back when the task is done.

## How it works

- `src/main/` is Electron's main process. `binder.ts` reads the login shell's environment once,
  finds `node` and `binder` (resolving fnm's per-shell PATH entries to real folders), lists
  sessions with `binder sessions`, and starts `binder host --session-id|--resume <id>` in a
  session's folder when no host serves it. `hostConnection.ts` is one attached viewer: JSON lines
  over the socket, replies matched to requests, everything else forwarded to the window.
  `panes.ts` runs the panes' programs in ptys (node-pty), and `control.ts` serves the control
  socket, passing requests to the window to carry out.
- `src/preload/` exposes that as `window.binder`; the window has no Node access.
- `src/shared/wire.ts` mirrors the TUI's protocol types and applies its patches.
- `src/renderer/` is React. `store.ts` keeps each connection's state from the snapshot and
  patches; `components/SessionView.tsx` carries the TUI's keymap; `components/Markdown.tsx`
  renders responses with react-markdown, remark-gfm and highlight.js; `components/PaneView.tsx`
  is a pane's terminal (xterm.js).

## Tests

```sh
npm run typecheck
npm test                        # unit tests: patches, work folding, diff, commands, control requests
npm run e2e                     # builds, then drives the real app with Playwright
WINDOW_SHOTS=1 npx playwright test window   # captures the real window in light and dark mode
REVIEW_SHOTS=1 npx playwright test gallery  # screenshots of other states, for design reviews
```

The end-to-end tests start the built app against a real `binder host` running the TUI's fake
claude (`tui/test/fakeClaude.mjs`), each with its own temporary state, config and settings folders,
so your sessions are never touched. They run the TUI in `../tui`, so build it first (`BINDERTUI`
points elsewhere). `e2e/fixtures/make-showcase.mjs` writes the showcase turn they replay.
`e2e/packaged.spec.ts` runs `Binder.app` from `npm run dist` with launchd's bare environment,
as the Dock does.

## License

MIT.

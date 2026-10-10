# Binder for Mac

A Mac app for [binder](../README.md): the same Claude Code and Codex sessions in tabs, with
responses rendered as real documents (heading sizes, tables, highlighted code, task lists) and
the TUI's keys. Everything runs from the keyboard; the mouse works too.

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
  `configDirs` for a second account, `stickyPrompt`, and `agent`: `"codex"` starts new
  sessions as Codex), and everything Claude Code and Codex read.
  Settings (`⌘,`) changes that file. The app also reads `appearance`, `sidebar` and `panes`
  there (see [Settings](#settings), [Sidebar text](#sidebar-text) and
  [Panes](#panes-and-the-control-socket)).

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
  `binder sessions`: live sessions first (⏳ while a turn runs), then what `/resume` offers,
  across every config dir in `configDirs`. An open session's row shows its status (⏳ working,
  ❓ waiting for you, 🐝 background tasks, ✅ done since you last looked, ⚠️ stopped), how long
  its turn has run, its first prompt and its folder, unless config.json's `sidebar` says
  otherwise (see [Sidebar text](#sidebar-text)). Drag its right edge to resize it (the app
  remembers the width); double-click the edge for the default.
- **Tab bar:** each prompt and its response is a tab, as in the TUI.
- **Transcript:** the prompt, the work (thinking and tool calls) folded into a one-line summary
  once the answer lands, then the answer. Tool calls have the TUI's views: Edit as a diff (blue
  added, orange removed), Write as the new file, Bash with its output, TodoWrite as a checklist,
  Read and Grep as one line with counts. Click a call to open it; output binder cut short loads
  in full on request. Once sent, the tab's latest prompt stays under the tabs while the
  transcript scrolls below it (its first 3 lines, with `+N lines` when it is longer); `Home` or
  a click shows it whole until the next scroll. `"stickyPrompt": false` in config.json turns
  this off.
- **Prompt:** with a status row above it (`Thinking… (12s · esc to interrupt)`), a row for
  each background task (what it is doing, its kind, the tab that started it, and how long it
  has run) and a status bar under it (folder, model and effort, permission mode, context size, and
  the 5-hour and 7-day usage).
- **Background tasks:** a click on a task's row, or `/tasks`, lists them with the highlighted
  one's output (a shell's last lines, an agent's latest steps); `Enter` goes to the tab that
  started it, `x` or Stop stops it. `Ctrl+B` moves the running command or agent to the
  background, as in Claude Code. When a task finishes while another tab's turn runs, Claude
  sees its result there; once that turn ends, binder sends a follow-up into the tab that
  started the task, so Claude carries on with it there, under a gold `Background task
  finished: …` heading.
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
| `Up` (empty prompt) | edit the tab's queued prompt in place: `Enter` saves, empty removes, `Esc` cancels. A queued prompt's Edit and Remove buttons do the same |
| `Tab`, `@` | complete a path (after `!`, a command) |
| `Tab` or `Right` (empty prompt) | take the suggested next prompt |
| `/` | command menu: Claude Code's commands plus binder's own |
| `!command` | bash mode, in its own tab |
| `Esc` | interrupt the turn (or stop a bash command); twice when idle: rewind |
| `Ctrl+Right` / `Ctrl+Left`, `Ctrl+N`, `Option+1-9` | switch tabs |
| `Ctrl+L` | pick the model (`/model`) |
| `Ctrl+P` / `Shift+Ctrl+P` | switch to the next / previous model, as in pi |
| `Shift+Tab` | switch to the model's next effort level, as in pi |
| `PgUp` / `PgDn`, `Home` / `End` | scroll the tab |
| `Ctrl+E` | expand or collapse the work behind a response |
| `Ctrl+O` | full tool output, thinking, and subagent detail |
| `Ctrl+B` | move the running command or agent to the background (`/tasks` lists them) |
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
| `⌘/` | the guide: why the app works the way it does, then every key (also Help > Binder Guide) |
| `⌃⌘S` | hide or show the sidebar |

## Settings

`⌘,` shows binder's `config.json` and changes it, as `/settings` does in the TUI: the
permission mode for new sessions, the sticky prompt, the app's appearance, the sidebar's text,
and config dirs (add one by typing or choosing its folder, then its config dir; pick one to
remove it). The file is written in place, so a symlink into a dotfiles repo stays one, and keys
the app does not know stay. The sticky prompt, appearance and sidebar change at once; open
sessions keep the permission mode and config dir they started with. The TUI's markdown style is
there in the TUI only.

Appearance is `"appearance": "light"` or `"dark"` in config.json; without it (Auto) the app is
light or dark as macOS is. The TUI ignores it: a terminal's colors are the terminal's.

Slash commands behave as in the TUI, with two differences: `/resume` opens the session picker
and shows the session alongside the others instead of replacing this one, and `/exit` closes the
session in the app rather than quitting.

## Sidebar text

An open session's row in the sidebar has two lines, each a template in config.json's
`sidebar`. Settings (`⌘,`) edits them with a preview and the list of fields; edits to the file
show when the app next comes to the front.

```json
"sidebar": {
  "title": "{status} {elapsed} ([{modelLetter}]) {script|folder}",
  "subtitle": "{folder}( · {branch})",
  "script": "cat ~/.claude/summaries/$(jq -r .session_id) 2>/dev/null"
}
```

- `{field}` puts in a field, and `{a|b}` the first of them with a value.
- Text in `( )` shows only when a field inside it has a value, so `([{modelLetter}])` leaves no
  `[]` behind. A backslash makes the next character plain text: `\(`.
- Spaces left by empty fields collapse. An empty subtitle hides the second line; a title that
  comes out empty shows the first prompt. A misspelled field shows as written.
- The defaults are `{status} {elapsed} {title}` and `{folder}( · {waiting})`. Recent sessions
  keep their fixed text.

| Field | Shows |
|-------|-------|
| `status` | ⏳ a turn runs, ❓ a question waits for you, 🐝 background tasks run, ✅ a turn ended while you looked elsewhere (until you look), ⚠️ claude or its host stopped |
| `title` | the first prompt |
| `prompt` | the latest prompt |
| `folder`, `path` | the session's folder, and its path |
| `branch` | the folder's git branch |
| `model`, `modelLetter` | `Opus 5.5`, and `O` |
| `effort` | the effort level |
| `elapsed` | how long the running turn has taken, or the last one took, in whole minutes rounded down (`0m`, `3m`, `1h5m`) |
| `activity` | what the running turn does: `Thinking`, `Running Bash` |
| `waiting` | `waiting for you` while a question is open |
| `context` | tokens in context (`45.2k`) |
| `tabs`, `tasks` | how many tabs, and how many background tasks; empty at zero |
| `script` | the first line `sidebar.script` prints |

`sidebar.script` covers what the fields do not. It runs as Claude Code runs a `statusLine`
command: `sh -c` in the session's folder, with the session as JSON on stdin (`session_id`,
`cwd`, `model.id`, `model.display_name`, `title`, `prompt`, and `status`: `working`,
`waiting`, `background`, `done`, `stopped` or `idle`). Its first line, without colors, is
`{script}`. It runs when the session's state changes and every 10 seconds, for 5 seconds at
most. The example above shows a summary that a Claude Code hook writes per session.

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

A pane can show a web page instead of running a program: give it a `url` (http or https;
anything else is ignored) in place of `command`.

```json
"panes": [{ "name": "Todo GUI", "url": "https://example.com/desk" }]
```

It sits in the sidebar and counts for `⌘1` to `⌘9` as any pane does, and the control socket's
`show` can name it. The page loads when the app starts and stays loaded while the app runs,
with cookies of its own that last between launches.

- **Keys and focus:** selecting the pane gives the page the keyboard, and the page keeps its
  own focused field. Every key goes to the page except the app's: `⌘1` to `⌘9`, `⌘⇧[` /
  `⌘⇧]`, `⌘K`, `⌘N`, `⌘W`, `⌘,`, `⌘/` and `⌃⌘S`. So `⌘C`, `⌘V`, `⌘X`, `⌘A` and `⌘Z` edit the
  page's fields as usual. Another view, or a panel such as `⌘K`, takes the keyboard back to
  the app.
- **Its origin only:** the page stays on its URL's origin. Links elsewhere, and new windows,
  open in your browser. It has no Node access and gets no camera, microphone, location or
  notifications.
- **Signing in:** when the page does not load (a server that drops connections until you
  sign in, say), the pane shows the error. `Enter` tries again. Paste a link on the page's
  origin into the field there (a sign-in link that sets a cookie) and press `Enter`: it opens
  in the pane, then the page loads. Links to other origins are refused.

The page reaches the app through `window.binderPane`, and nothing else. Each call but `onShow`
returns a promise, and rejects when the page is not on the pane's origin.

- `home()`: your home folder, as an absolute path.
- `open({ cwd, sessionId, resume?, draft?, name? })`: the control socket's `open`, so it shows
  the session, switching to it if the app has it open. `cwd` is an absolute path to a folder
  inside home (normalized, so a trailing slash is fine) and `sessionId` a UUID. Without
  `resume` a new session starts under that id, with `draft` in its prompt, unsent, and `name`
  as claude's `-n`; `"resume": true` resumes it. A page cannot pass other claude flags. `draft`
  is at most 25000 characters and `name` 500.
- `completeFolder(input)`: a folder field's `Tab`, as in a terminal: `{ value, options }`.
  `~/` and relative paths are read from home. One match completes with a trailing slash;
  several extend `value` to their common prefix and come back in `options` (folder names,
  sorted). Dot-folders show once a `.` is typed, and symlinks to folders count.
- `missingFolder(input)`: the absolute path a folder field names when nothing is there yet,
  else `null` (blank, or it exists). `~` is home, and a relative path is under it.
- `makeFolder(path)`: creates the folder and any missing parents.
- `onShow(callback)`: calls `callback` each time the pane comes on screen (the sidebar,
  `⌘1-9`, or the control socket's `close` with `show`), and returns a function that stops it.
  A hidden pane's page gets no `visibilitychange` or `blur`, so this is how it knows to refresh.

Every path is normalized (`..` too) and must land inside home: outside it, `completeFolder`
offers nothing and the others reject. `makeFolder` only makes folders.

## How it works

- `src/main/` is Electron's main process. `binder.ts` reads the login shell's environment once,
  finds `node` and `binder` (resolving fnm's per-shell PATH entries to real folders), lists
  sessions with `binder sessions`, and starts `binder host --session-id|--resume <id>` in a
  session's folder when no host serves it. `hostConnection.ts` is one attached viewer: JSON lines
  over the socket, replies matched to requests, everything else forwarded to the window.
  `panes.ts` runs the panes' programs in ptys (node-pty), and `control.ts` serves the control
  socket, passing requests to the window to carry out. `webPanes.ts` shows web panes' pages,
  each in a WebContentsView over the window, and passes the window its `⌘` keys from them;
  `paneBridge.ts` checks what a page asks through `window.binderPane`.
- `src/preload/` exposes that as `window.binder`; the window has no Node access. A web pane's
  page gets `src/preload/pane.ts` instead: `window.binderPane`.
- `src/shared/wire.ts` mirrors the TUI's protocol types and applies its patches.
- `src/renderer/` is React. `store.ts` keeps each connection's state from the snapshot and
  patches; `components/SessionView.tsx` carries the TUI's keymap; `components/Markdown.tsx`
  renders responses with react-markdown, remark-gfm and highlight.js; `components/PaneView.tsx`
  is a pane's terminal (xterm.js), and `components/WebPaneView.tsx` holds a web pane's place
  (its page's view goes over it) and says why the page did not load.

## Tests

```sh
npm run typecheck
npm test                        # unit tests: patches, work folding, diff, commands, control requests, web panes
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

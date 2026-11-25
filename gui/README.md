# Binder for Mac

A Mac app for [binder](../README.md): the same Claude Code and Codex sessions in tabs, with
responses rendered as real documents (heading sizes, tables, highlighted code, task lists) and
the TUI's keys. Everything runs from the keyboard; the mouse works too.

The app is a viewer. Each session runs in a binder session host (`binder host`), and the app
attaches to it over the host's unix socket (or over SSH, for
[another computer's sessions](#other-computers)), the same protocol the phone client uses
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
  `configDirs` for a second account, `stickyPrompt`, `artifacts`, `fastMode`, `alwaysAllow`, `planApproval`, `restartOnUpdate`, `notifications`, `claudeLinks`, `showImages`, `editor`, `todoPanel`, `workflowCard`, `worktrees`, `diffBase`, `terminalCommand`, `prWatch`, `prAutoFix`, `findingsCard`, `fileEditing`, `splitView`, `sideChat`, `schedules`, `pluginReload`, `previewReload`, `previewCommand`, `simulatorFps`, and `agent`: `"codex"`
  starts new sessions as Codex), and everything Claude Code and Codex read.
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

An ad-hoc signature changes with every build, so macOS treats each rebuild as a new app and
drops the privacy permissions you gave it (Screen Recording, Automation and the like). To keep
them, sign with a certificate from your keychain: set `BINDER_SIGN_IDENTITY` to its SHA-1 hash
(from `security find-identity -v -p codesigning`; a free Apple Development certificate from
Xcode works) before `npm run dist`. The app then keeps the same identity across rebuilds, and you
grant each permission once. If that certificate is gone (expired, or renewed under a new hash),
the build stops and says so instead of producing an app macOS would treat as new.

## Layout

- **Sidebar:** the panes, if config.json has any, and the sessions open in the app (`⌘1` to
  `⌘9`, panes first). `⌘K` finds the rest. A session's row shows its status (⏳ working,
  ❓ waiting for you, 🐝 background tasks, ✅ done since you last looked, ⚠️ stopped), how long
  its turn has run, its name (or first prompt) and its folder, unless config.json's `sidebar` says
  otherwise (see [Sidebar text](#sidebar-text)). Below them: New session (`⌘N`) and Help
  (`⌘/`). Drag its right edge to resize it (the app remembers the width); double-click the
  edge for the default.
- **Tab bar:** each prompt and its response is a tab, as in the TUI. A session with a title
  (`/rename <title>`, `/fork <title>`, or a name it was started with) shows it above the tabs.
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
  has run) and a status bar under it (folder, model and effort, permission mode, the context,
  and the 5-hour and 7-day usage). The context reads `45.2k/200k 23%` (tokens, the model's
  window, the share in use) unless config.json's `statusText` says otherwise: a template with
  the [sidebar's fields](#sidebar-text), so `{context}( · {cost})` adds what the session has
  cost at API list prices (on a subscription it comes out of your plan's usage). Settings (`⌘,`)
  edits it with a preview. A click on the folder, the model, the effort level or the permission
  mode opens its picker; a click on the context shows what it holds, by category, as
  `/context` counts it. Picking a folder moves the session there, as `/cd` does,
  between turns. A permission mode picked there, with `⌥M`, or with `/permission-mode` lasts
  until the session restarts; Claude Code allows bypass permissions only in a session that
  started in that mode. `↯ fast` shows there while fast mode is on (`⌥O` or `/fast`); a click
  turns it off.
- **Permission prompts:** Allow, Deny, and the "always allow" choices Claude Code suggests: one
  for its rules (Claude Code saves them where it says, such as this project's
  `.claude/settings.local.json`) and one for switching the mode (`Allow, and accept all edits
  from now on`). `"alwaysAllow": false` in config.json leaves Allow and Deny only.
- **Attachments:** drop or paste images, PDFs and text files on the prompt. An image is
  `[Image #n]`; a PDF or text file is `[File #n: name]` with a chip, and goes with the prompt (a PDF
  as a document Claude reads, up to 32 MB; a text file as its text, up to 512 KB), so it works
  for a session on another computer too. Any other file on this Mac is mentioned by its path.
  One prompt's attachments may come to 60 MB as sent (base64, about 45 MB of files); more is
  refused before sending. A send that is refused or fails keeps the prompt and its attachments.
- **A terminal per session:** `⌃\`` opens the session's own terminal under the prompt: your
  login shell in the session's folder (on another computer, over ssh), or config.json's
  `terminalCommand`, run with `$SHELL -c`. Its keys are its own (Esc, Ctrl+C), except ⌘ keys and
  `⌃\``, which hides it; it keeps running while hidden and ends when the session closes (or the
  session's own window does).
- **Reviewing changes:** `/diff` opens the session folder's changes in a pane over the session,
  file by file with line numbers, against HEAD (what is not committed) or a branch picked at
  the top (config.json `diffBase` sets the default); `/diff <branch>` opens against that branch.
  A click on a line opens a comment there (Enter saves it, and `⌘⏎` in it saves it and sends);
  Send (`⌘⏎`) hands every comment to Claude in one prompt, each with its file, line and the
  line itself. `Esc` closes the pane.
- **Preview:** `/preview` starts the session folder's dev server (package.json's `dev` script,
  else `start`, with the package manager its lockfile names; config.json `previewCommand` sets
  another) and shows the address it prints beside the session. `/preview <url>` (or a port, or
  a host and port such as `localhost:3000`, `myhost:3000` or `192.168.1.5:5173`, with `0.0.0.0`
  read as localhost) opens a server already running; `/preview <command>` starts that one. The
  page reloads when a turn ends (`"previewReload": false` leaves it to ↻), its console errors
  count at the foot (a click lists them), and `Show Claude` sends Claude a capture of the page
  and those errors, into the session's tab, to check its own changes. The server's output is
  a click away too; × closes the preview and stops the server and what it started (a hangup,
  then SIGTERM and SIGKILL for one that ignores it). Quitting the app stops them the same way,
  so it can take about 3 seconds then. On this Mac only.
- **iOS Simulator:** `/simulator` (or `/sim`; again to close) shows an iOS Simulator device
  beside the sessions, through Xcode's `simctl`: its screen, captured about once a second
  (`"simulatorFps"`: 1, 2 or 4) while the pane is on screen and the window is not hidden or
  minimized. Pick the device (an iPhone or iPad) at the top; `Boot` starts one that is not
  running (with no window); `Open in Simulator` is where you tap and type; `Show Claude` sends
  the active session a capture of the screen, unless it runs on another computer. Needs Xcode
  and its iOS platform on this Mac.
- **Plugins:** `/plugins` lists the installed plugins (one opens Enable or Disable, and Uninstall),
  `Install a plugin…` (the marketplaces' plugins, filtered as you type), and `claude.ai
  connectors…` with their state. A change loads into the running session at once, its commands
  included; `"pluginReload": false` leaves it for claude's next start.
- **Scheduled tasks:** `/schedule weekdays 9:00 <prompt>` runs the prompt on a schedule, each run
  in a fresh session in the session's folder named for the task (`daily 9:00`, `weekdays 17:30`,
  `mon,thu 8:00`, `hourly`, `every 15m`, or a cron line). `/schedule` alone lists the tasks with
  their next run: one opens Run it now, Pause, Runs (Enter opens a run's session) and Delete.
  They run on this Mac while the app is open (it checks each minute); `"schedules": false`
  runs none.
- **Side questions:** `/btw <question>` opens a side chat above the prompt: Claude answers from
  the conversation so far, without tools, and none of it goes into the transcript; it works
  while a turn runs. Its own box asks the next one (with the earlier ones as context); `Esc`
  or × closes it. `"sideChat": false` sends `/btw` to Claude Code as typed.
- **Two at once:** `⌘\` shows two sessions side by side: the active one and the next. A click
  in either half (or `⌘1-9`) gives it the keyboard, marked by a blue line on top; a session
  picked from the sidebar takes the place of the half that had the keyboard; `⌘\` again shows
  one. `/window` moves the session to a window of its own (no sidebar; `⌘W` closes it and its
  session terminal, and the session's binder keeps running until idle). If that binder ends, the window stays open with
  "The session ended. ⌃R reopens it."; `/exit` closes it. A session's window has no claude.ai
  pane (its links open in the browser) or simulator, and `⌘N` there says new sessions open
  from the main window. `"splitView": false` turns both off.
- **Files:** `⌘P` finds a file in the session folder by part of its name or path, and opens
  the file pane over the session: the folder's tree on the left, the file highlighted with line
  numbers on the right. `/open <path>` opens one directly. `Edit` makes it a text box (Tab and
  Shift+Tab indent and outdent the selected lines, and a file with CRLF line endings keeps
  them) that `⌘S` saves; a file changed on disk since you opened it (Claude edited it, say)
  asks before it is saved over. A file you are not editing is read again when a turn ends.
  `Esc` leaves editing (twice with unsaved changes), then closes the pane. It works through the
  session's binder, so a session on another computer works the same. `"fileEditing": false`
  makes the pane read only, and the session's binder then refuses saves from any viewer;
  turned off in the middle of an edit, `⌘S` says so and writes nothing.
- **Code review findings:** a code review (`/code-review`) shows its findings as a card in
  place of its text: each with its severity, file and line (a click opens it), what is wrong
  and its failure scenario, and `Fix this one`; `Apply fixes` asks for the rest in one prompt.
  Both go into the review's tab. `/findings` lists them too, and the diff pane (`/diff`) shows
  each under its line with its own `Fix this one`. `"findingsCard": false` keeps the review as text.
- **Pull requests:** the status bar shows the branch's PR from the GitHub CLI (`gh`): its
  number, green with its checks passing, red with how many failed or with a review asking for
  changes, gold while they run, and plain with no checks (or only skipped ones). A
  click (or `/pr`) opens it in the browser, asks Claude to fix the failing checks or address a
  review asking for changes, merges it when ready (`gh pr merge --auto --squash`), or looks
  again; binder looks every minute while the PR is open, and after each turn. With
  `"prAutoFix": true` Claude is asked on its own, once per failure. `"prWatch": false` turns it off.
- **Workflows:** a workflow asks with a card of its name, description and phases (`Run once`,
  `Always allow workflows` in this project, `Deny`), and its run shows its phase and agents in
  the background task row and in `/tasks`. `"workflowCard": false` asks a plain Allow / Deny.
- **Todos and plan:** the session's latest todo list and its current plan stay above the prompt,
  one line each (`Todos 1/3 · ◐ Writing the tests`, `Plan: Add hello.txt · approved`); a click
  opens one, and `⌃T` opens both. `"todoPanel": false` leaves them in the transcript only.
- **Files:** a tool call's file (Read, Edit, Write, a Codex patch) is a link: a click opens it in
  your editor, at a Read's line, and Option-click shows it in Finder. `/files` lists the tab's
  files the same way. config.json's `editor` says how: `open` (the file's default app, the
  default), a command (`code`), or one with `{file}` and `{line}` (`code -g {file}:{line}`);
  Settings offers the common editors. A session on another computer's files stay put.
- **Images:** a tool's images (a screenshot, a Read of an image file) show under its call, the
  ones you send show under your prompt, and a markdown image of a file on this Mac (an
  absolute path, `~/...`, or relative to the session's folder) shows in the response. An image
  from the web waits behind a "load from <host>" button, so showing a response never fetches a
  URL by itself. A click enlarges an image. `"showImages": false` leaves captions.
- **claude.ai pages beside the session:** a claude.ai link (a doc, sheet or artifact) in a
  response, in `/artifacts`, or from `⌃]` opens in a pane to the right of the session instead of
  the browser. Its title bar has Open in browser and ×; `⌃\` closes the pane and opens its last
  page again. It keeps its own cookies between launches, so you sign in to claude.ai there
  once; the page can go to claude.ai and its sign-in (a claude.ai link that opens a new tab
  stays in the pane), and other links open in the browser. `⌃\` and `⌃]` work while the page
  has the keyboard.
  `"claudeLinks": "browser"` in config.json opens them in the browser as before.
- **Plans:** when Claude finishes a plan in plan mode, the question card shows it as markdown
  (it scrolls on its own when long) with `Yes, and use auto mode`, `Yes, and auto-accept
  edits`, `Yes, and manually approve edits`, `No, keep planning`, and `No, and tell Claude what
  to change` for typed feedback. Each yes approves the plan and sets that mode. Once answered,
  the plan stays in the transcript. `"planApproval": false` asks a plain Allow / Deny.
- **Background tasks:** a click on a task's row, or `/tasks`, lists them with the highlighted
  one's output (a shell's last lines, an agent's latest steps); `Enter` goes to the tab that
  started it, `x` or Stop stops it. `Ctrl+B` moves the running command or agent to the
  background, as in Claude Code. When a task finishes while another tab's turn runs, Claude
  sees its result there; once that turn ends, binder sends a follow-up into the tab that
  started the task, so Claude carries on with it there, under a gold `Background task
  finished: …` heading.
- After binder is rebuilt, each open session's host still runs the old code, so a new key or
  panel would fail there ("Unknown request"). The host notices the rebuild, and the app
  restarts it on the new build once the session is idle: no turn running or queued, no
  question, background task or bash command, no panel open, and nothing typed in the prompt
  of the session on screen. The session resumes with its tabs, permission mode and fast mode.
  `"restartOnUpdate": false` in config.json turns this off.
- Open sessions come back on the next launch: live ones reattach, and the one on screen is
  resumed if its host had exited. A session that cannot start says why in its host's own words
  (`Could not open the session. Not in a git repo: …`).
- Outside the window: the Dock icon shows how many sessions are waiting for an answer and
  bounces when a question arrives while you are in another app. A question, or a turn that
  finishes, in a session you are not looking at (another session is on screen, or the app is
  in the background; in split view, both halves count as on screen) posts a macOS
  notification: the session's name, and the question or the answer's first line. A click on
  it brings that session forward. `"notifications": false` in
  config.json turns them off. Quitting while a turn runs asks
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
| `Option+M` | switch to the next permission mode, skipping any Claude Code refuses (`/permission-mode` picks one) |
| `Option+O` | fast mode on or off (`/fast`) |
| `PgUp` / `PgDn`, `Home` / `End` | scroll the tab |
| `Ctrl+E` | expand or collapse the work behind a response |
| `Ctrl+O` | full tool output, thinking, and subagent detail |
| `Ctrl+T` | open the pinned todos and plan, or close them |
| `` Ctrl+` `` | the session's terminal: show (and focus) it, or hide it |
| `Ctrl+B` | move the running command or agent to the background (`/tasks` lists them) |
| `Ctrl+V` | paste an image as `[Image #n]`, or text (`Cmd+V` and dropping files work too) |
| `Ctrl+]` | open the latest artifact (beside the session) |
| `Ctrl+\` | close the claude.ai side pane, or open its last page again |
| `Ctrl+R` | restart claude after it exits, or reopen a session that ended |
| `Ctrl+C` | copy the selection; twice with nothing selected quits |

Added for the sidebar:

| Key | Action |
|-----|--------|
| `⌘N` or `⌘T` | new session: pick a recent folder, type a path, or `⌘O` to choose one in Finder. `⌥⏎` starts it in a new git worktree of the folder's repo (config.json `worktrees`, see the TUI's README); archiving the session in `⌘K` removes the worktree and its branch, but keeps a worktree with changes not committed (and its branch), a branch not merged, and both while the session is open |
| `⌘K` | open a session: search every session (`Ctrl+A` all projects, `Ctrl+W` this repo's worktrees, `Ctrl+B` this branch). Three characters or more also search what was said in each, on every computer, and show the matching text. `⌃X` archives the highlighted session out of the list; `⌃D` shows the archived ones, where `⌃X` brings one back |
| `⌘P` | find a file in the session folder by part of its name or path, and open it in the file pane (`/open`) |
| `⌘\` | two sessions side by side, or one again (see Two at once) |
| `⌘1` to `⌘9`, `⌘⇧[` / `⌘⇧]` | switch between panes and open sessions |
| `⌘W` | close the session in the app (its host keeps running until idle) |
| `⌘,` | settings: binder's `config.json` (also Binder > Settings… and `/settings`) |
| `⌘/` | the guide: why the app works the way it does, then every key (also Help > Binder Guide) |
| `⌃⌘S` | hide or show the sidebar |

## Settings

`⌘,` shows binder's `config.json` and changes it, as `/settings` does in the TUI: the
permission mode for new sessions, the sticky prompt, artifacts, fast mode at the start of a
session, the "always allow" choices, where claude.ai links open, pull request watching and
auto-fix, the session terminal, the diff base, worktrees, the workflow card, the todo and plan
panel, your editor, images, notifications, plan approval, the findings card, file editing, the
preview's reload and server, the simulator's refresh rate, plugin changes, scheduled tasks,
side chat, split view and windows, restarting sessions on a new build, the app's appearance,
the sidebar's text, the status text, and config dirs (add one by typing or choosing its
folder, then its config dir; pick one to remove it). The file is written in place, so a
symlink into a dotfiles repo stays one, and keys the app does not know stay. Open sessions
keep the permission mode, artifacts, fast mode, always allow, plan approval, pull request
watching and auto-fix, workflow card and config dir they started with, so those apply to
sessions opened from then on. The rest change at once, the diff base and plugin changes
included (the session terminal, preview server and worktrees the next time one starts). The
TUI's markdown style is there in the TUI only.

Appearance is `"appearance": "light"` or `"dark"` in config.json; without it (Auto) the app is
light or dark as macOS is. The TUI ignores it: a terminal's colors are the terminal's.

Slash commands behave as in the TUI, with these differences: `/resume` opens the session picker
and shows the session alongside the others instead of replacing this one; `/exit` closes the
session in the app rather than quitting; `/preview`, `/simulator` (`/sim`), `/open` and
`/window` are the app's own (see [Layout](#layout)); and the TUI's `/markdown` is not offered.

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
  comes out empty shows the `title` field. A misspelled field shows as written.
- The defaults are `{status} {elapsed} {title}` and `{folder}( · {waiting})`.

| Field | Shows |
|-------|-------|
| `status` | ⏳ a turn runs, ❓ a question waits for you, 🐝 background tasks run, ✅ a turn ended while you looked elsewhere (until you look), ⚠️ claude or its host stopped |
| `title` | the session's name (`/rename`), or else the first prompt |
| `prompt` | the latest prompt |
| `folder`, `path` | the session's folder, and its path |
| `branch` | the folder's git branch |
| `model`, `modelLetter` | `Opus 5.5`, and `O` |
| `effort` | the effort level |
| `elapsed` | how long the running turn has taken, or the last one took, in whole minutes rounded down (`0m`, `3m`, `1h5m`) |
| `activity` | what the running turn does: `Thinking`, `Running Bash` |
| `waiting` | `waiting for you` while a question is open |
| `context` | tokens in context (`45.2k`) |
| `maxTokens` | the model's context window (`200k`), once a turn has reported it |
| `percent` | how much of the window the context fills (`23%`) |
| `cost` | what the session has cost, at API list prices (`$0.42`) |
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
  `⌘⇧]`, `⌘K`, `⌘N`, `⌘T`, `⌘W`, `⌘,`, `⌘/` and `⌃⌘S`. So `⌘C`, `⌘V`, `⌘X`, `⌘A` and `⌘Z` edit the
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

## Other computers

The app can show another Mac's sessions beside this one's, so what Claude opens on screen
(browsers, test windows, the iOS Simulator) opens there. List SSH destinations in this Mac's
config.json, each anything `ssh` takes (a `Host` in `~/.ssh/config`, or `user@host`):

```json
{ "computers": ["mini"] }
```

That computer's sessions show in the sidebar and `⌘K` with its name beside them. `⌘N` offers a
typed folder on each computer that has it (`Start in ~/code/app on mini`), and a recent folder
starts where its sessions ran. Restart the app after changing the list.

`"defaultComputer": "mini"` (one of `computers`) makes new sessions start there: its row comes
first in `⌘N`, so Enter starts there, and the control socket's `open` (a pane's, say) starts a
session the app does not know there too, in the same folder under that computer's home
(`/Users/me/code/app` becomes `~/code/app`). A session the app knows reopens where it runs, and a
web pane's `open` checks its folder on the computer it starts on.

The other computer needs:

- SSH by key with no prompt (the app runs ssh with `BatchMode=yes`): Remote Login on, and this
  Mac's key in its `~/.ssh/authorized_keys`.
- binder on its login shell's PATH (`npm link` in its `tui`), Claude Code signed in, and you
  logged in at its screen.

The app runs that computer's `binder sessions`, `binder start` and `binder attach` over one shared
ssh connection (`ControlMaster`). `binder start` sees the SSH login and has launchd start the
host in your login session there, where it can read Claude Code's sign-in from the keychain
(an SSH login cannot) and open windows on that screen; the host gets the login shell's
environment. `binder attach` pipes the host's socket, so the session works as one here does.

What stays here: panes, the clipboard, links (they open in this Mac's browser, so a `localhost`
link from a session there points here), the control socket (its `open` starts sessions on this
Mac unless `defaultComputer` says otherwise), and Settings, which edit this Mac's config.json. A session on another computer reads that
computer's config.json (`permissionMode`, `configDirs`), and `sidebar.script` runs there, where
the files it reads are. Choose a folder… browses this Mac; type a path for another computer.

## How it works

- `src/main/` is Electron's main process. `binder.ts` reads the login shell's environment once,
  finds `node` and `binder` (resolving fnm's per-shell PATH entries to real folders), lists
  sessions with `binder sessions`, and starts `binder host --session-id|--resume <id>` in a
  session's folder when no host serves it. `remote.ts` does the same on
  [another computer](#other-computers) over ssh. `hostConnection.ts` is one attached viewer: JSON
  lines over the socket (or ssh's stdin and stdout), replies matched to requests, everything else
  forwarded to the window.
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
as the Dock does. `e2e/remote.spec.ts` drives another computer's sessions through
`e2e/fixtures/fake-ssh`, which runs the command here with that computer's own state.

## License

MIT.

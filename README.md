# BinderTUI

One headless Claude Code session, in tabs.

`binder` runs the real `claude` binary in the background (`claude -p` with stream-json in and
out) and shows one conversation as tabs: each prompt and its response is a tab. The
session id persists, so quitting and relaunching restores the tabs and continues the
conversation. All existing Claude Code configuration applies unchanged: account routing
via `CLAUDE_CONFIG_DIR`, hooks, plugins, MCP servers, CLAUDE.md, skills, and the status
line script from `settings.json`.

## Install

```sh
npm install
npm run build
npm link        # puts `binder` on PATH
```

## Usage

```
binder                     start a new session in the current directory
binder <session-id>        resume a session
binder -r, --resume <id>   resume a session
binder -c, --continue      resume the latest binder session started in this directory
binder --session-id <id>   start a new session with this id (a launcher can link it first)
binder --draft <text>      start with <text> in the prompt, unsent
binder -r <id> --fork-session
                           continue a session as a new one; the original stays as it was
binder -- <claude args>    pass flags to claude, e.g. binder -- --model opus
```

On quit, binder prints `Resume with: binder <id>`. Resuming a session binder never ran
(one from plain Claude Code) shows its conversation from Claude Code's transcript.

Binder leaves the permission mode to Claude Code (`permissions.defaultMode` in
`settings.json`) unless `config.json` sets one or you pass `binder -- --permission-mode
<mode>`. Prompts that ask for permission show an Allow / Deny picker.

## Configuration

Binder reads optional defaults from `~/.config/binder/config.json` (`BINDER_CONFIG` points
elsewhere):

```json
{
  "permissionMode": "bypassPermissions",
  "configDirs": { "~/work": "~/.claude-work" },
  "stickyPrompt": true
}
```

- `permissionMode` is passed to claude as `--permission-mode`, unless you pass one after `--`.
- `configDirs` maps folders to a Claude Code config dir, for example a second account for
  work repos: claude run inside `~/work` gets `CLAUDE_CONFIG_DIR=~/.claude-work`. It applies
  only when `CLAUDE_CONFIG_DIR` is not set already, so a shell hook that sets it still wins;
  it covers launches that skip your shell, such as `binder serve` under launchd.
- `stickyPrompt` keeps the prompt in view while you read its response: once a turn's prompt
  scrolls out of the top of the tab, its first 3 lines stay pinned there, over the response,
  with `+N lines` when it is longer. `Home` shows the whole prompt at the top of the tab. In
  a tab with follow-ups, the pinned prompt is the one for the turn on screen. Off by default;
  the Mac app reads it too.

## Keys

| Key | Action |
|-----|--------|
| `?` (empty prompt) | show the shortcuts in a box above the prompt; the next key closes them |
| `Enter` | send the prompt (opens a new tab; queued if a turn is running) |
| `Ctrl+Enter` | send the prompt into the current tab instead: on a running turn it is sent now (Claude Code's "send now": the turn stops and the follow-up runs next), otherwise it runs after the current turn. Needs a terminal with the kitty keyboard protocol (iTerm2, kitty, WezTerm, Ghostty); elsewhere it acts as `Enter` |
| `Shift+Enter`, `Alt+Enter`, or `\` then `Enter` | newline in the prompt. `Shift+Enter` needs the kitty keyboard protocol, like `Ctrl+Enter`; elsewhere it sends, so use `Alt+Enter` |
| `Up` / `Down` | earlier / later prompts from this directory (inside a multi-line prompt they move between lines first) |
| `Tab` | complete the path before the cursor (after `!`, the command name); with several matches it fills the common part, then lists them |
| `Tab` or `Right` (empty prompt) | take the suggested next prompt. After a turn, Claude Code may predict what you will ask next; like Claude Code, binder shows it dim in the empty prompt. Typing replaces it, and `Enter` alone does not send it |
| `@` | list files as you type a path after it |
| `!command` | bash mode: binder runs the command in the session's directory and shows it in its own tab; the output goes to the model with your next prompt. `Esc` stops it |
| `Ctrl+N` / `Ctrl+P`, `Ctrl+Right` / `Ctrl+Left` | next / previous tab |
| `Option+Left` / `Option+Right` | move the cursor by a word in the prompt |
| `Shift+arrows`, `Shift+Option+arrows`, `Shift+Home/End` | select text (typing, paste, Backspace and Delete act on the selection) |
| `Ctrl+C` with text selected | copy the selection, like Claude Code. `Cmd+C` works too in terminals that pass it on; iTerm2 keeps `Cmd+C` for its own mouse selection |
| `Option+Backspace` / `Option+Delete` | delete a word backward / forward |
| `Ctrl+V` | paste the clipboard: an image as `[Image #n]`, like Claude Code, or else its text (long text collapses as a paste does) |
| `Cmd+V` | paste text. Like Claude Code, a paste over 800 characters or with more than 2 line breaks shows as `[Pasted text #n +N lines]`; the full text is sent |
| `Alt+1` to `Alt+9` | jump to tab |
| mouse wheel or trackpad, `PgUp` / `PgDn` (`Fn+Up` / `Fn+Down` on a Mac), `Home` / `End` | scroll the active tab (output auto-follows until you scroll up). Binder turns on mouse reporting for the wheel, so select text with the mouse by holding `Option` (iTerm2) or `Shift` (most other terminals) while dragging |
| `Esc` | interrupt the running turn |
| `Esc` twice (idle) | rewind (see `/rewind`) |
| `Ctrl+]` | open the latest artifact published in this session |
| `Ctrl+E` | expand / collapse the work (thinking and tool calls) behind a response |
| `Ctrl+O` | toggle full tool output, thinking, and subagent detail |
| `Ctrl+R` | restart the child after it exits unexpectedly |
| `Ctrl+C` twice | quit |

While a turn runs, its work streams in full, and a row above the prompt shows what it is
doing and for how long (`Thinking… (12s · esc to interrupt)`, `Running Bash…`). When the
response arrives, or the model asks a question, the work folds into a one-line summary
above the response; `Ctrl+E` unfolds it.

AskUserQuestion prompts render as a picker: arrows or a number select, `Space` toggles
in multi-select, `Enter` confirms, "Other" lets you type a free answer.

`ultrathink` anywhere in a prompt asks for deeper reasoning on that turn, as in Claude Code:
the child passes the request to the model, and binder draws the word in rainbow letters
(with a shimmer while you type) and notes "Deeper reasoning requested for this turn".

## Slash commands

Typing `/` opens a menu of commands, like Claude Code's: the list comes from the child
(skills, plugin commands, and the built-ins headless Claude Code runs, such as `/context`,
`/compact`, `/usage`, `/config`). Up/Down move, Tab completes, Enter runs, Esc closes. A
command that needs an argument (`/cd <path>`) is filled in for you to finish.

Binder runs some itself, because headless Claude Code refuses them, they change which
session or directory the child is on, or they need a picker:

| Command | Action |
|---------|--------|
| `/help` | keys and commands, in place of the transcript until `Esc` |
| `/resume [id]` | pick a session to resume, with search: this folder by default, `Ctrl+A` all projects, `Ctrl+W` this repo's worktrees, `Ctrl+B` this branch. Lists interactive Claude Code sessions and binder's own, not other headless `claude -p` runs. A session from another folder resumes there |
| `/clear` (`/reset`, `/new`) | start a fresh session; the current one stays resumable with `/resume` |
| `/fork [title]` (`/branch`) | continue in a new session forked from this one (`--fork-session`); the original stays resumable |
| `/rewind` (`/checkpoint`, or `Esc` twice) | pick an earlier prompt, then restore the code, the conversation, or both to just before it. The prompt comes back in the composer. Binder turns on Claude Code's file checkpoints for this (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`) |
| `/cd <path>` | move the session to another directory (asks to trust a new folder first); a folder that `configDirs` gives another config dir is refused |
| `/model [model]` | pick from the models the child offers, or set one by name |
| `/effort [level]` | pick the effort level for this session, or set one by name |
| `/mcp` | MCP servers and their status; pick one to authenticate (opens the sign-in page), reconnect, enable or disable it, or clear its authentication |
| `/chrome` | Claude in Chrome: extension status, enable or disable it for this session (restarts claude with `--chrome`), and links to reconnect or manage permissions |
| `/artifacts` | artifacts published in this session: `Enter`/`o` opens one, `c` copies its link |
| `/exit` (`/quit`) | quit |

`/resume`, `/clear`, `/fork`, `/rewind` and `/cd` wait until no turn is running or queued.

## Remote control

A phone (or any client that speaks `docs/remote-protocol.md`) can list this computer's
binder sessions, start or resume one, and drive it like the TUI: prompts, follow-ups and
send-now, interrupts, AskUserQuestion and permission answers, bash mode, `/rewind`,
`/clear`, `/fork`, `/resume`, `/cd`, `/model`, `/effort`, `/mcp`, artifacts, prompt history
and path completion. The TUI and a remote client can watch and drive the same session at
once.

- Every live session (a TUI, or `binder host` with no UI) listens on a unix socket in
  `~/.local/state/bindertui/sock/` (mode 700). The socket and its pid file are the
  session's lock: a second `binder --resume` of a live session is refused.
- `binder serve` is the gateway. It keeps one outbound WebSocket to a relay, so the
  computer needs no open port. Clients and the computer run a Noise IK handshake
  (X25519, ChaCha20-Poly1305, SHA-256) end to end, so the relay only forwards ciphertext:
  it can block traffic but cannot read it or send commands. Only enrolled client keys get
  in, and only to sessions inside `allowedRoots`.
- `relay/` is the relay: about 150 lines of Node, with a Dockerfile. Put it behind a TLS
  reverse proxy that lets only your clients reach `/relay/mac` and `/relay/phone`, and set
  `RELAY_SECRET` (sent by the proxy as `X-Relay-Secret`) so nothing on the relay's host
  can connect around the proxy.

Set up:

```sh
binder remote init --relay wss://relay.example/relay/mac --token-file ~/.relay-token --root ~/code
binder remote key                       # paste this into the client
binder remote enroll <client key> phone # the key the client shows; compare fingerprints
cp docs/com.binder.serve.plist ~/Library/LaunchAgents/   # edit the paths, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.binder.serve.plist
```

`binder remote status` shows the key, clients, relay, roots and the log
(`~/.config/binder/remote.log`, one line per client request). `binder remote pause` refuses
every client until `unpause`; `binder remote revoke <name>` removes one. With
`"launcher": "iterm"` in `~/.config/binder/remote.json`, sessions a client starts open as
binder tabs in iTerm (macOS asks once to let the gateway control iTerm); the default
`headless` starts `binder host`, which exits after 15 idle minutes with nobody attached.

## Output rendering

Responses are rendered by binder's own markdown renderer (`src/ui/md/`), built on marked's
lexer, with 24-bit color throughout:

- **Headings** at three visible levels: H1 gold with a full-width rule, H2 blue with an
  underline, H3 purple with a bar. Claude's own output rarely distinguishes them, so binder
  does.
- **Tables** with box-drawing borders, column alignment, and cells that wrap when the
  table is wider than the terminal.
- **Code** on a shaded band with the language label and syntax highlighting
  (cli-highlight, loaded lazily on the first code block, ~80ms once).
- **Lists** with `•` `◦` `▪` bullets by depth, task boxes `☑` `☐`, blockquotes with a bar,
  OSC 8 hyperlinks (Cmd-click in iTerm2).
- **Tool calls** have per-tool views: Edit shows a line diff (blue added, orange removed,
  the daltonized convention), Write shows the new file, Bash its output, TodoWrite a
  checklist, Read and Grep a one-line summary with counts.

Markdown renders while streaming, throttled to at most every 150ms (stretching when a
render is slow). A 1.6k-char response renders in about 5ms warm; 32k chars with 40 code
blocks in about 60ms. `npx tsx test/manual/renderMd.ts fixtures/sample.md` prints a
sample with timings.

## Performance

The transcript is drawn as a flat list of pre-rendered lines (`src/ui/tabLines.ts`),
cached per block, and only the rows on screen are handed to Ink. Ink then lays out and
diffs about one screenful no matter how long the conversation is, and with
`incrementalRendering` it rewrites only the lines that changed. Stream events are applied
in 16ms batches, and `bin/binder.mjs` runs React's production build (without passing
`NODE_ENV` on to claude).

`npm run bench` replays a synthetic turn (40 tool calls plus a 10k-char answer) through
the real App into a fake 120x45 terminal. Measured on 2026-10-04, before and after the
row model:

| | Before | After |
|---|---|---|
| CPU while streaming the long turn | 4.5s | 1.4s |
| CPU while streaming a 150-tool, 40k-char turn | 15.7s | 4.0s |
| Keystroke to screen, long turn / huge turn | 26ms / 87ms | 12ms / 12ms |
| Bytes written per keystroke | 6.6KB | 0.2KB |
| Frame render time p95, huge turn | 90ms | 9ms |
| RSS after the long turn | 300MB | 178MB |

`node test/perf/makeLongTurn.mjs 150 25 > fixtures/huge-turn.jsonl` and
`BENCH_FIXTURE=huge-turn.jsonl npm run bench` reproduce the large case. Set
`BINDER_FULL_REDRAW=1` to turn incremental rendering off.

## How it works

- `src/claudeProcess.ts` spawns `claude -p --input-format stream-json --output-format
  stream-json --include-partial-messages --permission-prompt-tool stdio` once per launch
  and writes one JSON user message per prompt. `--permission-prompt-tool stdio` is what
  makes AskUserQuestion available headless; its prompts arrive as `can_use_tool`
  control requests and are answered with the picked options in `updatedInput.answers`.
- `src/host.ts` owns one session: the child, the reducer's state, the prompt queue, bash mode,
  questions, and the commands that move the session. The TUI (`src/ui/App.tsx`) is a view of
  it; `src/remote/hostServer.ts` serves it to remote viewers as a snapshot plus patches
  (`src/remote/wire.ts`).
- `src/store.ts` is a pure reducer from stream events to tabs. Only one turn is ever in
  flight (binder owns the queue), so every event between a send and its `result` belongs to
  the running tab. The exception is a `Ctrl+Enter` follow-up on a running turn: it is
  written at once with a uuid plus an `interrupt` request with `send_now: true`, and the
  child's `command_lifecycle` frame for that uuid (`started`) marks where the tab's next
  turn begins. A tab holds its latest turn plus the turns before it (`earlier`).
- Background shells and agents outlive the turn that started them. A subagent's messages
  go to the Agent call named by their `parent_tool_use_id`, in whatever tab or earlier turn
  holds it. When background work finishes while no turn is running, the child starts a
  turn of its own (`task_notification`, then `init` with no prompt of ours running); it
  goes into the tab that launched the work, headed by what finished. A sent prompt counts
  as in flight until its `command_lifecycle` `started`, so nothing else is sent while the
  child might be busy with such a turn. `background_tasks_changed` lists what is still
  running for the status row.
- Every prompt is sent with a uuid, which `/rewind` targets. Binder's panels talk to the
  child over the same control protocol the Agent SDK uses (`src/session.ts` `request()`):
  `initialize` (command list), `list_models` / `set_model`, `apply_flag_settings` (effort),
  `mcp_status` / `mcp_toggle` / `mcp_reconnect` / `mcp_authenticate` / `mcp_clear_auth`,
  `get_chrome_dialog`, `rewind_files` / `rewind_conversation`, and `set_cwd`. `/fork`,
  `/resume` and `/chrome` restart the child (`--fork-session`, `--resume`, `--chrome`).
- `src/eventLog.ts` appends every non-stream event plus a marker per sent prompt (and per
  bash command and rewind) to `~/.local/state/bindertui/<session>.events.jsonl`; replaying it
  rebuilds the tabs on resume. `src/transcripts.ts` reads Claude Code's own transcripts for
  `/resume` and for sessions binder has no log of.
- Prompt history is `~/.local/state/bindertui/history.jsonl`, per directory.
- `src/statusline.ts` runs the `statusLine.command` from the active config dir's
  `settings.json` with a payload built from `rate_limit_event` (utilization × 100 =
  `used_percentage`), so the bar matches a normal `claude` session.
- `~/.local/state/bindertui/sessions.json` indexes sessions for `binder -c`; `BINDER_STATE_DIR` and
  `BINDER_CLAUDE_BIN` override the state directory and binary (tests use both).

## Tests

```sh
npm test          # vitest: process layer, reducer, Ink app against test/fakeClaude.mjs
npm run typecheck
```

`fixtures/*.jsonl` are real captured streams. `test/manual/` has scripts that hit the
real binary with `--model haiku`: `twoTurns.ts`, `askAndInterrupt.ts`, and `drive.py`,
which drives the full TUI in a pseudo-terminal (`DRIVE_MODE=resume|ask|interrupt`).

## License

MIT. See [LICENSE](LICENSE).

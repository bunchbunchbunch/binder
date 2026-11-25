# BinderTUI

One headless Claude Code or Codex session, in tabs.

`binder` runs the real `claude` binary in the background (`claude -p` with stream-json in and
out) and shows one conversation as tabs: each prompt and its response is a tab. The
session id persists, so quitting and relaunching restores the tabs and continues the
conversation. All existing Claude Code configuration applies unchanged: account routing
via `CLAUDE_CONFIG_DIR`, hooks, plugins, MCP servers, CLAUDE.md, skills, and the status
line script from `settings.json`. `binder --codex` runs Codex the same way; see
[Codex](#codex).

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
binder --codex             start a Codex session instead (see Codex)
binder -- <claude args>    pass flags to claude, e.g. binder -- --model opus
binder --codex -- <args>   --model, --permission-mode, or codex app-server flags (-c key=value)
```

On quit, binder prints `Resume with: binder <id>`. Resuming a session binder never ran
(one from plain Claude Code) shows its conversation from Claude Code's transcript.
Resuming one Claude Code has no transcript for (started but never sent a prompt, or
cleaned up since) starts a new session under the same id instead of failing, so a
launcher's link to that id keeps working.

Binder leaves the permission mode to Claude Code (`permissions.defaultMode` in
`settings.json`) unless `config.json` sets one or you pass `binder -- --permission-mode
<mode>`. `Alt+M` steps a running session to the next mode (manual, accept edits, plan,
auto, bypass permissions, skipping any Claude Code refuses), as `Shift+Tab` does in Claude
Code, and `/permission-mode` picks one; either lasts until the session restarts.

Prompts that ask for permission show a picker: Allow, Deny, and the "always allow" choices
Claude Code suggests. One applies its rules (`Always allow Bash(make lint)`): binder hands them
back to Claude Code, which saves them where it said (this project's `.claude/settings.local.json`,
or this session only). Another allows the call and switches the session's mode (`Allow, and
accept all edits from now on`).
Binder keeps them apart, because Claude Code may suggest both for one command and taking a
rule should not also change the mode.

When Claude finishes a plan in plan mode (ExitPlanMode), the plan shows in the transcript as
markdown, and the picker under it asks "Ready to code?": `Yes, and use auto mode`, `Yes,
and auto-accept edits`, `Yes, and manually approve edits` (each approves the plan and sets
that mode), `No, keep planning`, or `No, and tell Claude what to change`, which takes typed
feedback. A session that came into plan mode from bypass permissions is offered `Yes, and
bypass permissions` first. `Esc` keeps planning. The plan stays in the transcript, unfolded,
once answered.

## Configuration

Binder reads optional defaults from `~/.config/binder/config.json` (`BINDER_CONFIG` points
elsewhere). `/settings` shows and changes them, or edit the file:

```json
{
  "permissionMode": "bypassPermissions",
  "configDirs": { "~/work": "~/.claude-work" },
  "stickyPrompt": false,
  "markdownStyle": "classic"
}
```

- `permissionMode` is passed to claude as `--permission-mode`, unless you pass one after `--`.
- `configDirs` maps folders to a Claude Code config dir, for example a second account for
  work repos: claude run inside `~/work` gets `CLAUDE_CONFIG_DIR=~/.claude-work`. It applies
  only when `CLAUDE_CONFIG_DIR` is not set already, so a shell hook that sets it still wins;
  it covers launches that skip your shell, such as `binder serve` under launchd.
- `stickyPrompt` keeps the prompt in view: once sent, it sits at the top of the tab, under
  the tab bar, and the response scrolls below it. A longer prompt shows its first 3 lines and
  `+N lines · Home`; `Home` shows it whole until you scroll. In a tab with follow-ups it is the
  latest prompt you sent, and earlier ones stay in the transcript. On unless set to `false`;
  the Mac app reads it too.
- `markdownStyle` is `vivid` (the default) or `classic`; see Output rendering. `BINDER_MD`
  overrides it, and `/md` switches for the running session only.
- `agent` is `claude` (the default) or `codex`: what new sessions run, including ones started
  from the phone. A session keeps the agent it started with.
- `statusText` is what the right end of the status row shows, as a template: `{context}`
  (tokens in context), `{maxTokens}` (the model's window), `{percent}` (the share in use) and
  `{cost}` (what the session has cost, at API list prices); text in `( )` shows only when a
  field inside it has a value. The default, `{context}(/{maxTokens})( {percent})`, reads
  `36.9k/1M 4%`; `{context}( · {cost})` reads `36.9k · $0.42`. The Mac app's status bar reads
  it too, and knows its sidebar fields as well.
- `artifacts` lets Claude publish artifacts: live pages on claude.ai that update in place.
  Claude Code leaves the Artifact tool off when run headless, as binder runs it, so binder
  turns it on with `CLAUDE_CODE_ARTIFACT=1`. On unless set to `false`; a
  `CLAUDE_CODE_ARTIFACT` already in your environment wins. Claude Docs and Sheets come
  through the claude.ai Claude Docs connector and don't depend on this setting.
- `fastMode` starts sessions with Claude Code's fast mode on (`true`); off by default. Run
  headless, Claude Code ignores the `fastMode` in its own settings.json, so this is where
  binder takes it from. `Alt+O` or `/fast` turns it on or off in a running session.
- `alwaysAllow` offers the "always allow" choices on permission prompts. On unless set to
  `false`, which leaves Allow and Deny only.
- `planApproval` shows a plan with its approve choices (see above). On unless set to
  `false`, which asks a plain Allow / Deny.
- `worktrees` is where `binder --worktree [name]` makes a session's own git worktree, and what
  its branch starts with: `{ "location": "../{repo}-worktrees", "branchPrefix": "binder/" }`
  (the defaults; `location` is relative to the repo, `~` and `{repo}` filled in). The session
  starts in the same subfolder of the new worktree, on a branch named for it (the time, unless
  you name it). Archiving the session (`Ctrl+X` in `/resume`) removes the worktree and its
  branch, and says what it kept: a worktree with changes not committed stays, with its branch;
  a branch not merged stays, though its worktree is removed; and while the session is still
  open (its binder is running), both stay.
- `workflowCard` asks about a workflow (the Workflow tool) with what its script says it is:
  its name, description and phases, not the script. `Run once`, `Always allow workflows` (a
  rule Claude Code saves in this project's `.claude/settings.local.json`), or `Deny`. A
  running workflow's row under the status row says its phase and how many agents are done,
  and `/tasks` lists its phases with each agent's state, model, time and result. On unless set
  to `false`, which asks a plain Allow / Deny.
- `pluginReload` loads a plugin change made in `/plugins` into the running session at once
  (after the turn, if one is running). On unless set to `false`, which leaves it for claude's
  next start.
- `schedules` runs scheduled tasks (`/schedule`): each minute, a running binder (or the Mac
  app) starts the ones due. `binder schedule list|add|remove|pause|resume|run|history|tick`
  does the same from a shell (JSON out); `binder schedule tick` from cron or launchd runs them
  with neither app open. `binder schedule add --mode <mode>` refuses a name that is not a
  permission mode. On unless set to `false`, which runs none.
- `sideChat` makes `/btw` binder's side chat (above). On unless set to `false`, which sends
  `/btw` to Claude Code as typed.
- `findingsCard` makes a code review's findings (`/code-review`) something to act on: under
  the review, a row counts them by severity (`▸ 4 findings (2 important, 1 pre-existing, 1 nit)`),
  `/findings` lists them to ask Claude to fix one, or all in one prompt (in the review's tab),
  and `/diff` shows each under its line. binder reads them from Claude Code's text for the
  review, at any effort, or from its ReportFindings tool. On unless set to `false`.
- `prWatch` watches the pull request for the session folder's branch through the GitHub CLI
  (`gh`, signed in): a row under the status row says its number, its checks and its review
  (`⎇ PR #12 · ✗ 2 failing (lint, test) · approved`). binder asks when the session starts,
  after each turn, and every minute while the PR is open. `/pr` opens it in the browser, asks
  Claude to fix the failing checks (or address a review asking for changes), merges it when
  ready (`gh pr merge --auto --squash`), or looks again. Without `gh` or a PR, there is no row.
  On unless set to `false`.
- `prAutoFix` asks Claude on its own, once the session is idle, when the PR's checks fail or a
  review asks for changes: once per commit and set of failures, and once per review. Off
  unless set to `true`.
- `todoPanel` keeps the session's latest todo list (from TodoWrite or the Task tools,
  whichever Claude used last) and its current plan pinned above the prompt, in one line:
  `☑ 1/3 · ◐ Writing the tests  ·  ▤ Plan: Add hello.txt`. `Ctrl+T`, as in Claude Code, opens
  every item and the plan. A list with every item done stays out of the way until opened.
  On unless set to `false`.
- `editor` is how a file opens from `/files` and the Mac app's tool calls: `open` (the
  file's default app, the default), a command the path is added to (`code`), or a command
  with `{file}` and `{line}` filled in (`code -g {file}:{line}`, to land on a Read's line).
  `/settings` offers VS Code, Cursor, Zed, Sublime Text and IntelliJ, or type your own.
- `showImages` draws images in the transcript: a tool's (a screenshot, a Read of an image
  file) and the ones you send, under the prompt. iTerm2 draws them inline, in rows binder
  leaves for them once the screen settles; elsewhere, and with `false`, an image is a caption
  (`▣ PNG image, 800×600, 45 KB`). On unless set to `false`.
- `bell` rings the terminal bell when a turn finishes or a question arrives while the
  terminal's window is in the background (binder turns on focus reporting to know). iTerm2
  can bounce the Dock or post a notification on a bell; see its profile's Terminal settings.
  On unless set to `false`. `notifications` is the Mac app's switch for the same.

`/settings` saves to the file in place (a symlink into a dotfiles repo stays a symlink) and
keeps keys it does not know. Nothing needs a restart of binder. Sticky prompt, markdown style,
status text, images, the bell, the todo panel, the diff base, plugin changes and scheduled
tasks change at once (the editor and worktrees at their next use). The permission mode,
artifacts, config dirs, fast mode, always allow, plan approval, workflow card, PR watching and
auto-fix, side chat and findings card apply from the next session: an open one keeps the
values it started with, and `/clear`, `/resume` and `/fork` start the next one with the new
values. Fast mode goes back to config.json's value then; an `Alt+O` toggle doesn't carry over.

## Codex

`binder --codex` runs Codex instead of Claude Code, through `codex app-server`. Install the
Codex CLI and run `codex login` first; a ChatGPT account (the free plan works) or an API key
will do. A session keeps its agent: `binder <id>`, `-c`, `/resume` and the phone reopen a
Codex session as Codex. `binder --codex -r <thread-id>` opens a Codex thread binder never
ran, without its earlier tabs.

Tabs, the queue, `Ctrl+Enter`, `Esc`, `!command`, images, the status bar, the event log and
remote viewers work as they do for Claude Code. What differs:

- **Tools.** Codex's shell commands show as `Bash`, its file edits as `Patch` with their
  diff, its plan as a checklist, and its reasoning summaries as thinking.
- **Approvals.** The Allow / Deny picker answers Codex's command and file-change approvals.
- **Permission mode.** `permissionMode` (or `--permission-mode` after `--`) becomes an
  approval policy and sandbox, below. Without one, `~/.codex/config.toml` decides.
- **Commands.** `/model`, `/effort`, `/cd`, `/clear`, `/fork` and `/resume` work; `/resume`
  lists binder's Codex sessions. `/mcp` shows status only. `/rewind`, `/chrome`, `/fast`,
  `/tasks`, `/btw` and `/plugins` are not available: Codex keeps no file checkpoints, and has
  no Claude in Chrome, fast mode, background tasks, side questions or Claude Code plugins. The
  menu offers binder's commands only.
- **Attachments.** Images and text files go with a prompt; a prompt with a PDF is refused
  ("Codex reads images and text files, not PDFs").
- **Usage.** The bar names Codex's windows by length: `5h`, `7d`, or the free plan's `30d`.
- **Flags.** After `--`, `--model` (`-m`) and `--permission-mode` are binder's; the rest go
  to `codex app-server` (`-c key=value`, `--enable <feature>`).

| `permissionMode` | Approval policy | Sandbox |
|------------------|-----------------|---------|
| `bypassPermissions` | `never` | `danger-full-access` |
| `dontAsk` | `never` | `workspace-write` |
| `acceptEdits`, `auto` | `on-request` | `workspace-write` |
| `manual`, `default` | `untrusted` | `workspace-write` |
| `plan` | `on-request` | `read-only` |

Codex marks `app-server` experimental and renames parts of it between releases. Binder is
tested against Codex 0.160.1, the version `fixtures/codex/` was recorded with.

## Keys

| Key | Action |
|-----|--------|
| `?` (empty prompt) | show the shortcuts in a box above the prompt; the next key closes them |
| `Enter` | send the prompt (opens a new tab; queued if a turn is running) |
| `Ctrl+Enter` | send the prompt into the current tab instead: on a running turn it is sent now (Claude Code's "send now": the turn stops and the follow-up runs next), otherwise it runs after the current turn. Needs a terminal with the kitty keyboard protocol (iTerm2, kitty, WezTerm, Ghostty); elsewhere it acts as `Enter` |
| `Shift+Enter`, `Alt+Enter`, or `\` then `Enter` | newline in the prompt. `Shift+Enter` needs the kitty keyboard protocol, like `Ctrl+Enter`; elsewhere it sends, so use `Alt+Enter` |
| `Up` / `Down` | earlier / later prompts from this directory (inside a multi-line prompt they move between lines first) |
| `Up` (empty prompt, the tab has a queued prompt) | edit the tab's last queued prompt in place: `Enter` saves it, `Enter` on an emptied prompt removes it (a new tab's prompt takes its tab along), `Esc` leaves it as it was |
| `Tab` | complete the path before the cursor (after `!`, the command name); with several matches it fills the common part, then lists them |
| `Tab` or `Right` (empty prompt) | take the suggested next prompt. After a turn, Claude Code may predict what you will ask next; like Claude Code, binder shows it dim in the empty prompt. Typing replaces it, and `Enter` alone does not send it |
| `@` | list files as you type a path after it |
| `!command` | bash mode: binder runs the command in the session's directory and shows it in its own tab; the output goes to the model with your next prompt. `Esc` stops it |
| `Ctrl+Right` / `Ctrl+Left` | next / previous tab. `Ctrl+N` also moves to the next tab; `Ctrl+P` cycles models instead, as in pi |
| `Ctrl+L` | pick the model, as `/model` does (pi's key) |
| `Ctrl+P` / `Shift+Ctrl+P` | switch to the next / previous model the agent offers, as in pi. A model listed twice (Claude Code's `default` and `opus`) counts once. `Shift+Ctrl+P` needs the kitty keyboard protocol; elsewhere it acts as `Ctrl+P` |
| `Shift+Tab` | switch to the current model's next effort level, wrapping around, as pi does with its thinking level |
| `Alt+M` | switch to the next permission mode, skipping any Claude Code refuses (Claude Code's `Shift+Tab`, which binder gives to effort). The mode shows under the status bar |
| `Alt+O` | fast mode on or off, as in Claude Code. `↯ fast mode on` shows under the status bar while it is on. When it cannot run (no usage credits, a model without it), binder says why and leaves it off |
| `Option+Left` / `Option+Right` | move the cursor by a word in the prompt |
| `Shift+arrows`, `Shift+Option+arrows`, `Shift+Home/End` | select text (typing, paste, Backspace and Delete act on the selection) |
| `Ctrl+C` with text selected | copy the selection, like Claude Code. `Cmd+C` works too in terminals that pass it on; iTerm2 keeps `Cmd+C` for its own mouse selection |
| `Option+Backspace` / `Option+Delete` | delete a word backward / forward |
| `Ctrl+V` | paste the clipboard: an image as `[Image #n]`, like Claude Code, a file copied in Finder as an attachment (below), or else its text (long text collapses as a paste does) |
| `Cmd+V` | paste text. Like Claude Code, a paste over 800 characters or with more than 2 line breaks shows as `[Pasted text #n +N lines]`; the full text is sent |
| `Alt+1` to `Alt+9` | jump to tab |
| mouse wheel or trackpad, `PgUp` / `PgDn` (`Fn+Up` / `Fn+Down` on a Mac), `Home` / `End` | scroll the active tab (output auto-follows until you scroll up). Binder turns on mouse reporting for the wheel, so select text with the mouse by holding `Option` (iTerm2) or `Shift` (most other terminals) while dragging |
| `Esc` | interrupt the running turn |
| `Esc` twice (idle) | rewind (see `/rewind`) |
| `Ctrl+]` | open the latest artifact published in this session |
| `Ctrl+E` | expand / collapse the work (thinking and tool calls) behind a response |
| `Ctrl+O` | toggle full tool output, thinking, and subagent detail |
| `Ctrl+T` | open the pinned todos and plan in full, or close them |
| `Ctrl+B` | move the running command or agent to the background, as in Claude Code. The status row says when there is one: `ctrl+b to run in background` |
| `Ctrl+R` | restart the child after it exits unexpectedly |
| `Ctrl+C` twice | quit |

A PDF or a text file goes with a prompt too: drop it on the terminal (iTerm2 types its path,
which binder turns into `[File #n: name]`; several dropped at once each become one) or copy it
in Finder and press `Ctrl+V`. Claude reads a PDF as a document (up to 32 MB) and gets a text
file's text (up to 512 KB). A file that cannot go (another kind, or over its limit) stays in
the prompt as its path, with a notice saying why, so you can mention it with `@` instead.
Codex takes text files, not PDFs.

While a turn runs, its work streams in full, and a row above the prompt shows what it is
doing and for how long (`Thinking… (12s · esc to interrupt)`, `Running Bash…`). When the
response arrives, or the model asks a question, the work folds into a one-line summary
above the response; `Ctrl+E` unfolds it. The right end of that row shows the context:
`36.9k/1M 4%` (tokens, the model's window once a turn has reported it, and the share in use),
or what config.json's `statusText` asks for, the session's cost included (see
Configuration). `/context` breaks the context down by category.

Background shells and agents (a command or agent Claude starts in the background, or one
moved there with `Ctrl+B`) get a row each under the status row: what it is doing, its kind,
the tab that started it, and how long it has run, so one that hangs shows. `/tasks` lists
them with the highlighted one's output. When one finishes while no turn runs, Claude replies
in the tab that started it. When it finishes during another tab's turn, Claude sees the
result in that turn; once it ends, binder sends a follow-up into the tab that started the
task, so Claude carries on with it there (`⏺ Background task finished: …`). A task stopped by
another turn gets only a note there, and one you stop gets nothing.

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
| `/resume [id]` | pick a session to resume, with search: this folder by default, `Ctrl+A` all projects, `Ctrl+W` this repo's worktrees, `Ctrl+B` this branch. Lists interactive Claude Code sessions and binder's own, not other headless `claude -p` runs. A session from another folder resumes there. Typing three characters or more also searches what was said in each session (prompts and Claude's replies, not tool output; the text is cached in binder's state dir, so a search after the first is quick) and shows the matching text. `Ctrl+X` archives the highlighted session out of the list (`Ctrl+D` shows the archived ones, where `Ctrl+X` brings one back) |
| `/clear` (`/reset`, `/new`) | start a fresh session; the current one stays resumable with `/resume` |
| `/fork [title]` (`/branch`) | continue in a new session forked from this one (`--fork-session`); the original stays resumable |
| `/rename <title>` | give the session a title, shown above the tabs from then on, and in `/resume`, the Mac app's sidebar and `⌘K`, and the phone's list in place of the first prompt. Claude Code keeps it, so a resumed session shows it again, and tidies it: spaces collapse, the ends are trimmed. A session started with `-n <name>`, or named in Claude Code, shows its name the same way. Claude Code can rename a session but not clear its name, so neither can binder |
| `/rewind` (`/checkpoint`, or `Esc` twice) | pick an earlier prompt, then restore the code, the conversation, or both to just before it. The prompt comes back in the composer. Binder turns on Claude Code's file checkpoints for this (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`) |
| `/cd <path>` | move the session to another directory (asks to trust a new folder first); a folder that `configDirs` gives another config dir is refused. When Claude changes folder itself (a `cd` in Bash, a worktree), binder shows its new folder; prompt history stays with the session's folder |
| `/model [model]` | pick from the models the child offers, or set one by name. `Ctrl+L` opens the same picker |
| `/effort [level]` | pick the effort level for this session, or set one by name. `Shift+Tab` steps to the next one |
| `/fast [on\|off]` | turn fast mode on or off for this session; no argument flips it (`Alt+O`). Binder's own, so it answers at once instead of taking a turn |
| `/permission-mode [mode]` (`/mode`) | pick the permission mode for this session, or set one by name (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). `Alt+M` steps to the next one |
| `/mcp` | MCP servers and their status; pick one to authenticate (opens the sign-in page), reconnect, enable or disable it, or clear its authentication |
| `/chrome` | Claude in Chrome: extension status, enable or disable it for this session (restarts claude with `--chrome`), and links to reconnect or manage permissions |
| `/artifacts` | artifacts published in this session: `Enter`/`o` opens one, `c` copies its link |
| `/diff [branch]` | the session folder's changes in place of the transcript, file by file with line numbers: against HEAD (what is not committed; config.json `diffBase` changes the default), or the branch you name. Files git does not track yet show as new. `↑↓`, `PgUp`/`PgDn` scroll, `n`/`p` jump between files, `Esc` closes |
| `/files` | the files this tab's tool calls read, edited and wrote, the latest first: `Enter` opens one in your editor (config.json `editor`), `f` shows it in Finder, `c` copies its path. Paths in tool calls are also links (OSC 8): Cmd+click opens one in iTerm2 |
| `/tasks` (`/bashes`) | background shells and agents, with the highlighted one's output (a shell's last lines, read every second; an agent's latest steps): `Enter` goes to the tab that started it, `x` stops it |
| `/plugins` | plugins (`/plugin` too): the installed ones (Enter enables or disables one, or uninstalls it), `Install a plugin…` (your marketplaces' plugins; typing filters; Enter installs it for your user), and `claude.ai connectors…` (the ones this session has, with their state; `/mcp` acts on them). A change loads into the running session at once (config.json `pluginReload`), its commands included |
| `/schedule [when prompt]` | scheduled tasks (config.json `schedules`): `/schedule weekdays 9:00 Summarize what changed yesterday` runs that prompt in a fresh session in this folder, named for it, on that schedule (`daily 9:00`, `weekdays 17:30`, `weekends 10am`, `mon,thu 8:00`, `hourly`, `every 15m`, `every 2h`, or a cron line, whose day of week takes `7` for Sunday as well as `0`, ranges such as `1-7` and names such as `mon,thu`). A time binder cannot read (`daily 25:00`) is named in the error. Alone, it lists them: one opens Run it now, Pause, Runs (a run opens its session once it is done) and Delete. They run while binder or the Mac app is open; a run missed while neither was runs once at the next minute either is |
| `/btw <question>` | a side question (config.json `sideChat`): Claude answers from the conversation so far, without tools, in a side chat that takes the transcript's place and stays out of it; it works while a turn runs. While the side chat is open the prompt asks it (each with the earlier side questions); `Esc` closes it. Not in a Codex session |
| `/findings` | the latest code review's findings (config.json `findingsCard`): `Apply fixes` asks Claude to fix all of them in one prompt, or pick one to fix it; the prompt goes into the review's tab |
| `/pr` | the branch's pull request (config.json `prWatch`): open it, fix the failing checks or the review, merge when ready, or look again |
| `/markdown [style]` (`/md`) | switch the markdown style for responses, `vivid` or `classic` (see Output rendering), in this binder only; no style switches to the other one. config.json `markdownStyle` sets the default |
| `/settings` | binder's `config.json`: permission mode for new sessions, sticky prompt, markdown style, status text, artifacts, fast mode, always allow, pull request watching and auto-fix, findings card, plugin changes, scheduled tasks, side chat, diff base, worktrees, workflow card, todo panel, editor, images, bell, plan approval, and config dirs (add one by typing its folder and config dir, `Tab` completes; `Enter` on one removes it) |
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

The Mac app reaches another computer's sessions over SSH instead of the relay (see "Other
computers" in `../gui/README.md`). `binder start --cwd <dir> --session-id|--resume <id>` makes
sure a host runs a session and prints its socket; `binder attach <id>` connects stdin and stdout
to that socket. Run over SSH on macOS, `binder start` has launchd start the host in the login
session (`gui/<uid>`): a process under sshd cannot read Claude Code's sign-in from the login
keychain. That needs the user logged in at the Mac's screen. `binder sessions` lists the
sessions as JSON (`--search <text>` searches them; `--archive <id>` and `--unarchive <id>` move
one out of the lists and back); an unknown or missing id, or an unknown flag, prints
`{"error": ...}` and exits 1.

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
  holds it. Work that finishes (`task_notification`) waits for a turn to take it in: the
  running turn's next request, which follows a tool result, or else a turn the child starts
  of its own (`init` with no prompt of ours running). That turn goes into the tab that
  launched the work, headed by what finished. When another tab's turn takes it in, binder
  queues a follow-up of its own into the tab that launched it (one per tab, naming all that
  finished), asking the model to carry on there; its log marker holds only the heading, and
  replay leaves out one never sent. Work stopped during another tab's turn gets a note
  there instead, and work the user stopped (`stop_task`, logged as `hc_stop_task`) gets
  nothing. A turn of the child's own that runs nothing (`num_turns` 0, because an earlier
  turn took the work in) is dropped. A sent prompt counts as in flight until its
  `command_lifecycle` `started`, so nothing else is sent while the child might be busy with
  such a turn. `background_tasks_changed` lists what is still running, one row each under
  the status row, with the tab that started it (`task_started`), how long it has run (from
  the timestamp of the message that started it) and an agent's latest step
  (`task_progress`). `/tasks` reads a shell's output with `get_task_output`, and `Ctrl+B`
  sends `background_tasks`.
- Every prompt is sent with a uuid, which `/rewind` targets. Binder's panels talk to the
  child over the same control protocol the Agent SDK uses (`src/session.ts` `request()`):
  `initialize` (command list), `list_models` / `set_model`, `apply_flag_settings` (effort),
  `set_permission_mode`,
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
- `src/codex/` runs a Codex session. `rpc.ts` speaks `codex app-server`'s JSON-RPC over
  stdio; `translate.ts` turns its notifications into the stream-json events the reducer
  reads, so the tabs, the event log and remote viewers need no Codex code; `session.ts` sends
  prompts as `turn/start`, `Ctrl+Enter` as `turn/steer` and `Esc` as `turn/interrupt`, puts
  approvals in the Allow / Deny picker, and answers the panels' control requests from
  `model/list`, `mcpServerStatus/list` and per-turn overrides.
- `~/.local/state/bindertui/sessions.json` indexes sessions for `binder -c`, with each one's
  agent and, for Codex, its thread id (Codex names threads itself). `BINDER_STATE_DIR`,
  `BINDER_CLAUDE_BIN` and `BINDER_CODEX_BIN` override the state directory and binaries (tests
  use them).

## Tests

```sh
npm test          # vitest: process layer, reducer, Ink app against test/fakeClaude.mjs
npm run typecheck
```

`fixtures/*.jsonl` are real captured streams. `test/manual/` has scripts that hit the
real binary with `--model haiku`: `twoTurns.ts`, `askAndInterrupt.ts`, and `drive.py`,
which drives the full TUI in a pseudo-terminal (`DRIVE_MODE=resume|ask|interrupt`).

`test/fakeCodex.mjs` replays `fixtures/codex/*.jsonl`: real `codex app-server` sessions,
both directions, recorded and scrubbed by `npx tsx test/manual/recordCodex.ts <scenario>`.
Most scenarios cost one prompt of the logged-in account's quota. Record them again after
upgrading Codex.

## License

MIT. See [LICENSE](../LICENSE).

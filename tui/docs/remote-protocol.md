# Binder remote protocol, version 1

How a remote client (a phone app, a script) drives binder sessions on the computer
that runs them. Three programs take part:

- **The session host** owns one `claude` child for one session. It runs inside the
  binder TUI, or on its own as `binder host` (no UI). Each live host listens on a unix
  socket: `<state dir>/sock/<session id>.sock`. The socket file is also the session's
  lock: while it accepts connections, no second binder may run that session.
- **The gateway** (`binder serve`) runs on the same computer. It keeps one outbound
  WebSocket to the relay, authenticates each client with Noise, applies the local policy
  (`~/.config/binder/remote.json`), lists sessions, starts them through a launcher, and
  pipes an attached client to a host's socket.
- **The relay** (`relay/relay.mjs`) runs on a server both sides can reach. It pairs the
  computer's WebSocket with client WebSockets and forwards opaque frames. It never holds a
  key and cannot read or change what it forwards.

```
client ==wss==> relay <==wss== binder serve --unix socket--> session host --> claude -p
   \___________ Noise IK, end to end ____________/
```

## 1. Relay

Two WebSocket endpoints. Whatever sits in front of the relay (a reverse proxy) decides
who may reach each; the relay itself only checks an optional shared header
(`RELAY_SECRET`, sent as `X-Relay-Secret`), so other users on the relay's host cannot
connect around the proxy.

- `/relay/mac`: the computer. One at a time; a new connection replaces the old one
  (the old one is closed with code 4000).
- `/relay/phone`: clients. Closed at once with code 4004 when no computer is connected.

Frames between relay and computer are binary: a 4-byte big-endian connection id, a 1-byte
type, then the payload.

| Type | Direction | Meaning |
|------|-----------|---------|
| 0 | both | data for that client connection (payload: one Noise message) |
| 1 | relay to computer | a client connected (empty payload) |
| 2 | both | the client connection closed, or the computer closes it |

Frames between relay and a client are binary and carry one Noise message each, with no
header. The relay limits frames to 70,000 bytes and pings every 25 seconds.

## 2. Noise

`Noise_IK_25519_ChaChaPoly_SHA256`, as in the Noise specification (revision 34), with no
PSK. The client is the initiator and knows the computer's static public key in advance;
the computer learns the client's static key from the first message and accepts it only if
it is enrolled in `remote.json`.

- **Prologue:** the ASCII bytes `binder-remote/1`.
- **Message 1** (client): `e, es, s, ss` with payload `{"v":1}`.
- **Message 2** (computer): `e, ee, se` with payload `{"v":1}`.
- Then `Split()`: the client sends with the first cipher and receives with the second.
- Keys are raw 32-byte X25519 keys, base64 in configs and settings. A key's fingerprint
  is the first 8 bytes of SHA-256 over the raw public key, as lowercase hex in groups of
  four: `1397 a967 4c4c ee28`.

**Transport framing.** Each application message is UTF-8 JSON. It is split into chunks of
at most 65,518 bytes; each chunk is one byte of flag (`1` last chunk, `0` more follow)
plus the data, encrypted as one Noise transport message (empty associated data). A
message larger than 16 MB is a protocol error and closes the connection.

## 3. Requests and replies

Every request a client sends has a `t` (type) and an integer `id`. It gets exactly one
reply:

```json
{"t":"reply","id":7,"ok":true,"result":{}}
{"t":"reply","id":7,"ok":false,"error":"Not a directory: /tmp/x"}
```

### Gateway requests (always answered by `binder serve`)

| `t` | Fields | Result |
|-----|--------|--------|
| `list` | | `{sessions: Session[], roots: string[]}` |
| `open` | `cwd`, `sessionId?`, `resume?`, `name?`, `create?` | `{sessionId}`; starts the session if it is not live, then attaches |
| `attach` | `sessionId` | `{sessionId}`; a `snapshot` follows |
| `detach` | | `{}` |

`Session` is `{id, cwd, title, live, running, lastUsedAt}`. Only sessions whose folder is
inside an allowed root are listed, attachable or startable. For `open` without
`sessionId`, the gateway makes a new id; with `sessionId` and `resume: false` it starts a
new session with that id (so a client can link it first); with `resume: true` it resumes
it. `name` names the session (a resumed one is renamed). With `create: true` a missing `cwd` is made first (with
any missing parents), as long as it would be inside an allowed root.

The gateway sends `{"t":"detached","reason":"..."}` when the attached host goes away, and
`{"t":"closed","reason":"..."}` just before it ends the connection itself (remote control
paused, or this client revoked).

### Session requests (forwarded to the attached host)

| `t` | Fields | Result |
|-----|--------|--------|
| `send` | `text`, `images?`, `tabId?` | `{tabId}`. A new tab, or into tab `tabId` (sent at once on its running turn when the child supports it, else after it). Text starting with `!` runs in bash mode. `images` is `[{mediaType, data, name?}]`, data base64: an image (`image/png`, `jpeg`, `gif`, `webp`), a PDF (`application/pdf`, which Claude reads as a document) or a text file (`text/plain`, sent as its text); `name` is the file's. A Codex session refuses PDFs |
| `edit_queued` | `tabId`, `prompt`, `text` | `{}`. The prompt still in `queue` for tab `tabId` whose text is `prompt` becomes `text`, keeping its place and images. An empty `text` removes it; for the prompt that opens a new tab, the tab goes too, with anything queued into it. Refused once the prompt is no longer queued (sent, or removed) |
| `interrupt` | | `{}` |
| `stop_bash` | `tabId` | `{}` |
| `stop_task` | `taskId` | `{}`; stops a background shell or agent (an id from `backgroundTasks`). Nothing follows up on its end |
| `task_output` | `taskId` | `{output, totalBytes, truncated}`: the end of a background shell's or monitor's output, at most its last 8 KiB, escape sequences included. Refused for an agent |
| `background` | | `{}`; the running turn's foreground commands and agents carry on in the background (Claude Code's `Ctrl+B`) |
| `answer` | `requestId`, `answers` | `{}`; AskUserQuestion: `answers` maps question text to the chosen label(s) (comma-separated for multi-select). A permission prompt: the chosen option's label, `Allow`, `Deny`, or one of its "always allow" options, which also applies the rules or mode switch Claude Code suggested. Any other label, or `{}`, is refused (`Not a choice on this prompt: …`) and the prompt stays open; a plan to approve takes any text (below) |
| `allow` / `deny` | `requestId` | `{}`; a permission prompt. `deny` also declines an AskUserQuestion: Claude is told the user declined and carries on |
| `rewind_targets` | | `{targets: [{uuid, prompt, tabId}]}` newest first |
| `rewind_preview` | `uuid` | `{canRewind, files, error}`: whether the code can be restored to before that prompt, and how many files it would change |
| `rewind` | `uuid`, `mode` (`both`, `conversation`, `code`) | `{prefill?}`: the prompt to put back in the composer |
| `clear` | | `{sessionId}` |
| `fork` | `title?` | `{sessionId}` |
| `rename` | `title` | `{}`; names the session. The name Claude Code keeps (tidied) arrives as `title` in the state. Refused when `title` is blank |
| `resume` | `id` | `{sessionId}` |
| `cd` | `path`, `trust?` | `{status: "ok", cwd}`, `{status: "needs_trust", directory}` (repeat with `trust: directory`), or `{status: "rejected", message}` |
| `models` | | `{models: [{value, displayName, description?, resolvedModel?, supportedEffortLevels?}]}` |
| `set_model` | `model` | `{}` |
| `set_effort` | `level` | `{}` |
| `set_permission_mode` | `mode` (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`) | `{}`; until the child restarts. Another name is refused, listing these (`Not a permission mode: bogus (one of default, acceptEdits, …)`); `manual` is taken as `default`. Claude Code refuses `bypassPermissions` in a session it did not start in that mode, and `auto` where auto mode is off |
| `cycle_mode` | | `{message}`; the next permission mode in the order `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, skipping any the child refuses (Claude Code's `Shift+Tab`) |
| `set_fast_mode` | `on?` | `{message}`: what to tell the user. Turns fast mode on or off (without `on`, flips it). When fast mode cannot serve, the host stops asking for it and `message` says why. Refused in a Codex session |
| `mcp_status` | | `{servers: [{name, status, error?}]}` |
| `mcp_toggle` | `server`, `enabled` | `{}` |
| `mcp_reconnect` | `server` | `{}` |
| `mcp_authenticate` | `server` | `{authUrl}`: the page that signs in to the server (null when none) |
| `mcp_clear_auth` | `server` | `{}` |
| `chrome` | `on` | `{}`; restarts claude with or without Claude in Chrome |
| `chrome_status` | | `{status}`: Claude in Chrome's state (`installed`, `connected`, `paired_browser`, `urls`, ...) as Claude Code reports it |
| `artifacts` | | `{artifacts: [{url, title, tabId}]}` |
| `context_usage` | | `{categories: [{name, tokens, kind}], totalTokens, maxTokens, percentage}`: what the context holds, as `/context` counts it. `kind` is `used`, `deferred` (loaded when used), `buffer` (kept free for compaction) or `free`. Refused in a Codex session |
| `history` | | `{prompts: string[]}` oldest first, at most 200 |
| `complete` | `partial`, `command?` | `{items: string[]}`: paths in the session folder, or command names |
| `tool_detail` | `tabId`, `toolUseId` | `{block}`: the tool call untruncated |
| `diff` | `base?` | `{base, repo, files: [{path, status, patch, cut?}]}`: the session folder's working tree against `base` (else config.json's `diffBase`, else HEAD), as unified diffs; `status` is `modified`, `added`, `deleted`, `renamed` or `untracked` (shown as all added; an untracked symlink shows the path it points to, as git would commit it, and an untracked folder such as a repo of its own is left out). Refused outside a git repo, and when `base` is not a branch or commit there (one starting with `-` is never passed to git) |
| `branches` | | `{branches}`: the repo's branches, the current one first |
| `plugins` | `available?` | `{installed: [{id, version, scope, enabled}], available?: [{pluginId, name, description, marketplaceName}]}`: `claude plugin list` run as the session's claude runs (its config dir and folder); `available` adds the marketplaces' plugins. Refused in a Codex session |
| `plugin_action` | `action`, `plugin`, `scope?` | `{message}`; `action` is `install`, `uninstall`, `enable` or `disable` (`claude plugin <action>`). Unless config.json's `pluginReload` is false, the change then loads into the running claude (its `reload_plugins` control request; after the turn, if one runs), and the session's `commands` follow. A plugin that installs by running a command is refused: install it from a terminal |
| `side_question` | `question`, `history?` | `{response, synthetic}`: a side question (`/btw`), answered from the conversation so far without tools and kept out of the transcript; `history` is the side chat's earlier `[{question, response}]` (binder leaves out an entry whose response is its own "No answer for this side question" placeholder). Works while a turn runs. Refused in a Codex session |
| `file_list` | `dir?` | `{dir, entries: [{name, dir}]}`: one folder of the session folder (`dir` relative to it, the folder itself by default), folders first; `.git` and `.DS_Store` are left out, and a symlink to a folder outside the session folder is listed as a file (`dir: false`). A path outside the session folder (`..`, a symlink leading out) is refused, here and in the three below |
| `file_index` | | `{files, cut}`: every file in the session folder, relative to it, for finding one by name: git's list (tracked, and untracked files git does not ignore), else a walk that skips `node_modules` and other build folders; at most 20,000 (`cut` says there were more) |
| `file_read` | `path` | `{path, size, mtime, text}`, or `{path, size, mtime, binary: true}` for a file with a NUL byte in its first 8,000 bytes. Refused over 2 MB, and for text that is not UTF-8 (a save would change it) |
| `file_write` | `path`, `text`, `mtime?`, `force?` | `{path, mtime, size}`; saves `text` over the file, or makes it. With `mtime` (as `file_read` gave it), refused when the file changed on disk since, unless `force`. Refused when the host's config.json has `fileEditing: false`. Never writes outside the session folder: the folder the file goes in must be inside it by its real path (so a new file through a symlinked folder leading out is refused), a broken symlink is refused, and the file is opened without following a symlink and checked to be the one inside before anything is written |
| `pr` | | `{pr}`: asks gh about the session folder's branch now and returns its PR (as in the state), or null |
| `pr_fix` | | `{message}`; sends a prompt asking Claude to fix the PR's failing checks, else to address the review asking for changes. Refused when there is neither |
| `pr_merge` | | `{message}`; `gh pr merge --auto --squash`: GitHub merges the PR once its checks pass and it is approved |
| `image` | `tabId`, `toolUseId` or `turn`, `index` | `{mediaType, data}` (base64): image `index` of a tool's result, or of the prompt of turn `turn` (its place among the tab's turns, oldest first). The state carries only each image's `{mediaType, bytes}` |
| `restart` | | `{}`; restarts claude after it exited |
| `restart_host` | | `{}`; a headless `binder host` lets claude exit, then ends (`ended`), so the viewer can open the session again on binder's newer code. Refused while a turn runs or is queued, a question is open, or a background task or bash command runs, and by the terminal app's own host |

`binder sessions` (what the Mac app lists, over ssh for another computer) prints the
sessions as JSON, archived ones marked `archived: true`; `binder sessions --search <text>`
prints `[{id, snippet}]` for the ones whose prompts or replies hold the text, and `binder
sessions --archive <id>` / `--unarchive <id>` move one out of the lists and back (archiving
keeps the worktree binder made for a session while a host still runs it). An unknown id,
a missing one, or an unknown flag prints `{error}` and exits 1, changing nothing. The
gateway's own list leaves archived sessions out.

`/resume`, `/clear`, `/fork`, `/rewind`, `/cd` and `/chrome` are refused while a turn
runs or is queued. Slash commands binder runs itself (see README) must be sent as these
requests; any other `/command` in `send` goes to Claude Code as typed.

### The host socket

The gateway talks to a session host over its unix socket with the same JSON, one message
per line. `binder attach <session id>` connects its stdin and stdout to this socket, so a client
can reach a host through SSH (the Mac app does, for another computer's sessions); it then
writes the hello itself. The first line is a hello the gateway writes (a client's own `hello` is refused):

- `{"t":"hello","want":"info"}`: the host answers
  `{"t":"info","sessionId","cwd","title","running","model","pid"}` and closes.
- `{"t":"hello","want":"attach","roots":[...]}`: the host sends a snapshot and patches, and
  takes session requests. With `roots`, it refuses (`{"t":"error"}`) when its folder is
  outside them, and refuses `cd` and `resume` targets outside them.

A line may be at most 64 MiB (a 32 MB PDF is about 45 MB as base64). The host refuses a
longer request without taking it in and keeps the connection: the reply goes to the
request when its `id` is at the start or end of the line (the Mac app writes it last), else
a `notice` says why.

## 4. Session state

After `attach` (and after the host moves to another session), the host sends a full
snapshot, then patches at most every 120 ms while something changes.

```json
{"t":"snapshot","state":{...},"commands":[...],"effort":"high"}
{"t":"patch","meta":{"running":3,"activity":"thinking"},"tabs":[...]}
{"t":"commands","commands":[{"name":"compact","description":"..."}]}
{"t":"notice","text":"Model: opus"}
{"t":"ended"}
```

`ended` means the host is shutting down (its binder quit); the gateway then reports
`detached`.

`state` fields: `sessionId`, `cwd` (the folder Claude is in, which follows its own `cd`), `model`, `permissionMode`, `fastMode`
(`on`, `cooldown` while paused after a rate limit, `off`, or null until the child says), `usage`, `contextTokens`, `contextWindow` (the model's context window,
once a turn has reported it, or null), `costUsd` (what the session has cost, in dollars at
API list prices, summed across every child binder ran for it, or null),
`running` (tab id or null), `runningSince` (when the running turn started, in ms since the
epoch, or null), `activity` (Claude Code's latest status: `requesting` while an API request
waits for its response to start streaming, `compacting`, or empty), `thinkingTokens` (Claude
Code's estimate of the running turn's thinking tokens so far, 0 when idle), `interrupting`, `canSteer`, `queue`
(`[{tabId, prompt, followup, auto?}]`; `auto` marks binder's own follow-up about background
work another tab's turn took in, which the user cannot edit), `steer` (`{tabId, prompt}` or null), `question`,
`childExit` (`{code, stderr}` or null), `effort`, `suggestion` (the next prompt Claude Code
predicts after a turn, or null), `backgroundTasks` (`[{id, type, description, toolUseId?,
tabId?, startedAt?, progress?, workflow?}]`, shells, agents and workflows still running
(`workflow`: `{phases, agents: [{label, phase?, state, model?, tokens?, durationMs?, result?}]}`):
the tool call that
started each and the tab whose turn made it, when it started in ms since the epoch, and an
agent's latest step), `title` (the session's name, from `rename`, `fork`'s title, or
Claude Code, or null; a session's name can change but never goes back to null), `outdated`
(true once binder was rebuilt after this `binder host` started, so it runs the older code and
may not know newer requests; the Mac app then sends `restart_host` when the session is idle), `pr`
(the pull request for the session folder's branch, as `gh pr view` last reported it, or null:
`{number, title, url, state, draft, head, mergeable, review, checks: {passing, failing, pending},
changesRequested?}`, where `state` is `OPEN`, `MERGED` or `CLOSED`, `review` is GitHub's review
decision, `failing` names the failed checks, and `changesRequested` is `{at, by}` for the latest
review asking for changes; the host asks when it starts, after each turn, and every minute while
the PR is open, unless config.json's `prWatch` is false), `tabs`.

`question` is null or `{requestId, kind, toolName, toolInput?, reason?, questions}`, where `kind`
is `ask` (AskUserQuestion) or `permission` (allow or deny `toolName` with `toolInput`; `reason`
is why Claude Code asks, when it says; its options are `Allow`, any "always allow" options
built from Claude Code's suggestions, and `Deny`). A plan to approve (ExitPlanMode) is a
`permission` question with `plan`, the plan's markdown in full; its options are `Yes, and …`
choices that also set the permission mode, and `No, keep planning`. Answer it with a
choice's label, or with any other text: what Claude should change before it starts. A
workflow (the Workflow tool) is a `permission` question with `workflow`
(`{name?, description?, phases}`, read from its script); its options are `Run once`, `Always
allow workflows` and `Deny`,
and `questions` is `[{question, header?, multiSelect?, options: [{label, description?}]}]`.

A tab: `{id, prompt, status, blocks, result?, uuid?, bash?, auto?, images?, seq?, earlier}`, where `earlier`
holds the tab's previous turns, each `{prompt, status, blocks, result?, uuid?, bash?, auto?, images?, seq?}`.
`seq` is a turn's place in the session's send order across all tabs, so the turn sent last is
the one with the highest `seq`, whichever tab it is in.
`images` (`[{mediaType, bytes}]`) are the ones sent with the prompt, kept while the host runs
(the event log leaves them out); a tool result's `images` are the same shape. Fetch one with `image`.
`auto` marks a turn about background work that finished, started by Claude Code or by
binder; its `prompt` is a heading (`Background task finished: …`), not the user's.
`status` is `queued`, `running`, `done`, `error`, `interrupted` or `superseded`. A block is
one of:

```json
{"kind":"text","text":"...","final":true}
{"kind":"thinking","text":"...","final":true}
{"kind":"tool_use","id":"toolu_1","name":"Bash","input":{},"final":true,
 "result":{"content":"...","isError":false,"length":120000},"children":[],"inputChars":0}
```

Tool output is cut to 4,000 characters and every string in a tool's input to 2,000
(`length` is the full output size when cut); `tool_detail` returns the whole call.
`inputChars` is how much of the input has streamed while the call is still being written.
`children` are a subagent's blocks.

**Patches.** `meta` carries the top-level fields that changed. `tabs` is a list of
operations, applied in order:

| `op` | Fields | Effect |
|------|--------|--------|
| `set` | `tab` | add or replace the whole tab (tabs stay sorted by id) |
| `remove` | `id` | drop the tab |
| `blocks` | `id`, `from`, `blocks`, `fields` | replace the tab's blocks from index `from` on, then copy `fields` (`prompt`, `status`, `result`, `uuid`, `bash`, `auto`, `seq`) onto the tab |
| `append` | `id`, `index`, `text`, `fields` | append `text` to the text or thinking block at `index`, then copy `fields` |

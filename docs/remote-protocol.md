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
| `open` | `cwd`, `sessionId?`, `resume?`, `name?` | `{sessionId}`; starts the session if it is not live, then attaches |
| `attach` | `sessionId` | `{sessionId}`; a `snapshot` follows |
| `detach` | | `{}` |

`Session` is `{id, cwd, title, live, running, lastUsedAt}`. Only sessions whose folder is
inside an allowed root are listed, attachable or startable. For `open` without
`sessionId`, the gateway makes a new id; with `sessionId` and `resume: false` it starts a
new session with that id (so a client can link it first); with `resume: true` it resumes
it. `name` names a new session.

The gateway sends `{"t":"detached","reason":"..."}` when the attached host goes away, and
`{"t":"closed","reason":"..."}` just before it ends the connection itself (remote control
paused, or this client revoked).

### Session requests (forwarded to the attached host)

| `t` | Fields | Result |
|-----|--------|--------|
| `send` | `text`, `images?`, `tabId?` | `{tabId}`. A new tab, or into tab `tabId` (sent at once on its running turn when the child supports it, else after it). Text starting with `!` runs in bash mode. `images` is `[{mediaType, data}]`, data base64 |
| `interrupt` | | `{}` |
| `stop_bash` | `tabId` | `{}` |
| `answer` | `requestId`, `answers` | `{}`; AskUserQuestion: `answers` maps question text to the chosen label(s) (comma-separated for multi-select) |
| `allow` / `deny` | `requestId` | `{}`; a permission prompt |
| `rewind_targets` | | `{targets: [{uuid, prompt, tabId}]}` newest first |
| `rewind` | `uuid`, `mode` (`both`, `conversation`, `code`) | `{prefill?}`: the prompt to put back in the composer |
| `clear` | | `{sessionId}` |
| `fork` | `title?` | `{sessionId}` |
| `resume` | `id` | `{sessionId}` |
| `cd` | `path`, `trust?` | `{status: "ok", cwd}`, `{status: "needs_trust", directory}` (repeat with `trust: directory`), or `{status: "rejected", message}` |
| `models` | | `{models: [{value, displayName, description?, resolvedModel?, supportedEffortLevels?}]}` |
| `set_model` | `model` | `{}` |
| `set_effort` | `level` | `{}` |
| `mcp_status` | | `{servers: [{name, status, error?}]}` |
| `mcp_toggle` | `server`, `enabled` | `{}` |
| `mcp_reconnect` | `server` | `{}` |
| `chrome` | `on` | `{}`; restarts claude with or without Claude in Chrome |
| `artifacts` | | `{artifacts: [{url, title, tabId}]}` |
| `history` | | `{prompts: string[]}` oldest first, at most 200 |
| `complete` | `partial`, `command?` | `{items: string[]}`: paths in the session folder, or command names |
| `tool_detail` | `tabId`, `toolUseId` | `{block}`: the tool call untruncated |
| `restart` | | `{}`; restarts claude after it exited |

`/resume`, `/clear`, `/fork`, `/rewind`, `/cd` and `/chrome` are refused while a turn
runs or is queued. Slash commands binder runs itself (see README) must be sent as these
requests; any other `/command` in `send` goes to Claude Code as typed.

### The host socket

The gateway talks to a session host over its unix socket with the same JSON, one message
per line. The first line is a hello the gateway writes (a client's own `hello` is refused):

- `{"t":"hello","want":"info"}`: the host answers
  `{"t":"info","sessionId","cwd","title","running","model","pid"}` and closes.
- `{"t":"hello","want":"attach","roots":[...]}`: the host sends a snapshot and patches, and
  takes session requests. With `roots`, it refuses (`{"t":"error"}`) when its folder is
  outside them, and refuses `cd` and `resume` targets outside them.

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

`state` fields: `sessionId`, `cwd`, `model`, `permissionMode`, `usage`, `contextTokens`,
`running` (tab id or null), `activity`, `interrupting`, `canSteer`, `queue`
(`[{tabId, prompt, followup}]`), `steer` (`{tabId, prompt}` or null), `question`,
`childExit` (`{code, stderr}` or null), `tabs`.

`question` is null or `{requestId, kind, toolName, toolInput?, questions}`, where `kind`
is `ask` (AskUserQuestion) or `permission` (allow or deny `toolName` with `toolInput`),
and `questions` is `[{question, header?, multiSelect?, options: [{label, description?}]}]`.

A tab: `{id, prompt, status, blocks, result?, uuid?, bash?, earlier}`, where `earlier`
holds the tab's previous turns, each `{prompt, status, blocks, result?, uuid?, bash?}`.
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
| `blocks` | `id`, `from`, `blocks`, `fields` | replace the tab's blocks from index `from` on, then copy `fields` (`prompt`, `status`, `result`, `uuid`, `bash`) onto the tab |
| `append` | `id`, `index`, `text`, `fields` | append `text` to the text or thinking block at `index`, then copy `fields` |

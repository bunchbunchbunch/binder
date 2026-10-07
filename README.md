# Binder

Claude Code sessions in tabs: each prompt and its response is a tab.

Binder runs the real `claude` binary headless and keeps each session in a host process
(`binder host`). The terminal app and the Mac app are both views of that host, so you can
watch and drive one session from either, or both at once, and a session keeps running when
you close them. All of your Claude Code configuration applies unchanged: hooks, plugins, MCP
servers, CLAUDE.md, skills, and the status line.

| Folder | What it is |
|--------|------------|
| [`tui/`](tui) | `binder`, the terminal app. It also holds the session host, the remote-control gateway (`binder serve`) and its relay. |
| [`gui/`](gui) | Binder for Mac, an Electron app with a session sidebar and responses rendered as documents (heading sizes, tables, highlighted code). |

The Mac app runs the TUI's `binder` command to list and host sessions, so install the TUI
first even if you only plan to use the app.

## Requirements

- Claude Code installed and logged in, with `claude` on your PATH.
- Node 20 or newer for the TUI, Node 22 or newer for the Mac app.
- For the Mac app: macOS on Apple silicon.

## Run the TUI

```sh
git clone https://github.com/bunchbunchbunch/binder.git
cd binder/tui
npm install
npm run build
npm link        # puts `binder` on PATH
```

Then, from any project folder:

```sh
binder                # start a new session here
binder -c             # continue the latest session started here
binder <session-id>   # resume a session
```

`?` on an empty prompt lists the keys, and `/help` explains them. After pulling changes, run
`npm run build` in `tui/` again; a running `binder` keeps its old code until you restart it.
[tui/README.md](tui/README.md) covers usage, configuration, keys, slash commands,
[remote control](tui/README.md#remote-control) from a phone, and how it works.

## Run the Mac app

With the TUI installed as above, from the repository root:

```sh
cd gui
npm install
npx install-electron    # Electron 44 downloads its binary on request
npm run dist            # builds release/mac-arm64/Binder.app (ad-hoc signed)
cp -R release/mac-arm64/Binder.app /Applications/
```

Open Binder from Applications or the Dock. It finds `node` and `binder` through your login
shell, so it works without a terminal. `npm run dev` runs it with hot reload instead.
[gui/README.md](gui/README.md) covers the layout, keys, settings, and panes.

## Configuration

Both apps read `~/.config/binder/config.json` (permission mode, config dirs for a second
account, sticky prompt). `/settings` in the TUI and `⌘,` in the app show and change it.
Sessions, logs and sockets live in `~/.local/state/bindertui/`.

## Development

Each folder is its own npm package; run its commands inside it.

```sh
(cd tui && npm test && npm run typecheck)
(cd gui && npm test && npm run typecheck)
(cd gui && npm run e2e)    # drives the built app against ../tui with a fake claude
```

The e2e tests run the TUI from `../tui`, so build it first. Both apps speak the protocol in
[tui/docs/remote-protocol.md](tui/docs/remote-protocol.md); change both sides together.

## License

MIT. See [LICENSE](LICENSE).

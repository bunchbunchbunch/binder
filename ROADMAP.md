# Roadmap: parity with Claude Code

Features binder needs to keep up with Claude Code's desktop app and terminal UI, in the order we'll build them. The list comes from comparing binder against Claude Code 2.1.331 and its docs (November 2026).

## Rules for every item

- **Configurable.** Anything that changes what you see or how binder behaves gets a setting in `config.json`, editable from `/settings` in the terminal app and `⌘,` in the Mac app. Pick a sensible default and make it easy to turn off.
- **Both apps.** An item applies to the terminal app and the Mac app unless it says otherwise. Protocol changes also update `tui/docs/remote-protocol.md` and both `wire.ts` files.
- **Done means verified.** Tests pass, and the change has been seen working in the real app (fake claude is fine where it fits).
- **One at a time.** Work top to bottom. Tick the box when an item is done.

## High

1. [x] **Artifacts, Docs, and Sheets in binder sessions.** Claude Code turns the Artifact tool off under `-p` (`sdk_default_off`). Binder now sets `CLAUDE_CODE_ARTIFACT=1` for the child, so sessions get `Artifact`, `ArtifactComments`, `ArtifactData`, `/slides`, and the artifact skills. Setting: `artifacts` (on unless false). The claude.ai Claude Docs connector already loaded headlessly, so docs and sheets worked before this change.
2. [x] **Session names everywhere.** The Mac app's sidebar, `⌘K`, `/resume` in both apps, and the phone's list show the session's name (from Claude Code's `custom-title` lines, or binder's index for Codex), falling back to the first prompt.
3. [x] **Codex patch diffs in the Mac app.** Codex `Patch` calls have no view in the Mac app, so their diffs aren't shown. Render them like the terminal app does. Mac app only.
4. [x] **Cost and context display.** Context as a share of the model's window (from `modelUsage`), a breakdown on click in the Mac app (`get_context_usage`), and the session's cost summed across every child binder ran. Setting: `statusText`, a template (`{context}`, `{maxTokens}`, `{percent}`, `{cost}`); the default leaves cost out.
5. [x] **Fast mode toggle.** `Alt+O` (Claude Code's key) and `/fast [on|off]` in both apps, with `↯ fast` in the status bar while it runs. Headless Claude Code takes fast mode only from flag settings (`apply_flag_settings`), then reports `fast_mode_state` on init, each result, and a second `initialize`; when it cannot serve, binder says why and stops asking. Setting: `fastMode` (start sessions with it on; off by default).
6. [x] **Live permission mode switch in the terminal app.** `Alt+M` steps to the next mode, skipping any Claude Code refuses (Claude Code's `Shift+Tab`, which binder gives to effort), and `/permission-mode` (`/mode`) picks one. The Mac app gets the same key and command.
7. [x] **"Always allow" on permission prompts.** Claude Code's `permission_suggestions` become up to two extra choices, its rules and its mode switch kept apart, sent back as `updatedPermissions`. They are plain option labels, so the Mac app gets them with no protocol change (the phone app still offers only Allow and Deny). Setting: `alwaysAllow` (on unless false).
8. [x] **Plan approval.** The plan from `ExitPlanMode` shows as markdown (in the terminal app's transcript, in the Mac app's question card) with `Yes, and use auto mode`, `Yes, and auto-accept edits`, `Yes, and manually approve edits` (each approves and sets the mode in the same answer, a `setMode` update), `No, keep planning`, and typed changes. A session that entered plan mode from bypass gets `Yes, and bypass permissions` first. The plan stays in the transcript once answered. Setting: `planApproval` (on unless false).
9. [x] **Notifications.** The Mac app posts a macOS notification when a question arrives or a turn finishes in a session you aren't looking at (another session on screen, or the app in the background); a click brings that session forward. The terminal app rings the bell for the same while its window is in the background (focus reporting, `ESC[?1004h`). Settings: `notifications` and `bell`, both on unless false.
10. [x] **Doc, sheet, and artifact side pane.** A claude.ai link in a response, `/artifacts`, or `⌃]` opens in a pane to the right of the session (a view of its own with persistent claude.ai cookies, navigation kept to claude.ai and its sign-in), with Open in browser and close; `⌃\` toggles it. Mac app only. Setting: `claudeLinks` (`pane`, the default, or `browser`).
11. [x] **Images in the transcript.** A tool result's images and the images sent with a prompt are kept (the wire carries their kind and size; `image` fetches the bytes). The Mac app shows them inline, plus markdown images of files on this Mac, and web images behind a load button (never fetched on their own). The terminal app draws them inline in iTerm2 (OSC 1337, in rows it leaves, once the screen settles) and shows a caption elsewhere. Setting: `showImages` (on unless false).

## Medium

12. [x] **Clickable file paths.** In the Mac app a tool call's file is a link: a click opens it in your editor (at a Read's line), Option-click shows it in Finder. The terminal app links tool paths with OSC 8 (Cmd+click in iTerm2) and both apps have `/files`: the tab's files, Enter opens one, `f` shows it in Finder. Setting: `editor` (`open`, a command, or one with `{file}` and `{line}`).
13. [x] **Pinned todo, task, and plan panel.** The session's latest todo list (TodoWrite, or the Task tools by task number, whichever Claude touched last) and its current plan stay above the prompt in one line each; `Ctrl+T` (Claude Code's key) or a click opens every item and the plan's markdown. Setting: `todoPanel` (on unless false).
14. [x] **Non-image attachments.** PDFs and text files go with a prompt, dropped or pasted (the Mac app's composer; the terminal app turns a dropped file's path, or a file copied in Finder, into one), as `[File #n: name]`: a PDF as a `document` block Claude reads, a text file as its text. Other files stay `@path` mentions. Codex takes text files, not PDFs.
15. [x] **Archive sessions and full-text search.** `Ctrl+X` in `/resume` and `⌘K` archives a session out of the list (`Ctrl+D` shows the archived ones); typing three characters or more also searches what was said (prompts and replies, cached as text in binder's state dir: 1.3 s cold, 0.3 s warm over 430 MB here), on every computer in the Mac app. `binder sessions --search`/`--archive`/`--unarchive` back both.
16. [x] **Workflow approval and progress.** A workflow asks with a card read from its script's `meta` (name, description, phases): `Run once`, `Always allow workflows` (a `Workflow` rule in `.claude/settings.local.json`), `Deny`. Its run keeps `workflow_progress` on the background task: the row says its phase and agents done, `/tasks` lists phases with each agent's state, model, time and result. Setting: `workflowCard` (on unless false).
17. [x] **Worktree per session.** `binder --worktree [name]` (and `⌥⏎` in the Mac app's New session panel) makes a git worktree of the folder's repo on its own branch and starts the session there; archiving the session removes the worktree and its branch unless that would lose work (changes not committed, a branch not merged), and says what it kept. Setting: `worktrees` (`location`, default `../{repo}-worktrees`; `branchPrefix`, default `binder/`).
18. [x] **Diff review pane.** `/diff` shows the session folder's changes against HEAD or a branch (untracked files as new): in the Mac app a pane where a click on a line adds a comment and Send hands them all to Claude in one prompt, each with its file, line and the line itself; in the terminal app a scrollable view. Host requests `diff` and `branches`. Setting: `diffBase` (HEAD by default).
19. [x] **Per-session terminal pane.** `⌃`` opens the session's own terminal under the prompt (xterm.js over a pty, shared with config panes): your login shell in the session's folder, over ssh for another computer's session. Its keys stay its own (Esc, Ctrl+C) apart from ⌘ keys and `⌃``; it keeps running while hidden and ends with the session. Mac app only. Setting: `terminalCommand`.
20. [x] **PR monitoring.** The session's pull request with CI status, auto-fix for failing checks and review comments, and merge when ready, through `gh`. Setting: auto-fix on or off.

## Low

21. [x] **Code review findings card.** Show `/code-review` findings as a card with "Fix this one" and "Apply fixes". Builds on the diff pane.
22. [x] **File viewer and editor pane.** Browse and edit files in the session's folder. Mac app.
23. [x] **Split view and multiple windows.** Two sessions side by side, or a session in its own window. Mac app.
24. [x] **Side chat (`/btw`).** Ask a question about the session without adding it to the transcript.
25. [x] **Scheduled tasks.** Run a prompt on a schedule in a fresh session, with run history.
26. [x] **Plugin and connector management.** Browse, install, enable, and disable plugins; list connectors.
27. [x] **Browser preview pane.** Start the project's dev server and preview it beside the session, with Claude able to check its own changes. Mac app.
28. [x] **iOS Simulator pane.** Stream the simulator beside the session. Mac app.
29. [ ] **Cloud sessions.** Run or hand off sessions to Anthropic's cloud. Depends on what the CLI exposes; investigate first.
    - **Investigated (November 2026, Claude Code 2.1.331), not built.** What the CLI exposes:
      - `claude -p --cloud "<task>"` creates a cloud session (Claude Code on the web) from the folder: it uploads the working tree, local changes included, and prints `Created cloud session: <id>`, a `View:` claude.ai/code URL, and `Resume with: claude --teleport <id>`. The task goes in the description; a positional prompt or piped stdin alongside it is refused. `--ref <branch|tag|sha>` sets the base; `--on-branch` resumes a branch; `--environment ccpool_...` runs it on a self-hosted environment.
      - `claude -p --cloud <id|url> "<message>"` sends a message to an existing cloud session ("Sent to cloud session."); stream-json is refused there, so binder cannot host a cloud session the way it hosts a local one.
      - `claude --teleport [id]` pulls a cloud session down to continue locally; `--cloud` with `--resume <local id>` moves a local session up (strings: "Moved from a local session").
      - Org policy can deny it (`cloudSessionsDeniedByOrgPolicy`).
    - **Proposed:** `/cloud <task>` runs the first form in the session's folder and opens the View URL in the side pane (a claude.ai page); `/cloud` alone hands off this session (`--cloud --resume <id>`); `/teleport` lists the account's cloud sessions to pull one down into a new binder session. A setting turns `/cloud` off.
    - **Needs before building:** a go-ahead, since every real test creates cloud sessions on the account and uploads the folder, and a throwaway repo to try it in. Fake claude covers the rest.

## Not planned

These don't run when Claude Code is driven headlessly, which is how binder runs it. Matching them would mean building binder's own versions.

- **Agent teams.** Claude Code doesn't spawn teammates under `-p`.
- **Computer use.** Not available under `-p`.
- **Voice dictation.** Claude Code's `/voice` is terminal only. Check whether macOS dictation already works in the Mac app's prompt box before building anything.
- **Mod panes and bands** (including the charts mod). Mod hooks run under `-p`, but drawing doesn't.

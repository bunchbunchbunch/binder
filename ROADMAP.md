# Roadmap: parity with Claude Code

Features binder needs to keep up with Claude Code's desktop app and terminal UI, in the order we'll build them. The list comes from comparing binder against Claude Code 2.1.331 and its docs (November 2026).

## Rules for every item

- **Configurable.** Anything that changes what you see or how binder behaves gets a setting in `config.json`, editable from `/settings` in the terminal app and `⌘,` in the Mac app. Pick a sensible default and make it easy to turn off.
- **Both apps.** An item applies to the terminal app and the Mac app unless it says otherwise. Protocol changes also update `tui/docs/remote-protocol.md` and both `wire.ts` files.
- **Done means verified.** Tests pass, and the change has been seen working in the real app (fake claude is fine where it fits).
- **One at a time.** Work top to bottom. Tick the box when an item is done.

## High

1. [x] **Artifacts, Docs, and Sheets in binder sessions.** Claude Code turns the Artifact tool off under `-p` (`sdk_default_off`). Binder now sets `CLAUDE_CODE_ARTIFACT=1` for the child, so sessions get `Artifact`, `ArtifactComments`, `ArtifactData`, `/slides`, and the artifact skills. Setting: `artifacts` (on unless false). The claude.ai Claude Docs connector already loaded headlessly, so docs and sheets worked before this change.
2. [ ] **Session names everywhere.** The Mac app's sidebar, `⌘K`, and `/resume` show the first prompt instead of the session's name. Show the name, falling back to the first prompt.
3. [ ] **Codex patch diffs in the Mac app.** Codex `Patch` calls have no view in the Mac app, so their diffs aren't shown. Render them like the terminal app does. Mac app only.
4. [ ] **Cost and context display.** Show context as a percentage of the window with a breakdown (like `/context`), and session cost (`total_cost_usd` is already stored). Setting: show or hide cost.
5. [ ] **Fast mode toggle.** A key and a status-bar indicator to turn fast mode on and off, using the `fastMode` setting and the result's `fast_mode_state`.
6. [ ] **Live permission mode switch in the terminal app.** The Mac app can change mode mid-session; the terminal app can't. Add a key and a picker. Mac app already done.
7. [ ] **"Always allow" on permission prompts.** Show the rules Claude suggests with each prompt as extra choices, and send the chosen one back as `updatedPermissions`.
8. [ ] **Plan approval.** Render the plan from `ExitPlanMode` as markdown, with the choices approve and switch to auto mode, approve with manual approval, or keep planning.
9. [ ] **Notifications.** macOS notifications from the Mac app when a turn finishes or a question arrives in a session you aren't looking at, and a bell in the terminal app. Setting: on by default, one switch to turn each off.
10. [ ] **Doc, sheet, and artifact side pane.** Open claude.ai doc, sheet, and artifact links in a pane beside the session instead of the browser. Mac app only. Setting: open in pane or in browser.
11. [ ] **Images in the transcript.** Show images from tool results, markdown images, and images you send. Mac app inline; terminal app inline where the terminal supports it (iTerm2), placeholder elsewhere. Setting: show images.

## Medium

12. [ ] **Clickable file paths.** File paths in tool calls open in your editor or reveal in Finder. Setting: which editor.
13. [ ] **Pinned todo, task, and plan panel.** Keep the latest todo list and the current plan visible instead of only inline in the transcript. Setting: show panel.
14. [ ] **Non-image attachments.** Attach PDFs and other files, not just images, by drag-drop or paste.
15. [ ] **Archive sessions and full-text search.** Archive sessions out of the list, and search transcript text in `⌘K` and `/resume`, not just first prompts.
16. [ ] **Workflow approval and progress.** Show the workflow approval card (phases, once, always, deny) and live phase progress in the background tasks view.
17. [ ] **Worktree per session.** Option to start a session in a new git worktree, and clean it up when the session is archived. Setting: worktree location and branch prefix.
18. [ ] **Diff review pane.** All of a session's changes in one pane, with comments on individual lines sent back to Claude together, and compare against a branch. Mac app; the terminal app gets a `/diff` view.
19. [ ] **Per-session terminal pane.** An interactive terminal in the session's folder, beside the transcript. Mac app (builds on the existing xterm.js panes).
20. [ ] **PR monitoring.** The session's pull request with CI status, auto-fix for failing checks and review comments, and merge when ready, through `gh`. Setting: auto-fix on or off.

## Low

21. [ ] **Code review findings card.** Show `/code-review` findings as a card with "Fix this one" and "Apply fixes". Builds on the diff pane.
22. [ ] **File viewer and editor pane.** Browse and edit files in the session's folder. Mac app.
23. [ ] **Split view and multiple windows.** Two sessions side by side, or a session in its own window. Mac app.
24. [ ] **Side chat (`/btw`).** Ask a question about the session without adding it to the transcript.
25. [ ] **Scheduled tasks.** Run a prompt on a schedule in a fresh session, with run history.
26. [ ] **Plugin and connector management.** Browse, install, enable, and disable plugins; list connectors.
27. [ ] **Browser preview pane.** Start the project's dev server and preview it beside the session, with Claude able to check its own changes. Mac app.
28. [ ] **iOS Simulator pane.** Stream the simulator beside the session. Mac app.
29. [ ] **Cloud sessions.** Run or hand off sessions to Anthropic's cloud. Depends on what the CLI exposes; investigate first.

## Not planned

These don't run when Claude Code is driven headlessly, which is how binder runs it. Matching them would mean building binder's own versions.

- **Agent teams.** Claude Code doesn't spawn teammates under `-p`.
- **Computer use.** Not available under `-p`.
- **Voice dictation.** Claude Code's `/voice` is terminal only. Check whether macOS dictation already works in the Mac app's prompt box before building anything.
- **Mod panes and bands** (including the charts mod). Mod hooks run under `-p`, but drawing doesn't.

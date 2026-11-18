---
name: binder
description: Open Binder.app, or bring it to the front, building only what changed since the last build. Use when the user invokes /binder or asks to start, open, or show Binder.
---

# /binder

Opens the Mac app in front of other windows. Instead of building, it compares source file
times with the build output, so when nothing changed it takes about a second. When the TUI
changed it builds that first (a second or two). When the Mac app changed it hands off to
/rebuild, which takes about two minutes.

1. Run `"${CLAUDE_SKILL_DIR}/binder.sh"`.
2. Exit 0: report Binder's pid in one line. If it built the TUI, also report the processes
   it lists as started before this build (see below).
3. Exit 3: nothing was built. Tell the user in one line which file changed, that Binder is
   rebuilding (about two minutes) and will quit and reopen without asking, and that a turn
   mid-run keeps running in its host. Then run
   `"${CLAUDE_SKILL_DIR}/../rebuild/rebuild.sh" <part>` with a 600000 ms timeout, where
   `<part>` is the script's `rebuild:` line (`gui` or `both`), and report:
   - **Built:** which parts, and Binder's new pid.
   - **Failed:** the step and its error. Do not retry or fix the build unasked.

**Started before this build:** these processes miss whatever this build changed. The
terminal app keeps its code until the user restarts it. Each `binder host` keeps its code
until its session closes or it sits 15 minutes with no window attached; reopening an app
reattaches to it rather than restarting it. Do not kill any of them: one may be hosting this
conversation.

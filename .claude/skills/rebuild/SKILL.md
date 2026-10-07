---
name: rebuild
description: Rebuild binder (the TUI in tui/ and the Mac app in gui/) and relaunch the Mac app on the new build, in front. Use when the user invokes /rebuild or asks to rebuild, relaunch, or restart binder or Binder.app.
argument-hint: "[tui|gui]"
---

# /rebuild

Both apps run build output, not source: `binder` runs `tui/dist/`, and Binder.app runs the
bundle in `gui/release/`. This builds them and relaunches the Mac app in front of other windows.

1. Unless the argument is `tui`, tell the user in one line that Binder will quit and reopen,
   and that it asks first if a session is mid-turn (click Quit; the turn keeps running in its
   host).
2. Run `"$(git rev-parse --show-toplevel)/.claude/skills/rebuild/rebuild.sh" $ARGUMENTS` with
   a 600000 ms timeout. No argument does both; `tui` or `gui` does one.
3. Report from its output:
   - **Built:** which parts, and Binder's new pid if it relaunched.
   - **Failed:** the step and its error. Do not retry or fix the build unasked.
   - **Started before this build:** the processes it lists, which miss whatever this build
     changed. The terminal app keeps its code until the user restarts it. Each `binder host` keeps its code until its session closes or it
     sits 15 minutes with no window attached; reopening an app reattaches to it rather than
     restarting it. Do not kill any of them: one may be hosting this conversation.

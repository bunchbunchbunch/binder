#!/usr/bin/env bash
# Rebuild binder and relaunch the Mac app on the new build.
# Usage: rebuild.sh [tui|gui]   (no argument does both)
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/gui/release/mac-arm64/Binder.app"
APP_PROC='Binder\.app/Contents/MacOS/Binder( |$)'
what="${1:-both}"
case "$what" in
  tui | gui | both) ;;
  *) echo "usage: rebuild.sh [tui|gui]" >&2; exit 2 ;;
esac

step() { echo "[$(date +%T)] $*"; }

if [ "$what" != gui ]; then
  step "building tui"
  (cd "$ROOT/tui" && npm run build)
  built=$(stat -f %m "$ROOT/tui/dist/cli.js")
  # Running binders keep the code they started with.
  step "started before this build:"
  ps -axo pid=,lstart=,command= | { grep -E '[/ ]bin/binder( |$)' || true; } |
    while read -r pid _ mon day time year cmd; do
      start=$(date -j -f '%b %d %T %Y' "$mon $day $time $year" +%s)
      if [ "$start" -lt "$built" ]; then echo "  $pid  since $mon $day $time  binder${cmd#*bin/binder}"; fi
    done
fi

if [ "$what" != tui ]; then
  # Build before quitting, so a broken build leaves the running app alone.
  step "building gui"
  (cd "$ROOT/gui" && npm run build)
  if pgrep -qf "$APP_PROC"; then
    # A quit, by AppleScript or SIGTERM, asks first while a session is mid-turn.
    # SIGKILL skips that: the turns keep running in their hosts, and the pane
    # programs still get the hangup a closed terminal sends.
    step "quitting Binder"
    pkill -KILL -f "$APP_PROC"
    for _ in $(seq 10); do
      pgrep -qf "$APP_PROC" || break
      sleep 1
    done
    if pgrep -qf "$APP_PROC"; then
      echo "Binder did not quit; nothing was packaged" >&2
      exit 1
    fi
  fi
  step "packaging Binder.app"
  (cd "$ROOT/gui" && npm run dist)
  open "$APP"
  for _ in $(seq 15); do
    pgrep -qf "$APP_PROC" && break
    sleep 1
  done
  # open from a background shell leaves Binder behind the current app.
  osascript -e 'tell application id "dev.bindertui.binder" to activate'
  step "Binder running: pid $(pgrep -f "$APP_PROC" || echo none)"
fi

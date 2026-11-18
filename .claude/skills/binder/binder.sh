#!/usr/bin/env bash
# Open Binder, or bring it to the front, without building what has not changed.
# Builds the TUI first when its source is newer than its build. When the Mac
# app's source is newer than Binder.app, it builds nothing and exits 3, naming
# the argument to pass to rebuild.sh.
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/gui/release/mac-arm64/Binder.app"
APP_PROC='Binder\.app/Contents/MacOS/Binder( |$)'

# Prints the first input newer than the build output, or nothing.
changed() {
  local out="$1"; shift
  if [ ! -e "$ROOT/$out" ]; then echo "$out is missing"; return; fi
  (cd "$ROOT" && find "$@" -newer "$out" -print -quit)
}

tui=$(changed tui/dist/cli.js tui/src tui/tsconfig.json tui/package.json)
gui=$(changed gui/release/mac-arm64/Binder.app/Contents/Resources/app.asar \
  gui/src gui/build gui/electron.vite.config.ts gui/package.json gui/package-lock.json \
  gui/tsconfig.node.json gui/tsconfig.web.json)

if [ -n "$gui" ]; then
  echo "gui changed since Binder.app was built: $gui"
  if [ -n "$tui" ]; then
    echo "tui changed since its build: $tui"
    echo "rebuild: both"
  else
    echo "rebuild: gui"
  fi
  exit 3
fi

if [ -n "$tui" ]; then
  echo "tui changed since its build: $tui"
  "$ROOT/.claude/skills/rebuild/rebuild.sh" tui
fi

open "$APP"
for _ in $(seq 15); do
  pgrep -qf "$APP_PROC" && break
  sleep 1
done
# open from a background shell leaves Binder behind the current app.
osascript -e 'tell application id "dev.bindertui.binder" to activate'
echo "Binder running: pid $(pgrep -f "$APP_PROC" || echo none)"

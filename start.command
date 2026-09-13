#!/bin/bash
#
# Double-click this file to open the product uploader.
#
# This is the one file that does not change when the app updates, so it is kept
# deliberately dumb. It does three things:
#
#   1. runs whatever `current` points at
#   2. restarts when that process asks to be restarted (exit 75), which is how
#      an update applies itself without anyone touching a terminal
#   3. puts the previous version back if a freshly installed one fails to start
#
# Point 3 is the whole reason this is more than two lines. The machine this runs
# on cannot be tested against beforehand, so a bad release has to be survivable
# by the person in front of it, who is not technical and is not nearby.

set -u

APP="$(cd "$(dirname "$0")" && pwd)"
cd "$APP"

VERSIONS="$APP/versions"
CURRENT="$APP/current"

# Written by the updater just before it exits 75. Holds the version to fall back
# to. Its presence is what marks the next start as "on probation".
PENDING="$APP/.pending-version"

# Left for the web page to show. Cleared once a start goes well.
ROLLBACK_NOTE="$APP/.rollback-note"

RESTART_CODE=75
ALREADY_RUNNING_CODE=3
PROBATION_SECONDS=10
PORT="${PORT:-4517}"

say() { printf '%s\n' "$*"; }

fail() {
  say ""
  say "$*"
  say ""
  say "Press any key to close this window."
  read -r -n 1 -s
  exit 1
}

# --- node ---------------------------------------------------------------------
# A Finder-launched script does not always inherit the PATH a terminal has, so
# look in the usual places before giving up. The message names the fix, because
# whoever reads it cannot be expected to know what Node is.

if ! command -v node > /dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node > /dev/null 2>&1; then
  fail "Node is not installed on this Mac, and the uploader needs it.
Install it from https://nodejs.org (choose the LTS version), then
double-click this file again."
fi

# --- installed, or a source checkout? -----------------------------------------
#
# Two folders can hold this file and both are legitimate:
#
#   installed   versions/<v>/dist/…  with a `current` symlink. What the zip
#               produces, and what the update button maintains.
#   source      package.json and src/ beside it — a clone, or the repository
#               downloaded as a ZIP. Runs the TypeScript directly.
#
# Updates only exist in the installed layout; a checkout is updated with git.
# Supporting both matters because the source ZIP is how this was delivered
# before the installer existed, and it is still how anyone picks up the code.

if [ -d "$VERSIONS" ]; then
  MODE=installed
elif [ -f "$APP/package.json" ] && [ -f "$APP/src/server/main.ts" ]; then
  MODE=source
else
  fail "This folder does not contain the uploader.
Expected either a 'versions' folder (an installed copy) or 'package.json' and
'src' (the source code) next to this file. Download it again and replace this
whole folder."
fi

point_current_at() {
  # rename(2) over the existing link, so there is never a moment with no
  # `current` at all. `ln -sfn` would unlink first.
  #
  # -h is load-bearing: without it, `mv` follows a symlink that points at a
  # directory and moves the new link *inside* that directory instead of
  # replacing it. Rollback then silently kept running the broken version, which
  # is exactly the failure this whole mechanism exists to prevent.
  ln -sfn "versions/$1" "$CURRENT.new" && mv -fh "$CURRENT.new" "$CURRENT"
}

newest_version() {
  [ -d "$VERSIONS" ] || return 1
  ls -1 "$VERSIONS" 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

# Self-heal a missing link: a fresh install ships no symlink (zip archives carry
# them unreliably), and a deleted one should not need a person to repair it.
if [ "$MODE" = installed ] && [ ! -e "$CURRENT" ]; then
  latest="$(newest_version)" || latest=""
  [ -n "$latest" ] || fail "This folder looks incomplete — 'versions' is there but empty.
Download the uploader again and replace this whole folder."
  point_current_at "$latest"
fi

# --- run ----------------------------------------------------------------------

first_start=1

while true; do
  on_probation=0

  if [ "$MODE" = installed ]; then
    entry="$CURRENT/dist/server/main.js"
    if [ ! -e "$entry" ]; then
      fail "The uploader's files are missing or damaged.
Download it again and replace this whole folder. Your settings are stored
separately and will not be lost."
    fi

    [ -f "$PENDING" ] && on_probation=1

    node "$entry" &
  else
    # A checkout runs the TypeScript through tsx. Called directly rather than
    # through `npm start` so the server's own exit code reaches this script —
    # npm rewrites it, and codes 3 and 75 are how the server asks for something.
    tsx="$APP/node_modules/.bin/tsx"
    if [ ! -x "$tsx" ]; then
      fail "The dependencies are not installed yet.
Open Terminal, then run these two lines:

  cd \"$APP\"
  npm install

Then double-click this file again."
    fi

    "$tsx" "$APP/src/server/main.ts" &
  fi

  server=$!

  if [ "$first_start" -eq 1 ]; then
    # EZOKO_NO_BROWSER is for the launcher's own tests, which would otherwise
    # open a tab every run.
    [ -n "${EZOKO_NO_BROWSER:-}" ] || ( sleep 2; open "http://127.0.0.1:$PORT" > /dev/null 2>&1 ) &
    first_start=0
  fi

  # A version that has run for PROBATION_SECONDS has started successfully. Clear
  # the marker, and from here on a crash is a crash rather than a bad update.
  if [ "$on_probation" -eq 1 ]; then
    survived=0
    for _ in $(seq 1 "$PROBATION_SECONDS"); do
      sleep 1
      kill -0 "$server" 2>/dev/null || { survived=0; break; }
      survived=1
    done
    if [ "$survived" -eq 1 ]; then
      rm -f "$PENDING" "$ROLLBACK_NOTE"
      on_probation=0
    fi
  fi

  wait "$server"
  code=$?

  # Asked to restart: an update has already repointed `current`.
  if [ "$code" -eq "$RESTART_CODE" ]; then
    continue
  fi

  # Already running in another window. Show it rather than reporting a crash —
  # double-clicking the app twice is the ordinary way to get here.
  if [ "$code" -eq "$ALREADY_RUNNING_CODE" ]; then
    [ -n "${EZOKO_NO_BROWSER:-}" ] || open "http://127.0.0.1:$PORT" > /dev/null 2>&1
    exit 0
  fi

  # Died during probation. Put the previous version back and run that instead.
  if [ "$on_probation" -eq 1 ] && [ -f "$PENDING" ]; then
    previous="$(cat "$PENDING")"
    failed="$(basename "$(readlink "$CURRENT")")"
    rm -f "$PENDING"

    if [ -n "$previous" ] && [ -d "$VERSIONS/$previous" ]; then
      point_current_at "$previous"
      printf '%s\n' "$failed|$previous" > "$ROLLBACK_NOTE"
      say ""
      say "Version $failed would not start. Going back to $previous."
      say ""
      continue
    fi

    fail "Version $failed would not start, and there is no earlier version to go
back to. Download the uploader again and replace this whole folder.
Your settings are stored separately and will not be lost."
  fi

  # Ctrl+C, or a clean stop.
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then
    exit 0
  fi

  fail "The uploader stopped unexpectedly (code $code).
Send the newest file from your run reports folder — the 'Where are my files?'
link on the page says where that is."
done

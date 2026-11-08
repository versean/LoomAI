#!/bin/sh
# Loom AI one-line setup (macOS and Linux).
#   Start a new team:   curl -fsSL https://raw.githubusercontent.com/versean/LoomAI/main/install.sh | sh
#   Join a team:        curl -fsSL https://raw.githubusercontent.com/versean/LoomAI/main/install.sh | sh -s -- INVITE_CODE
#                       (a team link asks for your name and email; LOOM_NAME and LOOM_EMAIL answer it ahead of time)
# Installs uv and the `loom` command, creates or joins a team on the hosted Loom AI (or SERVER_URL, the
# optional second argument, for a self-hosted one), connects Cursor, Claude Code and the Claude app, and opens
# `loom watch`. On a computer that is already connected it just updates and reconnects. Safe to run again.
set -eu

CODE=${1:-}
SERVER=${2:-${LOOM_SERVER:-}}
REPO=${LOOM_SOURCE:-"git+https://github.com/versean/LoomAI#subdirectory=packages/cli"}

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ask() {  # ask VAR "Question" — reads from the terminal even when this script is piped into sh
  eval "current=\${$1:-}"
  while [ -z "$current" ]; do
    printf '%s: ' "$2"
    read -r current </dev/tty || { echo; echo "No terminal to ask on; set $1 and run again." >&2; exit 1; }
  done
  eval "$1=\$current"
}

step "1/4 Installing uv (Python tool manager)"
if command -v uv >/dev/null 2>&1; then
  UV=$(command -v uv)
  echo "Already installed: $UV"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi

step "2/4 Installing the loom command"
"$UV" tool install --force --reinstall --quiet "$REPO"
"$UV" tool update-shell >/dev/null 2>&1 || true
LOOM="$("$UV" tool dir --bin)/loom"
echo "Installed: $LOOM"

if [ -n "$SERVER" ]; then
  set -- --server "$SERVER"
else
  set --
fi

if [ -n "$CODE" ]; then
  step "3/4 Joining your team"
  TTY=/dev/null
  if ( : </dev/tty ) 2>/dev/null; then TTY=/dev/tty; fi
  if ! "$LOOM" join "$CODE" "$@" <"$TTY"; then
    if "$LOOM" status >/dev/null 2>&1; then
      echo "This computer is already connected, keeping that."
    else
      echo "Ask your admin for a new invite or team link: they run \`loom invite -p <project>\`." >&2
      exit 1
    fi
  fi
elif "$LOOM" status >/dev/null 2>&1; then
  step "3/4 Already connected"
  echo "Keeping your current team. To join another one, use the line from an invite."
else
  step "3/4 Starting a new team (you will be its admin)"
  LOOM_TEAM=${LOOM_TEAM:-} LOOM_NAME=${LOOM_NAME:-} LOOM_EMAIL=${LOOM_EMAIL:-}
  ask LOOM_TEAM "Team name"
  ask LOOM_NAME "Your name"
  ask LOOM_EMAIL "Your email"
  "$LOOM" init --team "$LOOM_TEAM" --name "$LOOM_NAME" --email "$LOOM_EMAIL" "$@"
fi

step "4/4 Connecting your AI apps"
"$LOOM" connect all || echo "No Cursor, Claude Code or Claude app found; install one, then run \`loom connect all\`."

step "Done!"
if [ -z "${LOOM_NO_WINDOW:-}" ]; then
  "$LOOM" watch --window || echo "Run \`loom watch\` in a new terminal to get messages from teammates live."
fi
echo "Messages, files and skills from teammates appear in the \`loom watch\` window as they arrive."
echo "Restart your AI app, then ask it: \"Loom, who am I?\""
if [ -z "$CODE" ]; then
  echo "Add your code:      cd your-project && loom project create \"My App\" && loom ingest ."
  echo "Invite teammates:   loom invite -p my-app      (one link for your team chat)"
fi

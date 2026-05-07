#!/usr/bin/env bash
# start-pm.sh — bootstrap the PM session with a detached Telegram poller.
#
# What this does:
#   1. Resolves repo root from this script's location (works in any clone path).
#   2. Verifies bots.json exists (else prompt the user to copy from .example).
#   3. Drains any leftover inbox messages older than 1h (stale-message cleanup).
#   4. Spawns the poller as a nohup-detached process (PPID=1, survives shell exit).
#   5. Optionally launches a Claude Code session.
#
# Why nohup + disown: the poller needs to survive the parent shell closing,
# the Claude Code plugin idling out, or terminal restarts. Without nohup, the
# poller dies when its parent process exits. The `while true` wrapper auto-
# respawns the poller if it crashes (it shouldn't, but belt-and-suspenders).
#
# Usage:
#   bash scripts/start-pm.sh [--no-claude]
#
# Flags:
#   --no-claude    Start poller only; don't launch claude. Useful when you
#                  want to keep the poller running but not open a session.

set -euo pipefail

# Resolve repo root from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Inbox + log paths (must match tg-poller.ts STATE_DIR/INBOX_ROOT/LOG_PATH)
STATE_DIR="$HOME/.claude/agent-mesh"
INBOX_DIR="$STATE_DIR/inbox"
POLLER_LOG="$STATE_DIR/poller.log"
mkdir -p "$INBOX_DIR" "$STATE_DIR"

# Verify bots.json exists
BOTS_JSON="$REPO_ROOT/secrets/bots.json"
if [ ! -f "$BOTS_JSON" ]; then
  echo "ERROR: $BOTS_JSON not found." >&2
  echo "" >&2
  echo "Copy the template + fill in your BotFather values:" >&2
  echo "  cp secrets/bots.json.example secrets/bots.json" >&2
  echo "  # then edit secrets/bots.json with real tokens" >&2
  exit 1
fi

# Stale-inbox cleanup (>1h old)
find "$INBOX_DIR" -type f -mmin +60 -delete 2>/dev/null || true

# Check if poller already running
if pgrep -f "$REPO_ROOT/scripts/tg-poller.ts" >/dev/null; then
  echo "Poller already running:"
  ps -o pid,ppid,stat,etime,command -p "$(pgrep -f "$REPO_ROOT/scripts/tg-poller.ts" | head -1)"
else
  # Spawn detached poller with auto-respawn loop
  nohup bash -c "while true; do bun \"$REPO_ROOT/scripts/tg-poller.ts\"; echo \"[\$(date '+%H:%M:%S')] poller respawning\"; sleep 1; done" \
    > "$POLLER_LOG" 2>&1 &
  POLLER_PID=$!
  disown $POLLER_PID

  echo "Poller spawned (PID=$POLLER_PID, log: $POLLER_LOG)"
  sleep 1
  if ps -p $POLLER_PID > /dev/null; then
    echo "Poller alive."
  else
    echo "WARNING: poller died immediately. Check $POLLER_LOG"
    tail -20 "$POLLER_LOG"
    exit 1
  fi
fi

# Optional: launch claude
if [ "${1:-}" = "--no-claude" ]; then
  echo "--no-claude flag set; not launching Claude Code session."
  exit 0
fi

if command -v claude >/dev/null 2>&1; then
  echo ""
  echo "Launching Claude Code session..."
  cd "$REPO_ROOT"
  exec claude
else
  echo ""
  echo "claude CLI not found in PATH. Poller is running; launch your session manually."
fi

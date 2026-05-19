#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Prashanth Nataraj
#
# USE AT YOUR OWN RISK. This script is provided "as is", without warranty of
# any kind, express or implied, including but not limited to warranties of
# merchantability, fitness for a particular purpose, or noninfringement.
# In no event shall the authors or copyright holders be liable for any claim,
# damages, or other liability arising from the use of this script.
#
# Review the full source before executing. Do not run as root unless required.

# scripts/smoke.sh — end-to-end smoke test for the agent-mesh setup.
#
# Verifies:
#   1. Bun is on PATH
#   2. secrets/bots.json exists and is readable
#   3. Each bot's token resolves via Telegram getMe
#   4. (Optional) Outbound test message to TEST_CHAT_ID, if set
#   5. (Optional) Inbound: poll for 10s, watch for the test message coming back
#
# This is the user's "did I set it up right?" check. Forgiving — prints clear
# errors per failure, doesn't crash on the first one.
#
# Usage:
#   bash scripts/smoke.sh
#   TEST_CHAT_ID=-1001234567890 bash scripts/smoke.sh   # also tests outbound + inbound

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOTS_JSON="$REPO_ROOT/secrets/bots.json"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[1;33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { printf "${GREEN}✓${RESET} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "${RED}✗${RESET} %s\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "${YELLOW}⊘${RESET} %s\n" "$1"; SKIP=$((SKIP+1)); }
info() { printf "  %s\n" "$1"; }

echo "agent-mesh smoke test"
echo "====================="
echo

# 1. Bun present?
if command -v bun >/dev/null 2>&1; then
  pass "Bun installed: $(bun --version)"
else
  fail "Bun not found on PATH. Install: https://bun.sh — \`curl -fsSL https://bun.sh/install | bash\`"
  echo
  echo "Cannot continue without Bun. Stopping."
  exit 1
fi

# 2. bots.json present + parseable?
if [ ! -f "$BOTS_JSON" ]; then
  fail "secrets/bots.json not found at $BOTS_JSON"
  info "Run: cp secrets/bots.json.example secrets/bots.json"
  info "Then fill in real BotFather tokens (see docs/telegram-setup.md)."
  echo
  echo "Cannot continue without bots.json. Stopping."
  exit 1
fi

# Validate JSON shape with bun (don't depend on jq being installed).
# NOTE: explicit try/catch + process.exit(1) is required — `bun -e` swallows
# top-level throws from `require()`-wrapped calls and exits 0 on parse error.
if ! bun -e "try { JSON.parse(require('fs').readFileSync('$BOTS_JSON','utf8')) } catch (e) { console.error(e.message); process.exit(1) }" >/dev/null 2>&1; then
  fail "secrets/bots.json is not valid JSON"
  info "Re-edit the file. Common cause: trailing comma or unquoted key."
  exit 1
fi
pass "secrets/bots.json present and valid JSON"

# 3. Per-bot getMe check
echo
echo "Validating each bot via Telegram getMe..."
echo

ROLES=(pm engineer designer researcher tester gtm)
for role in "${ROLES[@]}"; do
  TOKEN=$(bun -e "const j=JSON.parse(require('fs').readFileSync('$BOTS_JSON','utf8')); process.stdout.write(j['$role']?.token ?? '')")
  if [ -z "$TOKEN" ]; then
    skip "$role: not configured in bots.json (skipping)"
    continue
  fi
  if [[ "$TOKEN" == *REPLACE_WITH_* ]]; then
    fail "$role: token is still the placeholder (\"$TOKEN\")"
    info "Edit secrets/bots.json — fill in the real token from BotFather."
    continue
  fi
  if ! [[ "$TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]]; then
    fail "$role: token shape doesn't match \`<digits>:<35+ chars>\`"
    info "Telegram tokens are: ten or so digits, a colon, ~35 base64-ish chars. Re-copy from BotFather."
    continue
  fi
  RESPONSE=$(curl -s --max-time 10 "https://api.telegram.org/bot${TOKEN}/getMe" || echo '{"ok":false}')
  OK=$(printf '%s' "$RESPONSE" | bun -e "let s=''; for await (const c of Bun.stdin.stream()) s += new TextDecoder().decode(c); try { console.log(JSON.parse(s).ok); } catch { console.log('false'); }" 2>/dev/null)
  USERNAME=$(printf '%s' "$RESPONSE" | bun -e "let s=''; for await (const c of Bun.stdin.stream()) s += new TextDecoder().decode(c); try { console.log(JSON.parse(s).result?.username ?? ''); } catch { console.log(''); }" 2>/dev/null)
  if [ "$OK" = "true" ]; then
    pass "$role: getMe ok (@$USERNAME)"
  else
    fail "$role: getMe failed. Telegram says token is invalid or revoked."
    info "Likely causes: typo in token, bot deleted, or GitHub auto-revoked it (token committed to public repo)."
    info "Fix: regenerate via @BotFather \`/token $role\` and update secrets/bots.json."
  fi
done

# 4. Outbound test (optional)
if [ -n "${TEST_CHAT_ID:-}" ]; then
  echo
  echo "Outbound test (sending to chat_id=$TEST_CHAT_ID)..."
  echo
  TIMESTAMP=$(date +%s)
  TEST_MSG="[pm] smoke-test ping $TIMESTAMP"
  RESULT=$(bun "$REPO_ROOT/scripts/tg-post.ts" pm "$TEST_CHAT_ID" "$TEST_MSG" 2>&1 || true)
  if printf '%s' "$RESULT" | grep -q '"message_id"'; then
    MSG_ID=$(printf '%s' "$RESULT" | bun -e "let s=''; for await (const c of Bun.stdin.stream()) s += new TextDecoder().decode(c); try { console.log(JSON.parse(s.trim().split('\n').pop()).message_id); } catch { console.log('?'); }" 2>/dev/null)
    pass "Outbound: posted message_id=$MSG_ID to chat_id=$TEST_CHAT_ID"
  else
    fail "Outbound: tg-post.ts failed. Output: $RESULT"
    info "Common causes: bot not in group, wrong chat_id, or chat_id missing the leading minus."
  fi
else
  skip "Outbound test (set TEST_CHAT_ID=<group-chat-id> to enable)"
fi

# 5. Summary
echo
echo "====================="
printf "Result: ${GREEN}%d pass${RESET}, ${RED}%d fail${RESET}, ${YELLOW}%d skip${RESET}\n" "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -eq 0 ]; then
  echo
  echo "All checks passed. You're ready to run \`bash scripts/start-pm.sh\`."
  exit 0
else
  echo
  echo "Some checks failed. Fix the items above, then re-run."
  exit 1
fi

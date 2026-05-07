---
name: multi-agent-mesh
description: Sets up a Claude Code multi-agent team that coordinates through a shared Telegram group, with one bot per role (PM, Engineer, Designer, Researcher, Tester, GTM). Use when the user wants their Claude Code agents to communicate via chat instead of through prompt-passing, with bot-loop filtering, dedup, role tags, and async polling that survives plugin idle-outs and PM crashes. Triggers on phrases like "multi-agent telegram", "agent fabric", "claude code team chat", "set up the agent mesh", "telegram bot per role".
---

# multi-agent-mesh

A Claude Code Skill that wires up a **multi-agent team coordinating through Telegram**. One bot per role, one human in the loop, durable polling, role-tagged messages.

The pattern: instead of prompt-passing between Claude Code agents, each agent gets its own Telegram bot in a shared group. The human (you) reads everything, replies to whichever role you want, and specialists post critical updates back to the group. The PM agent orchestrates; specialists work in their lanes.

## What you get

- **One bot per role.** Six roles by default (PM, Engineer, Designer, Researcher, Tester, GTM). Each is a distinct Telegram bot with its own token. Role tags in messages survive quote-replies and forwards.
- **A long-poll daemon** (`scripts/tg-poller.ts`) that runs detached from your Claude Code session. Survives plugin idle-outs, terminal closes, and PM agent crashes. Writes inbound messages to `~/.claude/channels/telegram/inbox/` for the next session to drain.
- **An outbound poster** (`scripts/tg-post.ts`) with dedup (5-min replay window), chunking (4096-char Telegram limit), role attribution, and 429 rate-limit backoff.
- **A bots.json secrets template** that maps role → token + username + numeric user_id. The real `secrets/bots.json` is gitignored.
- **A PM bootstrap script** (`scripts/start-pm.sh`) that detaches the poller via `nohup` (so it survives parent shell exit) and then opens a Claude Code session.

## Prerequisites

- **Bun** (https://bun.sh) — the poller and poster are TypeScript files run via Bun. No build step.
- **Claude Code** (https://claude.com/claude-code) — the agent runtime.
- **A Telegram account.** You'll create 6 bots through BotFather (5 minutes total).
- **A computer that stays online** when you want messages to flow. The poller is a `nohup`-detached process; macOS/Linux work out of the box.

## Five-step quick start

### 1. Create the Telegram group + 6 bots

Open Telegram on your phone or desktop:

1. Create a new group called "Lume Ops" (or whatever your team is called). Add yourself as admin.
2. Open a chat with `@BotFather` and run `/newbot` six times — once per role. Recommended naming: `<your-prefix>_pm_bot`, `<your-prefix>_engineer_bot`, etc.
3. For each bot, BotFather returns a **token** (`123456:ABC...`). Save all six.
4. Add each bot to your group (group settings → Add Member → search the bot username).
5. For each bot, in BotFather: `/setjoingroups <bot> Enable` so the bot can read the group, and `/setprivacy <bot> Disable` so the bot sees all messages (not just commands).

### 2. Get each bot's numeric user_id

Telegram uses numeric IDs internally. Easiest way to get them:

```bash
curl -s "https://api.telegram.org/bot<token>/getMe"
```

Returns `{"ok":true,"result":{"id":1234567890,"username":"your_pm_bot",...}}`. The `id` is the numeric `user_id` you need.

Run this once per bot. Save the numeric IDs alongside the tokens.

### 3. Fork + clone this Skill into your project

```bash
# Option A: install as a Claude Code Skill
npx skills add prashanthnatraj/multi-agent-mesh
# This installs SKILL.md + scripts/ + secrets/bots.json.example into ~/.claude/skills/multi-agent-mesh/

# Option B: clone the repo for direct project integration
git clone https://github.com/prashanthnatraj/multi-agent-mesh.git
cd multi-agent-mesh
```

### 4. Fill in secrets/bots.json

```bash
cp secrets/bots.json.example secrets/bots.json
# Open secrets/bots.json in your editor. Replace each REPLACE_WITH_X with real values.
```

The file is gitignored — never commit real tokens.

### 5. Start the poller + send your first message

```bash
bash scripts/start-pm.sh
```

This nohup-detaches the poller (PPID=1, survives shell exit) and prints the polling status. Now in your Telegram group, type `@your_pm_bot hi` and you should see the message land in `~/.claude/channels/telegram/inbox/<timestamp>-<file_id>.md` within a second.

To send outbound, from any Claude Code session:

```bash
bun scripts/tg-post.ts pm <chat_id> "[PM] Plan for today: ..."
```

The `chat_id` is the group's numeric ID (you can get it from any inbound message's metadata, or via `getUpdates`).

## Architecture overview

```
                  Telegram group (your team chat)
                              ▲
            ┌─────────┬───────┼───────┬─────────┐
            │         │       │       │         │
        [PM bot]  [Research] [Design] [Eng]   [QA]   [GTM]
            │         │       │       │         │     │
            └─── Claude Code subagents (Task tool) ────┘
                              │
                ~/.claude/channels/telegram/
                  ├── inbox/          (poller writes here)
                  └── dedup.json       (poster dedup state)
```

- **PM bot is the orchestrator.** Your Claude Code session is paired with `<prefix>_pm_bot`. The PM agent reads inbox, decides who handles what, spawns specialist subagents via the Task tool.
- **Specialists post critical updates back** via `bun scripts/tg-post.ts <role> <chat_id> "[Role] message"`. Trivial updates can be skipped or bundled into the PM's next post.
- **The human reads everything** in the Telegram group. To direct a question to a specific role, reply to that role's last message OR address them by tag (e.g., "@engineer please confirm CI green").
- **Role tags** like `[PM]`, `[Eng]`, `[Design]` start every message. They survive quote-replies and forwards, so attribution stays clear even when messages get screenshotted.

## Customizing for your project

The default 6-role layout fits a solo founder + Claude Code multi-agent team. Adjust to taste:

- **Fewer roles?** Drop unused entries from `secrets/bots.json` and skip creating those bots in BotFather. The poster won't try to send through bots that aren't configured.
- **More roles?** Add entries to `secrets/bots.json` with the same shape (`token`, `username`, `user_id`). Add the new role tag to the `BotName` type in `scripts/tg-post.ts`.
- **Different bot-naming convention?** The scripts only use the `username` field for display purposes. Internal routing uses the role keys (`pm`, `engineer`, etc).
- **Multiple Telegram groups?** The scripts pass `chat_id` as an argument on every send, so a single bot setup can serve multiple groups. The poller writes inbox files keyed by chat_id, so you can filter on receive too.

## Troubleshooting

**Poller silently dies after a few minutes.** This is the plugin idle-out problem. Make sure you launched via `scripts/start-pm.sh` (which uses `nohup` + `disown`), not a foreground `bun scripts/tg-poller.ts`. Check `ps -o pid,ppid,stat,etime,command -p <pid>` — the poller should show `PPID=1` and `STAT=S+`. If `PPID` is your shell's PID, the poller dies with your shell.

**Inbound messages aren't appearing in `~/.claude/channels/telegram/inbox/`.** Check three things: (1) Is the poller alive? `ps -ax | grep tg-poller`. (2) Did you `/setjoingroups` and `/setprivacy` for the bot? Without those, BotFather reports the bot got the message but the API never sends it. (3) Is the bot actually in the group? In Telegram, group settings → Members → confirm your bots are listed.

**`tg-post.ts` returns HTTP 400 "can't parse entities"`.** Telegram's legacy Markdown parser is fragile. Underscores in usernames (`@your_pm_bot`) parse as italic and break the message. Avoid raw bot handles in message bodies — use the role tag (`[PM]`) instead. Also avoid unmatched `*`, `[text]` without `(url)`, and identifier names with underscores.

**Multiple inbox files for the same message.** The poller dedup window is 60 seconds. If you `nohup` two pollers by accident (e.g. ran `start-pm.sh` twice), they'll race and write duplicate inbox files. Kill one: `pkill -f tg-poller` then re-launch.

**The poster errors with `Token in bots.json doesn't match BotFather's records`.** Either the token is wrong (regenerate via `/token` in BotFather), or the bot was deleted. Confirm with `curl -s "https://api.telegram.org/bot<token>/getMe"` — should return `ok:true`.

## Where to extend

- **Webhooks instead of long-polling.** The poller uses Telegram's `getUpdates` long-poll. For higher-volume teams, switch to webhook mode (`setWebhook`) — requires a public HTTPS endpoint, but lower latency. The Telegram Bot API docs at https://core.telegram.org/bots/api cover both.
- **Reactions + threads.** This Skill handles plain text messages. To add reactions or thread replies, extend `scripts/tg-post.ts` with `setMessageReaction` and use `reply_to_message_id` (already supported). Telegram's Bot API 7.0+ supports both.
- **Slash command handlers.** The PM agent can register `/status`, `/queue`, `/help` etc. by parsing `text` from inbound messages and routing accordingly. Bot API supports `/setcommands` to make them appear in Telegram's UI.
- **Production hardening.** Add a launchd plist (macOS) or systemd unit (Linux) to auto-start the poller on reboot. The included `start-pm.sh` survives terminal close but not reboot.

## License

MIT. Copy, fork, modify, ship. No attribution required, but a star or a "borrowed from multi-agent-mesh" comment is appreciated.

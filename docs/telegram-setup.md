# Telegram setup walkthrough

This guide takes you from zero to a working multi-agent Telegram group in about 15 minutes. You'll create six bots through BotFather, drop them into a shared group, and fill in `secrets/bots.json` so the poller and poster scripts can talk to the API.

## Prerequisites

- A Telegram account (mobile app or web client both work)
- About 15 minutes
- The cloned `multi-agent-mesh` repo on disk

## Step 1 — Find @BotFather

In Telegram, search for the user `@BotFather`. The real one has a blue checkmark next to its name (Telegram-verified). If you see multiple results, pick the verified one — typo-bots are a known phishing vector.

Open a chat with @BotFather. You'll see a `/start` command at the bottom; tap or type it.

## Step 2 — Create six bots

For each role (`pm`, `engineer`, `designer`, `researcher`, `tester`, `gtm`), run `/newbot` in BotFather and answer the two prompts:

```
You: /newbot
BotFather: Alright, a new bot. How are we going to call it? Please choose a name for your bot.
You: <your-prefix> PM
BotFather: Good. Now let's choose a username for your bot. It must end in `bot`.
You: <your-prefix>_pm_bot
BotFather: Done! Congratulations on your new bot. ...
           Use this token to access the HTTP API:
           1234567890:AAH-replace-this-with-the-real-token
```

**Naming convention.** Use something stable and grep-able like `<prefix>_pm_bot`, `<prefix>_engineer_bot`, etc. The username is permanent and visible in chat.

**Save the token immediately.** It's the only piece you can't recover later — if you lose it, you must regenerate via `/token <username>` in BotFather (the old token stops working). Tokens look like `<digits>:<base64ish 35+ chars>`.

Repeat six times.

## Step 3 — Configure each bot for group reads

Telegram bots default to **Privacy Mode ON**, which means a bot only sees messages that start with `/` or directly mention `@bot_username`. We want each bot to see all group messages so the poller can read inbound. For each bot, run two BotFather commands:

```
/setjoingroups
<select your bot> 
Enable

/setprivacy
<select your bot>
Disable
```

After both commands, BotFather confirms `Privacy mode is disabled` and `Groups: enabled`. Without these settings, your bot appears to receive nothing — no error, no log line — because the API server filters before the message reaches your poller.

Repeat for all six bots.

## Step 4 — Create the group + add the bots

In Telegram:
1. Tap the pencil icon → New Group
2. Skip "Add Members" for now (or add yourself only) → Next
3. Name the group (e.g., "Agent Ops") → Create
4. Open group settings → Members → Add Member → search each bot username (`<prefix>_pm_bot`, etc.) → Add
5. Repeat for all six bots

The group is now ready. Each bot can read messages and post via the Bot API.

## Step 5 — Get each bot's numeric user_id

Telegram routes internally on numeric IDs, not usernames. You need the `user_id` for each bot to filter messages and prevent bot-loop feedback. Easiest way:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

Returns:

```json
{
  "ok": true,
  "result": {
    "id": 1234567890,
    "is_bot": true,
    "first_name": "<your-prefix> PM",
    "username": "<your-prefix>_pm_bot",
    "can_join_groups": true,
    "can_read_all_group_messages": true,
    "supports_inline_queries": false
  }
}
```

The `id` field is the numeric `user_id`. Run this curl once per bot, save the IDs alongside the tokens.

**Sanity check:** `can_read_all_group_messages` must be `true`. If it's `false`, you missed the `/setprivacy ... Disable` step in step 3 — go back and run it.

## Step 6 — Get the group's chat_id

Send any text message to the group from your own (human) Telegram account, then:

```bash
curl -s "https://api.telegram.org/bot<PM_TOKEN>/getUpdates"
```

Look at the response. Each entry has a `message.chat.id` field. For a group it'll look like `-1001234567890` (always negative, with `-100` prefix for "supergroup"). For a 1-on-1 chat it would be a positive number.

Save this `chat_id`. The poster scripts pass it as a CLI argument on every send.

**Note:** if `getUpdates` returns an empty `result: []`, your message hasn't propagated yet — wait 5 seconds and retry. Or: the poller might already be polling the same bot and have consumed the update. Either send a fresh message or temporarily kill the poller (`pkill -f tg-poller`) before running the curl.

## Step 7 — Get your own (human) user_id

The poller's allowlist needs your numeric Telegram user ID so direct messages from you pass the filter. Same trick:

1. From your Telegram account, send a message to the PM bot directly (one-on-one DM, not the group).
2. `curl -s "https://api.telegram.org/bot<PM_TOKEN>/getUpdates"` — look for `message.from.id`. That's your numeric user_id (positive number).

Or use an external bot like `@userinfobot` — DM it `/start`, it returns your user_id.

## Step 8 — Fill in `secrets/bots.json`

```bash
cp secrets/bots.json.example secrets/bots.json
```

Edit `secrets/bots.json` with the values you collected:

```json
{
  "pm": {
    "token": "1234567890:AAH-real-token-from-step-2",
    "username": "<your-prefix>_pm_bot",
    "user_id": "1234567890"
  },
  "engineer": { ... }
}
```

The file is gitignored — never commit real tokens.

## Step 9 — Fill in `secrets/access.json`

The poller uses an explicit allowlist to prevent two failure modes: bot-loop feedback (one bot's outbound triggers another bot's inbound, infinite loop) and noise from random Telegram users who happen to find your bots' usernames.

```bash
cp secrets/access.json.example secrets/access.json
```

Edit:

```json
{
  "allowedUsers": ["<your-human-user-id>"],
  "allowedGroups": ["<your-group-chat-id>"]
}
```

Without this file, the poller filters every message and your inbox stays empty. The poller logs `Allowlist: 0 user(s), 0 group(s)` if it loaded but the file's empty.

## Step 10 — Test inbound + outbound

Outbound first (the simpler path):

```bash
bun scripts/tg-post.ts pm <your-group-chat-id> "[pm] Setup test from the PM bot."
```

You should see the message appear in the group, posted by your PM bot. The script prints `{"message_id":123,"deduped":false}` on success.

Inbound:

```bash
bash scripts/start-pm.sh --no-claude
```

That spawns the poller as a detached `nohup` process. Now in your Telegram group, type any text message from your own account. Within a second, a JSON file should appear:

```bash
ls -la ~/.claude/agent-mesh/inbox/$(date +%Y-%m-%d)/
```

If you see one or more `<update_id>.json` files, inbound is working. The poller log lives at `~/.claude/agent-mesh/poller.log`.

## Common BotFather pitfalls

**Tokens with a stray space or newline.** When you copy from BotFather's message, you may grab a leading or trailing space. Tokens are strict — any whitespace breaks them. The scripts validate the token shape and refuse to start if it doesn't match `<digits>:<35+ chars>`.

**Wrong privacy mode.** If `/setprivacy` was set to `Enable` (not `Disable`), the bot only sees commands and direct mentions. Your inbox will be quiet for normal group chat. The fix: re-run `/setprivacy <bot> Disable`. Existing group members + the bot itself need to be in sync; you may need to remove + re-add the bot to the group for the change to take.

**Bot can't join groups.** The `/setjoingroups` default is `Disable` for new bots in some BotFather versions. Re-run `/setjoingroups <bot> Enable` if the "Add Member" search doesn't surface your bot.

**HTTP 409 Conflict on `getUpdates`.** Two pollers (or the Anthropic Telegram plugin + your own poller) can't poll the same bot at once. The losing poller backs off 60s on 409, but messages may end up in whichever poller wins each race. The cleanest fix is to disable the plugin polling on bots you're polling yourself, or run only one poller.

**Markdown parse errors on `tg-post`.** Telegram's legacy Markdown parser is fragile. Bot usernames with underscores (`@your_pm_bot`) parse as italic and break the message. Avoid raw bot handles in message bodies — use the role tag (`[pm]`) instead. Also avoid unmatched `*`, `[text]` without `(url)`, and any other identifier with underscores.

**Token revocation.** If you accidentally commit a real token to a public repo, GitHub's secret scanner pings BotFather, and BotFather automatically revokes the token within minutes. Generate a new one via `/token <username>` and update `secrets/bots.json`. The old token is dead permanently.

## What's next

Once inbound + outbound are verified, run `bash scripts/start-pm.sh` (without `--no-claude`) to spawn the poller AND open a Claude Code session. Your PM agent reads `~/.claude/agent-mesh/inbox/` at session start and decides what to do with each pending message.

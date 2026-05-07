---
name: multi-agent-mesh
description: Sets up a Claude Code multi-agent team that coordinates through a shared Telegram group, with one bot per role (PM, Engineer, Designer, Researcher, Tester, GTM). Use when the user wants their Claude Code agents to communicate via chat instead of through prompt-passing, with bot-loop filtering, dedup, role tags, and async polling that survives plugin idle-outs and PM crashes. Triggers on phrases like "multi-agent telegram", "agent fabric", "claude code team chat", "set up the agent mesh", "telegram bot per role".
---

# multi-agent-mesh

A Claude Code Skill that wires up a **multi-agent team coordinating through Telegram**. One bot per role, one human in the loop, durable polling, role-tagged messages.

The pattern: instead of prompt-passing between Claude Code agents, each agent gets its own Telegram bot in a shared group. The human (you) reads everything, replies to whichever role you want, and specialists post critical updates back to the group. The PM agent orchestrates; specialists work in their lanes.

## What you get

- **One bot per role.** Six roles by default (PM, Engineer, Designer, Researcher, Tester, GTM). Each is a distinct Telegram bot with its own token. Role tags in messages survive quote-replies and forwards.
- **A long-poll daemon** (`scripts/tg-poller.ts`) that runs detached from your Claude Code session. Survives plugin idle-outs, terminal closes, and PM agent crashes. Atomic state-file writes, lockfile prevents two pollers from racing on the same bot, signal-flush on SIGTERM/SIGINT. Writes inbound messages to `~/.claude/agent-mesh/inbox/YYYY-MM-DD/<update_id>.json`.
- **An outbound poster** (`scripts/tg-post.ts`) with dedup (60s replay window), chunking (4096-char Telegram limit), role attribution, 429 rate-limit backoff, 30s request timeout, atomic dedup-state writes.
- **Six sanitized agent specs** in `agents/` — drop them into your project's `.claude/agents/` directory and the PM can spawn them via the Task tool.
- **A bots.json + access.json secrets template** that maps role → token + username + numeric user_id, plus an explicit allowlist of human users and group chats. Both real files are gitignored.
- **A PM bootstrap script** (`scripts/start-pm.sh`) that detaches the poller via `nohup` (so it survives parent shell exit) and then opens a Claude Code session.
- **A smoke test** (`scripts/smoke.sh`) that verifies your setup end-to-end before you trust it.

## Prerequisites

- **Bun** (https://bun.sh) — the poller and poster are TypeScript files run via Bun. No build step.
- **Claude Code** (https://claude.com/claude-code) — the agent runtime.
- **A Telegram account.** You'll create 6 bots through BotFather in 15 minutes.
- **A computer that stays online** when you want messages to flow. The poller is a `nohup`-detached process; macOS/Linux work out of the box. Windows users: run via WSL2.

## Quick start

### 1. Install the Skill

```bash
npx skills add prashanthnatraj/multi-agent-mesh
# Installs SKILL.md, scripts/, secrets/, agents/, docs/, package.json into ~/.claude/skills/multi-agent-mesh/
```

Or clone manually:

```bash
git clone https://github.com/prashanthnatraj/multi-agent-mesh.git
cd multi-agent-mesh
```

### 2. Create the Telegram group + 6 bots

Follow [`docs/telegram-setup.md`](./docs/telegram-setup.md) — it walks through every BotFather step, the privacy-mode gotcha that makes bots invisible if missed, how to find your group's chat_id, and how to find your own numeric user_id for the allowlist. Total time: ~15 min.

### 3. Fill in `secrets/bots.json` and `secrets/access.json`

```bash
cp secrets/bots.json.example secrets/bots.json
cp secrets/access.json.example secrets/access.json
# Open both in your editor. Replace each REPLACE_WITH_X with real values from step 2.
```

Both files are gitignored.

### 4. Smoke-test it

```bash
bash scripts/smoke.sh
# To also test outbound:
TEST_CHAT_ID=-1001234567890 bash scripts/smoke.sh
```

You'll see ✓ for each bot whose `getMe` succeeded, ✗ for any that failed (with diagnostic), ⊘ for any optional check you skipped. If everything's green, proceed.

### 5. Start the poller + send your first message

```bash
bash scripts/start-pm.sh
```

This `nohup`-detaches the poller (PPID=1, survives shell exit) and prints the polling status. In your Telegram group, type any message — within a second it should land in `~/.claude/agent-mesh/inbox/<today>/<update_id>.json`.

To send outbound from any Claude Code session:

```bash
bun /ABS/PATH/scripts/tg-post.ts pm <chat_id> "[pm] Plan for today: ..."
```

Use absolute paths so worktree-isolated subagents resolve `secrets/bots.json` regardless of CWD.

## Architecture

```
                  Telegram group (your team chat)
                              ▲
            ┌─────────┬───────┼───────┬─────────┐
            │         │       │       │         │
        [pm bot] [researcher][designer][eng]  [tester] [gtm]
            │         │       │       │         │       │
            └─── Claude Code subagents (Task tool) ──────┘
                              │
                ~/.claude/agent-mesh/
                  ├── inbox/YYYY-MM-DD/  (poller writes here, one .json per update_id)
                  ├── last-update.json   (poller resume cursor)
                  ├── poller.lock        (single-poller invariant)
                  ├── dedup.json         (poster dedup state, 60s TTL)
                  └── poller.log         (poller log)
```

- **PM bot is the orchestrator.** Your Claude Code session is paired with `<prefix>_pm_bot`. The PM agent reads inbox, decides who handles what, spawns specialist subagents via the Task tool.
- **Specialists post critical updates back** via `bun /ABS/PATH/scripts/tg-post.ts <role> <chat_id> "[role] message"`. Trivial updates can be skipped or bundled into the PM's next post.
- **The human reads everything** in the Telegram group. To direct a question to a specific role, reply to that role's last message OR address them by tag (e.g., "@engineer please confirm CI green").
- **Role tags** like `[pm]`, `[engineer]`, `[designer]` start every message. They survive quote-replies and forwards, so attribution stays clear.

## Agent specs

`agents/` ships six pre-written specs you can drop into your project's `.claude/agents/` directory:

| Role | Default tier | Owns |
|---|---|---|
| `pm` | Smart | Orchestration, `tasks/todo.md`, `tasks/lessons.md`, EOD summaries |
| `engineer` | Smart | `src/**`, `tests/**` (unit + integration), opens PRs |
| `designer` | Smart | `tasks/designs/**`, `docs/design-system.md`, no source code |
| `researcher` | Fast/cheap | `tasks/research/**`, daily competitor briefs, weekly agentic |
| `tester` | Mid | `tests/acceptance-criteria.md`, PR verification gate, no `src/` writes |
| `gtm` | Mid | `tasks/gtm/**`, outreach + content drafts, never sends autonomously |

Each spec includes role + responsibilities, file scope, Telegram protocol (when to post vs skip), and a "what you DO / DON'T do" rubric. Tweak names, voices, or scope to fit your project.

## Customizing for your project

The default 6-role layout fits a solo founder + Claude Code multi-agent team. Adjust:

- **Fewer roles?** Drop unused entries from `secrets/bots.json` and skip creating those bots in BotFather. The poster won't try to send through bots that aren't configured.
- **More roles?** Add entries to `secrets/bots.json` with the same shape (`token`, `username`, `user_id`). Add the new role to the `BotName` type in `scripts/tg-post.ts` and create a matching `agents/<role>.md` spec.
- **Different bot-naming convention?** The scripts only use the `username` field for display. Internal routing uses the role keys (`pm`, `engineer`, etc).
- **Multiple Telegram groups?** The scripts pass `chat_id` as an argument on every send, so a single bot setup can serve multiple groups. The poller's `allowedGroups` allowlist supports multiple chat_ids — just add them to `secrets/access.json`.

## Security model

**Tokens.** Each bot has one token. Treat it like a password: a leaked token grants full bot control. The repo's `.gitignore` covers `secrets/bots.json` and `secrets/access.json`. If you accidentally push a real token to a public repo, GitHub's secret scanner pings BotFather, which auto-revokes the token within minutes. Regenerate via `/token <username>` in BotFather.

**Allowlist.** `secrets/access.json` is the explicit list of which Telegram users can DM the PM bot (`allowedUsers`) and which groups the bots will read from (`allowedGroups`). Without it, the poller drops every message — your inbox stays empty even if bots are receiving traffic. The allowlist also prevents bot-loop feedback (one bot's outbound looking like another bot's inbound).

**Trust boundary.** A user with admin rights on the Telegram group can add or remove members, change settings, or replace bots. If you don't fully trust everyone in the group, run a smaller group with stricter membership. The poller does not enforce admin-only writes; that's a Telegram group setting.

**Persistence.** State lives in `~/.claude/agent-mesh/` (poller cursor, dedup cache, lockfile, inbox JSON files, log). All per-machine, never synced. Wipe with `rm -rf ~/.claude/agent-mesh/` if you want a clean reset.

## Troubleshooting

**Poller silently dies after a few minutes.** The plugin idle-out problem. Make sure you launched via `scripts/start-pm.sh` (which uses `nohup` + `disown`), not a foreground `bun scripts/tg-poller.ts`. Check `ps -o pid,ppid,stat,etime,command -p <pid>` — the poller should show `PPID=1` and `STAT=S+`. If `PPID` is your shell's PID, the poller dies with your shell.

**Inbound messages aren't appearing in `~/.claude/agent-mesh/inbox/`.** Three things to check:
1. Is the poller alive? `ps -ax | grep tg-poller`
2. Did you `/setjoingroups <bot> Enable` and `/setprivacy <bot> Disable` for the bot? Without those, the API silently filters every group message before it reaches your poller. Re-run via `@BotFather` and remove + re-add the bot to the group for the change to take.
3. Is `secrets/access.json` populated with your group's chat_id? An empty allowlist drops every message. Check `~/.claude/agent-mesh/poller.log` for the line `Allowlist: N user(s), M group(s)` at startup.

**`tg-post.ts` returns HTTP 400 "can't parse entities".** Telegram's legacy Markdown parser is fragile. Underscores in usernames (`@your_pm_bot`) parse as italic and break the message. Avoid raw bot handles in message bodies — use the role tag (`[pm]`) instead. Also avoid unmatched `*`, `[text]` without `(url)`, and identifier names with underscores.

**Multiple inbox files for the same message.** Shouldn't happen with the lockfile in place — only one poller can run at a time on a single machine. If you're seeing duplicates, run `pkill -f tg-poller` and re-launch via `start-pm.sh`. If the lockfile claims another poller is alive but `ps` doesn't show one, delete `~/.claude/agent-mesh/poller.lock` manually.

**Poller refuses to start: "another poller is alive".** The lockfile detected a live PID. Run `pkill -f tg-poller` to stop the existing instance, then re-launch. If `pkill` finds nothing, the lockfile is stale — delete `~/.claude/agent-mesh/poller.lock` and re-launch.

**HTTP 409 Conflict.** Two pollers (e.g., your script + the Anthropic Telegram plugin) are racing for `getUpdates` on the same bot. The losing poller backs off 60s. Cleanest fix: disable the plugin polling on bots you're polling yourself.

**The poster errors with "Token doesn't look like a BotFather token".** Either the token has a typo / leading whitespace, the file still has a `REPLACE_WITH_*` placeholder, or you confused the user_id with the token. Tokens look like `1234567890:AAH<35+ chars>`. Check `bun -e 'console.log(JSON.parse(require("fs").readFileSync("secrets/bots.json","utf8")).pm.token)'` to print exactly what the script will read.

## Where to extend

- **Webhooks instead of long-polling.** The poller uses Telegram's `getUpdates`. For higher-volume teams, switch to webhook mode (`setWebhook`) — requires a public HTTPS endpoint, lower latency. The Telegram Bot API docs at https://core.telegram.org/bots/api cover both.
- **Reactions + threads.** This Skill handles plain text + file attachments. To add reactions, extend `scripts/tg-post.ts` with `setMessageReaction`. Thread replies are already supported via `--reply-to=<msg_id>`.
- **Slash command handlers.** The PM agent can register `/status`, `/queue`, `/help` etc. by parsing inbound `text` and routing accordingly. Bot API supports `/setcommands` to make them appear in Telegram's UI.
- **Production hardening.** Add a launchd plist (macOS) or systemd unit (Linux) to auto-start the poller on reboot. The included `start-pm.sh` survives terminal close but not reboot.
- **Multi-machine.** State lives per-machine. To run the agent fabric across two laptops or a desktop + server, only one poller per bot at a time (the lockfile is per-machine but the Telegram API rejects duplicate pollers with HTTP 409).

## Cross-platform compatibility

| Platform | Status |
|---|---|
| macOS (Apple Silicon + Intel) | ✅ Native — primary development target |
| Linux (Ubuntu, Debian, Arch) | ✅ Native — Bun + bash both first-class |
| Windows via WSL2 | ✅ Treated as Linux; recommended for Windows users |
| Windows native (PowerShell) | ✗ `start-pm.sh` is bash-only; smoke.sh is bash-only |
| Windows native (Git Bash) | ⚠️ Untested — Bun supports Windows but `nohup`/`disown` semantics differ |

If you're on Windows and don't want to use WSL, the TS scripts (`tg-poller.ts`, `tg-post.ts`) work cross-platform but you'll need a PowerShell or batch equivalent of `start-pm.sh`. PRs welcome.

## License

MIT. Copy, fork, modify, ship. No attribution required, but a star or a "borrowed from multi-agent-mesh" comment is appreciated.

# multi-agent-mesh

> A Claude Code Skill for coordinating multiple agents through a shared Telegram group — one bot per role, one human in the loop. Built for solo founders running Claude Code teams.

## Install as a Claude Code Skill

```bash
npx skills add prashanthnatraj/multi-agent-mesh
```

That fetches `SKILL.md` from this repo and installs it into `~/.claude/skills/multi-agent-mesh/`. The Skill appears in your `/` slash menu next time you launch Claude Code. It bundles:

- **`scripts/tg-poller.ts`** — long-poll Telegram daemon, writes inbox to `~/.claude/channels/telegram/inbox/`
- **`scripts/tg-post.ts`** — outbound bot helper with dedup, chunking, 429 backoff
- **`scripts/start-pm.sh`** — PM session bootstrap that detaches the poller via `nohup`
- **`secrets/bots.json.example`** — template for 6-role bot config (PM, Engineer, Designer, Researcher, Tester, GTM)
- **`SKILL.md`** — the full setup walkthrough (read this first)

## Or fork + clone manually

```bash
git clone https://github.com/prashanthnatraj/multi-agent-mesh.git
cd multi-agent-mesh
cp secrets/bots.json.example secrets/bots.json
# Edit secrets/bots.json with your real BotFather tokens
bash scripts/start-pm.sh
```

The full walkthrough is in [`SKILL.md`](./SKILL.md) — same content, two installation paths.

## What it does

Instead of agents prompt-passing inside one Claude Code session, each role gets its own Telegram bot in a shared group. The PM bot orchestrates; specialists (Engineer, Designer, Researcher, Tester, GTM) post critical updates back. Role tags survive quote-replies and forwards. The poller daemon runs detached so it keeps capturing messages even when you close the Claude Code terminal.

```
                  Telegram group (your team chat)
                              ▲
            ┌─────────┬───────┼───────┬─────────┐
            │         │       │       │         │
        [PM bot]  [Research] [Design] [Eng]   [QA]   [GTM]
            │         │       │       │         │     │
            └─── Claude Code subagents (Task tool) ────┘
```

## Why Telegram

- **Durable** — inbox queues for 24h if your computer's offline
- **Multi-device** — read from phone, laptop, web simultaneously
- **Markdown-rich enough** for code blocks, links, attribution tags
- **Free** at any scale a solo founder hits
- **No-auth-screen-to-build** — BotFather gives you tokens in 5 minutes
- **Beats Slack for solo builders** — Slack is $7+/agent/month and has aggressive idle-kill policies

## Prerequisites

- **Bun** (https://bun.sh) — TypeScript runtime, no build step
- **Claude Code** (https://claude.com/claude-code) — the agent runtime
- **A Telegram account + 5 minutes for BotFather**

## Status

This is the sanitized public distillation of a pattern in production at [Lume AI](https://getlumeai.com). The `SKILL.md` walks through the full setup; the scripts are battle-tested.

The 6 default agent role specs (PM, Engineer, Designer, Researcher, Tester, GTM) ship as a follow-up. For now, customize the role list in `secrets/bots.json` — the scripts work with any subset.

Issues, PRs, and feedback welcome.

## License

MIT. See [LICENSE](./LICENSE).

---

Built solo with AI, in NYC. — [Prashanth Nataraj](https://www.linkedin.com/in/prashanthnatraj/), founder of [Lume AI](https://getlumeai.com).

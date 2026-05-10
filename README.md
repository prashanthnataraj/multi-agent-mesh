# multi-agent-mesh

> A Claude Code Skill for coordinating multiple agents through a shared Telegram group — one bot per role, one human in the loop. Built for solo founders running Claude Code teams.

## Install as a Claude Code Skill

```bash
npx skills add prashanthnatraj/multi-agent-mesh
```

That fetches `SKILL.md` and the bundled assets into `~/.claude/skills/multi-agent-mesh/`. The Skill appears in your `/` slash menu next time you launch Claude Code.

## Or fork + clone manually

```bash
git clone https://github.com/prashanthnatraj/multi-agent-mesh.git
cd multi-agent-mesh
cp secrets/bots.json.example secrets/bots.json
cp secrets/access.json.example secrets/access.json
# Edit both with your real BotFather tokens + chat_id (see docs/telegram-setup.md)
bash scripts/smoke.sh
bash scripts/start-pm.sh
```

The full walkthrough is in [`SKILL.md`](./SKILL.md). The BotFather walkthrough is in [`docs/telegram-setup.md`](./docs/telegram-setup.md).

## What it does

Instead of agents prompt-passing inside one Claude Code session, each role gets its own Telegram bot in a shared group. The PM bot orchestrates; specialists (engineer, designer, researcher, tester, gtm) post critical updates back. Role tags survive quote-replies and forwards. The poller daemon runs detached so it keeps capturing messages even when you close the Claude Code terminal.

```
                  Telegram group (your team chat)
                              ▲
            ┌─────────┬───────┼───────┬─────────┐
            │         │       │       │         │
        [pm bot] [researcher][designer][eng]  [tester] [gtm]
            │         │       │       │         │       │
            └─── Claude Code subagents (Task tool) ──────┘
```

## What's in the box

- **`scripts/tg-poller.ts`** — long-poll Telegram daemon. Atomic state writes, lockfile, signal-flush, token-shape validation. Writes inbox to `~/.claude/agent-mesh/inbox/YYYY-MM-DD/`.
- **`scripts/tg-post.ts`** — outbound bot helper with dedup, chunking, 429 backoff, 30s request timeout.
- **`scripts/start-pm.sh`** — PM session bootstrap. `nohup`-detaches the poller; survives shell exit.
- **`scripts/smoke.sh`** — end-to-end setup verification (per-bot getMe, optional outbound test).
- **`scripts/*.test.ts`** — bun:test unit + integration coverage of the poller + poster (75+ tests, all fetch traffic mocked).
- **`agents/{pm,engineer,designer,researcher,tester,gtm}.md`** — six pre-written agent specs ready to drop into `.claude/agents/`.
- **`docs/telegram-setup.md`** — BotFather walkthrough (15 min, ten ordered steps, common pitfalls).
- **`secrets/bots.json.example` + `secrets/access.json.example`** — templates for the two secret files. Both real files are gitignored.
- **`package.json`** — npm script aliases (`poller`, `post`, `start`, `smoke`, `test`, `typecheck`).

## Tests

The poller and poster ship with `bun:test` coverage. All Telegram API calls
are mocked at the `fetch` boundary — running the suite never hits the real
network and never reads your real `secrets/bots.json` (tests use temp dirs
via `AGENT_MESH_ROOT` / `AGENT_MESH_HOME`).

```bash
bun install     # installs bun-types + typescript
bun test        # ~75 tests, runs in <3s
bun run typecheck
```

What's covered:

- **Poller** — atomic state writes, lockfile single-poller invariant + heartbeat staleness, allowlist filtering (group-by-chat, DM-by-user), inbox JSON shape, attachment extraction (photo/document/voice/audio/video), `pollOnce` HTTP differentiation (401 → auth, 409 → conflict, 5xx → retryable error, network throw → error).
- **Poster** — `TOKEN_RE` shape validation, dedup key determinism, chunking on newline boundary + hard-limit fallback, `tgPost` end-to-end with mocked fetch (sendMessage payload shape, reply_to passthrough, dedup TTL, 5xx retry, 4xx hard-fail, 429 retry_after, `TG_POST_ENABLED=0` short-circuit, multi-chunk threading).
- **Smoke script** — graceful failure paths (missing bots.json, placeholder tokens, malformed JSON).

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
- **A Telegram account + 15 minutes for BotFather** ([guide](./docs/telegram-setup.md))
- **macOS, Linux, or Windows via WSL2.** Native Windows PowerShell isn't supported (the bash entry-point scripts use `nohup`/`disown`).

## Status

This is the sanitized public distillation of a pattern in production at [Lume AI](https://getlumeai.com). The scripts are battle-tested across daily-use sessions; the included agent specs are sanitized derivatives of the same specs running in the source project.

Issues, PRs, and feedback welcome.

## License

MIT. See [LICENSE](./LICENSE).

---

Built solo with AI, in NYC. — [Prashanth Nataraj](https://www.linkedin.com/in/prashanthnatraj/), founder of [Lume AI](https://getlumeai.com).

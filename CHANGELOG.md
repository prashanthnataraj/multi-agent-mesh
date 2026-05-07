# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-05-06

### Added
- `SKILL.md` — full setup walkthrough (1500-word, BotFather → first message in 15 min).
- `README.md` — GitHub-facing intro with the install one-liner.
- `scripts/tg-poller.ts` — long-poll Telegram daemon. Writes inbox to `~/.claude/agent-mesh/inbox/YYYY-MM-DD/<update_id>.json`. Atomic state-file writes, lockfile + heartbeat (refuses to start if another poller is alive), token-shape validation, signal-flush on SIGTERM/SIGINT.
- `scripts/tg-post.ts` — outbound bot helper. Dedup (60s replay window), chunking (4096-char Telegram limit), 429 backoff, 30s request timeout, 4xx-not-retryable distinction, atomic dedup-file writes, token-shape validation.
- `scripts/start-pm.sh` — PM session bootstrap. `nohup`-detaches the poller so it survives shell exit. Auto-respawn loop. Optional `--no-claude` flag for poller-only setup.
- `scripts/smoke.sh` — end-to-end verification (Bun present, secrets readable, each bot's `getMe` succeeds, optional outbound test).
- `agents/{pm,engineer,designer,researcher,tester,gtm}.md` — six sanitized agent specs ready to drop into `.claude/agents/`.
- `docs/telegram-setup.md` — BotFather walkthrough, ten ordered steps, common pitfalls.
- `secrets/bots.json.example` + `secrets/access.json.example` — templates.
- `package.json` — Bun runtime declaration + npm script aliases (`poller`, `post`, `start`, `smoke`).
- `LICENSE` — MIT.
- `.gitignore` — covers `secrets/bots.json`, `secrets/access.json`, env files, logs, dedup state, inbox/.

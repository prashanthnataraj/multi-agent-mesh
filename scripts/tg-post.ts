#!/usr/bin/env bun
// scripts/tg-post.ts — outbound bot poster for the multi-agent-mesh
//
// Called from Bash by specialist subagents to post to a shared Telegram group.
// Tokens are read from secrets/bots.json via absolute path so worktree-isolated
// subagents can resolve them regardless of CWD.
//
// Usage:
//   bun /ABSOLUTE/PATH/scripts/tg-post.ts <botName> <chatId> <text> \
//       [--file=path] [--reply-to=msgId]
//
// Environment:
//   AGENT_MESH_ROOT — absolute path to the directory containing secrets/bots.json
//                     Defaults to the parent dir of this script.
//
// Roles supported (must match keys in bots.json):
//   pm, engineer, designer, researcher, tester, gtm

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ── Constants ────────────────────────────────────────────────────────────────

// Resolve repo root from script location, allow override via env var.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.AGENT_MESH_ROOT
  ? resolve(process.env.AGENT_MESH_ROOT)
  : resolve(SCRIPT_DIR, "..");
const SECRETS_PATH = `${REPO_ROOT}/secrets/bots.json`;
const DEDUP_PATH = `${homedir()}/.claude/agent-mesh/dedup.json`;
const DEDUP_TTL_SEC = 60; // retry window, not idempotency window
const DEDUP_MAX_ENTRIES = 200;
const TEXT_CHUNK_LIMIT = 4096; // Telegram sendMessage hard limit
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 30_000; // hard cap on a single Telegram API call

// Bot-token shape is `<digits>:<base64url-ish 35+ chars>` per BotFather.
// Used as a defensive sanity-check; a malformed token short-circuits the call.
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

type BotName = "pm" | "engineer" | "designer" | "researcher" | "tester" | "gtm";

type BotEntry = {
  token: string;
  username: string;
  user_id: string;
};

type BotsFile = Record<BotName, BotEntry>;

type DedupEntry = {
  key: string;
  message_id: number;
  ts: number;
};

type PostResult = {
  message_id: number;
  deduped: boolean;
};

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  botName: BotName;
  chatId: string;
  text: string;
  file?: string;
  replyTo?: number;
} {
  const positional: string[] = [];
  const opts: { file?: string; replyTo?: number } = {};

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--file=")) opts.file = arg.slice("--file=".length);
    else if (arg.startsWith("--reply-to="))
      opts.replyTo = Number(arg.slice("--reply-to=".length));
    else positional.push(arg);
  }

  if (positional.length < 3) {
    die(
      "Usage: bun tg-post.ts <botName> <chatId> <text> [--file=path] [--reply-to=msgId]",
    );
  }
  const [botName, chatId, text] = positional as [BotName, string, string];
  return { botName, chatId, text, ...opts };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  process.stderr.write(`tg-post: ${msg}\n`);
  process.exit(code);
}

function loadBots(): BotsFile {
  if (!existsSync(SECRETS_PATH)) {
    die(
      `Secrets file not found at ${SECRETS_PATH}. ` +
        `Copy secrets/bots.json.example → secrets/bots.json and fill in tokens. ` +
        `See docs/telegram-setup.md for BotFather walkthrough.`,
    );
  }
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf-8")) as BotsFile;
  } catch (e) {
    die(`Failed to parse bots.json: ${e instanceof Error ? e.message : e}`);
  }
}

function loadDedup(): DedupEntry[] {
  if (!existsSync(DEDUP_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(DEDUP_PATH, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveDedup(entries: DedupEntry[]): void {
  // Atomic write: write to .tmp then rename, so a SIGKILL mid-write never
  // leaves a half-written JSON file that breaks the next call.
  mkdirSync(dirname(DEDUP_PATH), { recursive: true });
  const trimmed = entries.slice(-DEDUP_MAX_ENTRIES);
  const tmp = `${DEDUP_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed));
  renameSync(tmp, DEDUP_PATH);
}

export function dedupKey(
  botName: string,
  chatId: string,
  replyTo: number | undefined,
  text: string,
): string {
  const input = `${botName}|${chatId}|${replyTo ?? ""}|${text.slice(0, 200)}`;
  return createHash("sha256").update(input).digest("hex");
}

export function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.7) splitAt = limit; // avoid tiny chunks
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ── Telegram API ─────────────────────────────────────────────────────────────

async function callTelegram<T = unknown>(
  token: string,
  method: string,
  body: FormData | Record<string, unknown>,
): Promise<T> {
  if (!TOKEN_RE.test(token)) {
    throw new Error(
      `Token doesn't look like a BotFather token (\`<digits>:<35+ chars>\`). ` +
        `Check secrets/bots.json — typo, leading whitespace, or stale token.`,
    );
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const init: RequestInit =
      body instanceof FormData
        ? { method: "POST", body, signal: ctrl.signal }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          };

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network error or AbortError (timeout). Retry unless we've used the budget.
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(
          `telegram ${method} network error after ${MAX_RETRIES} attempts: ${(err as Error).message}`,
        );
      }
      await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const json = (await res.json()) as { ok: boolean; result: T; description?: string };
      if (!json.ok) throw new Error(json.description ?? `telegram ${method} !ok`);
      return json.result;
    }
    if (res.status === 429) {
      const retry = await res.json().catch(() => ({}));
      const waitMs =
        (retry as { parameters?: { retry_after?: number } }).parameters
          ?.retry_after != null
          ? (retry as { parameters: { retry_after: number } }).parameters.retry_after * 1000
          : RETRY_DELAYS_MS[attempt] ?? 4000;
      await sleep(waitMs);
      continue;
    }
    // 5xx is retryable; 4xx other than 429 is a hard error (don't burn retries).
    if (res.status >= 400 && res.status < 500) {
      const errText = await res.text().catch(() => "");
      throw new Error(`telegram ${method} HTTP ${res.status}: ${errText}`);
    }
    const errText = await res.text().catch(() => "");
    if (attempt === MAX_RETRIES - 1) {
      throw new Error(`telegram ${method} HTTP ${res.status}: ${errText}`);
    }
    await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
  }
  throw new Error(`telegram ${method} exhausted retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Post entry point ─────────────────────────────────────────────────────────

export async function tgPost(args: {
  botName: BotName;
  chatId: string;
  text: string;
  file?: string;
  replyTo?: number;
}): Promise<PostResult> {
  // Clean rollback: TG_POST_ENABLED=0 makes the helper a no-op.
  if (process.env.TG_POST_ENABLED === "0") {
    return { message_id: -1, deduped: false };
  }

  const bots = loadBots();
  const entry = bots[args.botName];
  if (!entry?.token) {
    die(
      `Bot "${args.botName}" not in bots.json. ` +
        `Known bots: ${Object.keys(bots).filter((k) => !k.startsWith("_")).join(", ")}`,
    );
  }

  // Idempotency check
  const key = dedupKey(args.botName, args.chatId, args.replyTo, args.text);
  const now = Math.floor(Date.now() / 1000);
  const cache = loadDedup().filter((e) => now - e.ts < DEDUP_TTL_SEC);
  const hit = cache.find((e) => e.key === key);
  if (hit) {
    return { message_id: hit.message_id, deduped: true };
  }

  let messageId: number;

  // Send text (chunked if needed)
  const chunks = chunkText(args.text);
  const sendText = async (chunk: string, reply_to?: number): Promise<number> => {
    const body: Record<string, unknown> = {
      chat_id: args.chatId,
      text: chunk,
      parse_mode: "Markdown",
    };
    if (reply_to != null) body.reply_parameters = { message_id: reply_to };
    const result = await callTelegram<{ message_id: number }>(
      entry.token,
      "sendMessage",
      body,
    );
    return result.message_id;
  };

  messageId = await sendText(chunks[0]!, args.replyTo);
  for (let i = 1; i < chunks.length; i++) {
    await sendText(chunks[i]!, messageId);
  }

  // Optional file attachment
  if (args.file) {
    if (!existsSync(args.file)) {
      die(`File not found: ${args.file}`);
    }
    const fd = new FormData();
    fd.append("chat_id", args.chatId);
    fd.append("reply_parameters", JSON.stringify({ message_id: messageId }));
    const fileBuf = readFileSync(args.file);
    const blob = new Blob([fileBuf]);
    const filename = args.file.split("/").pop() ?? "attachment";
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(filename);
    fd.append(isImage ? "photo" : "document", blob, filename);
    await callTelegram(entry.token, isImage ? "sendPhoto" : "sendDocument", fd);
  }

  cache.push({ key, message_id: messageId, ts: now });
  saveDedup(cache);

  return { message_id: messageId, deduped: false };
}

// ── CLI entry ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = parseArgs(process.argv);
  try {
    const result = await tgPost(args);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`tg-post: ${msg}\n`);
    process.exit(2);
  }
}

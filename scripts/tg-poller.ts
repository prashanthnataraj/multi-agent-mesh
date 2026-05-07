#!/usr/bin/env bun
// scripts/tg-poller.ts — always-on Telegram inbound poller
//
// Decouples inbound message reception from any Claude Code session lifecycle.
// Long-polls the Telegram Bot API getUpdates endpoint, persists allowlisted
// messages to ~/.claude/agent-mesh/inbox/YYYY-MM-DD/<update_id>.json,
// and surfaces a macOS notification per inbound (best-effort).
//
// Coexistence note: if the Anthropic Telegram plugin (or any other consumer)
// polls the same bot, two pollers on one bot = whichever loses the race gets
// HTTP 409. The script backs off 60s on 409 so short-term coexistence is safe;
// messages still land exactly once because update_id is monotonic and the
// winner advances the offset.
//
// Environment:
//   AGENT_MESH_ROOT — absolute path to the directory containing secrets/bots.json
//                     Defaults to the parent dir of this script.
//   AGENT_MESH_DEBUG=1 — verbose logging

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.AGENT_MESH_ROOT
  ? resolve(process.env.AGENT_MESH_ROOT)
  : resolve(SCRIPT_DIR, "..");
const SECRETS_PATH = `${REPO_ROOT}/secrets/bots.json`;
const ACCESS_PATH = `${REPO_ROOT}/secrets/access.json`;

const STATE_DIR = `${HOME}/.claude/agent-mesh`;
const STATE_PATH = `${STATE_DIR}/last-update.json`;
const INBOX_ROOT = `${STATE_DIR}/inbox`;
const LOG_PATH = `${STATE_DIR}/poller.log`;

const LONG_POLL_TIMEOUT_SEC = 25;
const BATCH_LIMIT = 20;
const NOTIFICATION_TEXT_MAX = 180;

const BACKOFF_GENERAL_MS = [1000, 2000, 5000, 10000, 30000];
const BACKOFF_CONFLICT_MS = 60000;

const DEBUG = process.env.AGENT_MESH_DEBUG === "1";

// ── Types ────────────────────────────────────────────────────────────────────

type AccessFile = {
  // Map of allowlisted user_ids (strings) — DMs from these users are accepted.
  allowedUsers?: string[];
  // Map of allowlisted group chat_ids (strings) — group messages from these
  // chats are accepted.
  allowedGroups?: string[];
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
};

type TgMessage = {
  message_id: number;
  date: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; title?: string };
  reply_to_message?: { message_id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; mime_type?: string; duration?: number };
  audio?: { file_id: string; mime_type?: string };
  video?: { file_id: string; mime_type?: string };
};

type InboxEntry = {
  update_id: number;
  message_id: number;
  chat_id: number;
  user_id: number | null;
  ts: number;
  text: string;
  reply_to_message_id?: number;
  attachment?: { kind: string; file_id: string; mime?: string; name?: string };
};

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level: "DEBUG" | "INFO" | "ERROR", msg: string): void {
  if (level === "DEBUG" && !DEBUG) return;
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // best-effort
  }
  if (level === "ERROR") process.stderr.write(line);
  else process.stdout.write(line);
}

// ── Config loading ───────────────────────────────────────────────────────────

function loadToken(): string {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(
      `No secrets file at ${SECRETS_PATH}. ` +
        `Copy secrets/bots.json.example → secrets/bots.json and fill in tokens.`,
    );
  }
  const j = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  if (j?.pm?.token) return j.pm.token as string;
  throw new Error(`No 'pm' bot token in ${SECRETS_PATH}`);
}

function loadAllowlist(): {
  users: Set<string>;
  groups: Set<string>;
} {
  const users = new Set<string>();
  const groups = new Set<string>();
  if (!existsSync(ACCESS_PATH)) {
    log(
      "ERROR",
      `access.json missing at ${ACCESS_PATH} — no chat will pass filter. ` +
        `Create it with shape: {"allowedUsers": ["123456"], "allowedGroups": ["-1001234567890"]}`,
    );
    return { users, groups };
  }
  try {
    const j = JSON.parse(readFileSync(ACCESS_PATH, "utf8")) as AccessFile;
    for (const id of j.allowedUsers ?? []) users.add(String(id));
    for (const id of j.allowedGroups ?? []) groups.add(String(id));
  } catch (err) {
    log("ERROR", `Failed to parse access.json: ${(err as Error).message}`);
  }
  return { users, groups };
}

function loadLastUpdateId(): number {
  if (!existsSync(STATE_PATH)) return 0;
  try {
    const raw = readFileSync(STATE_PATH, "utf8").trim();
    if (!raw) return 0;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    const j = JSON.parse(raw);
    if (typeof j === "number") return j;
    if (typeof j?.lastUpdateId === "number") return j.lastUpdateId;
    return 0;
  } catch (err) {
    log("ERROR", `Failed to parse ${STATE_PATH}: ${(err as Error).message} — starting from 0`);
    return 0;
  }
}

function saveLastUpdateId(id: number): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ lastUpdateId: id }) + "\n", "utf8");
}

// ── Inbox writer ─────────────────────────────────────────────────────────────

function inboxDirForToday(): string {
  // Local-machine timezone — agents reading the inbox infer date from
  // file ts inside each entry, not the directory name.
  const now = new Date();
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `${INBOX_ROOT}/${ymd}`;
}

function extractAttachment(msg: TgMessage): InboxEntry["attachment"] | undefined {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: "photo", file_id: largest.file_id };
  }
  if (msg.document) {
    return {
      kind: "document",
      file_id: msg.document.file_id,
      mime: msg.document.mime_type,
      name: msg.document.file_name,
    };
  }
  if (msg.voice) {
    return { kind: "voice", file_id: msg.voice.file_id, mime: msg.voice.mime_type };
  }
  if (msg.audio) {
    return { kind: "audio", file_id: msg.audio.file_id, mime: msg.audio.mime_type };
  }
  if (msg.video) {
    return { kind: "video", file_id: msg.video.file_id, mime: msg.video.mime_type };
  }
  return undefined;
}

function writeInboxEntry(entry: InboxEntry): string {
  const dir = inboxDirForToday();
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${entry.update_id}.json`;
  writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return path;
}

// ── macOS notification (best-effort) ─────────────────────────────────────────

function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const truncated =
    body.length > NOTIFICATION_TEXT_MAX
      ? body.slice(0, NOTIFICATION_TEXT_MAX - 1) + "…"
      : body;
  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeBody = truncated.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  try {
    spawnSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
  } catch {
    // best-effort
  }
}

// ── Allowlist filter — bot-loop protection ──────────────────────────────────

function isAllowlisted(
  msg: TgMessage,
  allowlist: { users: Set<string>; groups: Set<string> },
): boolean {
  const chatId = String(msg.chat.id);
  const userId = msg.from?.id != null ? String(msg.from.id) : null;
  // Group: chat must be in groups set.
  if (msg.chat.type !== "private" && allowlist.groups.has(chatId)) return true;
  // DM: from-user must be in users set.
  if (msg.chat.type === "private" && userId && allowlist.users.has(userId)) return true;
  return false;
}

// ── Core poll loop ───────────────────────────────────────────────────────────

async function pollOnce(
  token: string,
  offset: number,
): Promise<{ status: "ok" | "conflict" | "auth" | "error"; updates: TgUpdate[] }> {
  const url =
    `https://api.telegram.org/bot${token}/getUpdates` +
    `?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_SEC}&limit=${BATCH_LIMIT}`;
  const fetchTimeoutMs = (LONG_POLL_TIMEOUT_SEC + 5) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    log("ERROR", `Network error: ${(err as Error).message}`);
    return { status: "error", updates: [] };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    const body = await safeText(res);
    log("ERROR", `HTTP 401 (bad token). Body: ${body.slice(0, 200)}`);
    return { status: "auth", updates: [] };
  }
  if (res.status === 409) {
    const body = await safeText(res);
    log("ERROR", `HTTP 409 (conflict — another consumer polling). Body: ${body.slice(0, 200)}`);
    return { status: "conflict", updates: [] };
  }
  if (!res.ok) {
    const body = await safeText(res);
    log("ERROR", `HTTP ${res.status}: ${body.slice(0, 200)}`);
    return { status: "error", updates: [] };
  }
  let json: { ok: boolean; result?: TgUpdate[]; description?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    log("ERROR", `Failed to parse JSON response: ${(err as Error).message}`);
    return { status: "error", updates: [] };
  }
  if (!json.ok) {
    log("ERROR", `Telegram API error: ${json.description ?? "unknown"}`);
    return { status: "error", updates: [] };
  }
  return { status: "ok", updates: json.result ?? [] };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function processUpdate(
  update: TgUpdate,
  allowlist: { users: Set<string>; groups: Set<string> },
): { written: boolean; path?: string; entry?: InboxEntry } {
  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (!msg) {
    log("DEBUG", `update_id=${update.update_id} has no message body — skipping`);
    return { written: false };
  }
  if (!isAllowlisted(msg, allowlist)) {
    log(
      "DEBUG",
      `update_id=${update.update_id} not allowlisted (chat=${msg.chat.id}, user=${msg.from?.id}) — skipping`,
    );
    return { written: false };
  }
  const entry: InboxEntry = {
    update_id: update.update_id,
    message_id: msg.message_id,
    chat_id: msg.chat.id,
    user_id: msg.from?.id ?? null,
    ts: msg.date,
    text: msg.text ?? msg.caption ?? "",
    reply_to_message_id: msg.reply_to_message?.message_id,
    attachment: extractAttachment(msg),
  };
  const path = writeInboxEntry(entry);
  return { written: true, path, entry };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  mkdirSync(INBOX_ROOT, { recursive: true });

  log("INFO", `tg-poller starting (pid=${process.pid})`);

  let token: string;
  try {
    token = loadToken();
  } catch (err) {
    log("ERROR", (err as Error).message);
    process.exit(1);
  }
  const allowlist = loadAllowlist();
  log(
    "INFO",
    `Allowlist: ${allowlist.users.size} user(s), ${allowlist.groups.size} group(s)`,
  );

  let lastUpdateId = loadLastUpdateId();
  log("INFO", `Resuming from lastUpdateId=${lastUpdateId}`);

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    log("INFO", `Received ${signal} — flushing state and exiting`);
    saveLastUpdateId(lastUpdateId);
    stopping = true;
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let backoffIdx = 0;

  while (!stopping) {
    log("DEBUG", `Polling getUpdates offset=${lastUpdateId + 1}`);
    const result = await pollOnce(token, lastUpdateId + 1);

    if (result.status === "auth") {
      await sleep(BACKOFF_CONFLICT_MS);
      continue;
    }
    if (result.status === "conflict") {
      await sleep(BACKOFF_CONFLICT_MS);
      continue;
    }
    if (result.status === "error") {
      const wait =
        BACKOFF_GENERAL_MS[Math.min(backoffIdx, BACKOFF_GENERAL_MS.length - 1)];
      log("DEBUG", `Backoff ${wait}ms (idx=${backoffIdx})`);
      await sleep(wait);
      backoffIdx = Math.min(backoffIdx + 1, BACKOFF_GENERAL_MS.length - 1);
      continue;
    }

    backoffIdx = 0;
    const { updates } = result;
    if (updates.length === 0) continue;

    let maxIdInBatch = lastUpdateId;
    for (const update of updates) {
      const r = processUpdate(update, allowlist);
      if (r.written && r.entry) {
        log(
          "INFO",
          `Wrote ${r.path} (chat=${r.entry.chat_id} msg=${r.entry.message_id} text="${r.entry.text.slice(0, 60).replace(/\n/g, " ")}")`,
        );
        notify(
          "Agent Mesh",
          r.entry.text || `[${r.entry.attachment?.kind ?? "message"}]`,
        );
      }
      if (update.update_id > maxIdInBatch) maxIdInBatch = update.update_id;
    }
    try {
      saveLastUpdateId(maxIdInBatch);
      lastUpdateId = maxIdInBatch;
    } catch (err) {
      log(
        "ERROR",
        `Failed to persist lastUpdateId=${maxIdInBatch}: ${(err as Error).message}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  main().catch((err) => {
    log("ERROR", `Fatal: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}

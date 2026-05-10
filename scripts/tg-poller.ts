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
//   AGENT_MESH_HOME — absolute path to state dir (lock, last-update.json, inbox).
//                     Defaults to ~/.claude/agent-mesh. Used by tests.
//   AGENT_MESH_DEBUG=1 — verbose logging

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

export type Paths = {
  REPO_ROOT: string;
  SECRETS_PATH: string;
  ACCESS_PATH: string;
  STATE_DIR: string;
  STATE_PATH: string;
  INBOX_ROOT: string;
  LOG_PATH: string;
  LOCK_PATH: string;
};

// Path resolution: each helper takes paths explicitly (test seam). The
// `getPaths()` factory wraps the CLI default — `~/.claude/agent-mesh` for
// state and the script's parent dir for the repo root, both overrideable via
// AGENT_MESH_HOME / AGENT_MESH_ROOT env vars.
export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = env.AGENT_MESH_ROOT
    ? resolve(env.AGENT_MESH_ROOT)
    : resolve(SCRIPT_DIR, "..");
  const STATE_DIR = env.AGENT_MESH_HOME
    ? resolve(env.AGENT_MESH_HOME)
    : `${homedir()}/.claude/agent-mesh`;
  return {
    REPO_ROOT,
    SECRETS_PATH: `${REPO_ROOT}/secrets/bots.json`,
    ACCESS_PATH: `${REPO_ROOT}/secrets/access.json`,
    STATE_DIR,
    STATE_PATH: `${STATE_DIR}/last-update.json`,
    INBOX_ROOT: `${STATE_DIR}/inbox`,
    LOG_PATH: `${STATE_DIR}/poller.log`,
    LOCK_PATH: `${STATE_DIR}/poller.lock`,
  };
}

export const LOCK_STALE_SEC = 90; // poller heartbeats lock; staler than this = orphaned

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

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
};

export type TgMessage = {
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

export type InboxEntry = {
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

function log(
  level: "DEBUG" | "INFO" | "ERROR",
  msg: string,
  logPath?: string,
): void {
  if (level === "DEBUG" && !DEBUG) return;
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (logPath) {
    try {
      appendFileSync(logPath, line);
    } catch {
      // best-effort
    }
  }
  if (level === "ERROR") process.stderr.write(line);
  else process.stdout.write(line);
}

// ── Config loading ───────────────────────────────────────────────────────────

export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export function loadToken(secretsPath: string): string {
  if (!existsSync(secretsPath)) {
    throw new Error(
      `No secrets file at ${secretsPath}. ` +
        `Copy secrets/bots.json.example → secrets/bots.json and fill in tokens.`,
    );
  }
  const j = JSON.parse(readFileSync(secretsPath, "utf8"));
  const tok = j?.pm?.token as string | undefined;
  if (!tok) throw new Error(`No 'pm' bot token in ${secretsPath}`);
  if (tok.includes("REPLACE_WITH_") || !TOKEN_RE.test(tok)) {
    throw new Error(
      `'pm' token in ${secretsPath} doesn't look like a real BotFather token. ` +
        `Expected \`<digits>:<35+ chars>\`. Did you forget to fill in the example file?`,
    );
  }
  return tok;
}

export function loadAllowlist(accessPath: string): {
  users: Set<string>;
  groups: Set<string>;
} {
  const users = new Set<string>();
  const groups = new Set<string>();
  if (!existsSync(accessPath)) {
    log(
      "ERROR",
      `access.json missing at ${accessPath} — no chat will pass filter. ` +
        `Create it with shape: {"allowedUsers": ["123456"], "allowedGroups": ["-1001234567890"]}`,
    );
    return { users, groups };
  }
  try {
    const j = JSON.parse(readFileSync(accessPath, "utf8")) as AccessFile;
    for (const id of j.allowedUsers ?? []) users.add(String(id));
    for (const id of j.allowedGroups ?? []) groups.add(String(id));
  } catch (err) {
    log("ERROR", `Failed to parse access.json: ${(err as Error).message}`);
  }
  return { users, groups };
}

export function loadLastUpdateId(statePath: string): number {
  if (!existsSync(statePath)) return 0;
  try {
    const raw = readFileSync(statePath, "utf8").trim();
    if (!raw) return 0;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    const j = JSON.parse(raw);
    if (typeof j === "number") return j;
    if (typeof j?.lastUpdateId === "number") return j.lastUpdateId;
    return 0;
  } catch (err) {
    log(
      "ERROR",
      `Failed to parse ${statePath}: ${(err as Error).message} — starting from 0`,
    );
    return 0;
  }
}

export function saveLastUpdateId(statePath: string, id: number): void {
  // Atomic write: tmp file then rename. A SIGKILL mid-write would otherwise
  // leave a half-written state file that loses the offset on next start.
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastUpdateId: id }) + "\n", "utf8");
  renameSync(tmp, statePath);
}

// ── Lockfile (single-poller invariant) ───────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(
  lockPath: string,
  opts: { now?: number; pid?: number; isAlive?: (pid: number) => boolean } = {},
): { acquired: boolean; reason?: string } {
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const myPid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isProcessAlive;
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid: number;
        ts: number;
      };
      const ageSec = nowSec - (raw.ts ?? 0);
      if (raw.pid && isAlive(raw.pid) && ageSec < LOCK_STALE_SEC) {
        return {
          acquired: false,
          reason: `another poller is alive (pid=${raw.pid}, lock_age=${ageSec}s). Run \`pkill -f tg-poller\` to reset.`,
        };
      }
      // Stale or dead — overwrite.
    } catch {
      // Malformed lock file, treat as stale.
    }
  }
  const tmp = `${lockPath}.${myPid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ pid: myPid, ts: nowSec }) + "\n",
    "utf8",
  );
  renameSync(tmp, lockPath);
  return { acquired: true };
}

export function heartbeatLock(lockPath: string): void {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Math.floor(Date.now() / 1000) }) +
        "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

export function releaseLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      if (raw.pid === process.pid) unlinkSync(lockPath);
    }
  } catch {
    // best-effort
  }
}

// ── Inbox writer ─────────────────────────────────────────────────────────────

export function inboxDirForToday(inboxRoot: string, now: Date = new Date()): string {
  // Local-machine timezone — agents reading the inbox infer date from
  // file ts inside each entry, not the directory name.
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `${inboxRoot}/${ymd}`;
}

export function extractAttachment(msg: TgMessage): InboxEntry["attachment"] | undefined {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
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

export function writeInboxEntry(inboxRoot: string, entry: InboxEntry): string {
  // Atomic write: agent processes drain the inbox dir; a half-written .json
  // would parse-fail and stall the drain. tmp + rename guarantees the agent
  // only ever sees fully-formed files.
  const dir = inboxDirForToday(inboxRoot);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${entry.update_id}.json`;
  const tmp = `${dir}/.${entry.update_id}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
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

export function isAllowlisted(
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

export type PollStatus = "ok" | "conflict" | "auth" | "error";

export async function pollOnce(
  token: string,
  offset: number,
  opts: { logPath?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ status: PollStatus; updates: TgUpdate[] }> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url =
    `https://api.telegram.org/bot${token}/getUpdates` +
    `?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_SEC}&limit=${BATCH_LIMIT}`;
  const fetchTimeoutMs = (LONG_POLL_TIMEOUT_SEC + 5) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { signal: ctrl.signal });
  } catch (err) {
    log("ERROR", `Network error: ${(err as Error).message}`, opts.logPath);
    return { status: "error", updates: [] };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    const body = await safeText(res);
    log("ERROR", `HTTP 401 (bad token). Body: ${body.slice(0, 200)}`, opts.logPath);
    return { status: "auth", updates: [] };
  }
  if (res.status === 409) {
    const body = await safeText(res);
    log(
      "ERROR",
      `HTTP 409 (conflict — another consumer polling). Body: ${body.slice(0, 200)}`,
      opts.logPath,
    );
    return { status: "conflict", updates: [] };
  }
  if (!res.ok) {
    const body = await safeText(res);
    log("ERROR", `HTTP ${res.status}: ${body.slice(0, 200)}`, opts.logPath);
    return { status: "error", updates: [] };
  }
  let json: { ok: boolean; result?: TgUpdate[]; description?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    log(
      "ERROR",
      `Failed to parse JSON response: ${(err as Error).message}`,
      opts.logPath,
    );
    return { status: "error", updates: [] };
  }
  if (!json.ok) {
    log("ERROR", `Telegram API error: ${json.description ?? "unknown"}`, opts.logPath);
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

export function buildInboxEntry(update: TgUpdate): InboxEntry | null {
  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (!msg) return null;
  return {
    update_id: update.update_id,
    message_id: msg.message_id,
    chat_id: msg.chat.id,
    user_id: msg.from?.id ?? null,
    ts: msg.date,
    text: msg.text ?? msg.caption ?? "",
    reply_to_message_id: msg.reply_to_message?.message_id,
    attachment: extractAttachment(msg),
  };
}

export function processUpdate(
  update: TgUpdate,
  allowlist: { users: Set<string>; groups: Set<string> },
  inboxRoot: string,
  logPath?: string,
): { written: boolean; path?: string; entry?: InboxEntry } {
  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (!msg) {
    log(
      "DEBUG",
      `update_id=${update.update_id} has no message body — skipping`,
      logPath,
    );
    return { written: false };
  }
  if (!isAllowlisted(msg, allowlist)) {
    log(
      "DEBUG",
      `update_id=${update.update_id} not allowlisted (chat=${msg.chat.id}, user=${msg.from?.id}) — skipping`,
      logPath,
    );
    return { written: false };
  }
  const entry = buildInboxEntry(update)!;
  const path = writeInboxEntry(inboxRoot, entry);
  return { written: true, path, entry };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const paths = getPaths();
  mkdirSync(dirname(paths.LOG_PATH), { recursive: true });
  mkdirSync(paths.INBOX_ROOT, { recursive: true });

  log("INFO", `tg-poller starting (pid=${process.pid})`, paths.LOG_PATH);

  // Lockfile — refuse to start if another poller is already alive. Two pollers
  // on the same bot race for getUpdates with HTTP 409, plus duplicate inbox
  // writes; cleaner to fail fast here.
  const lock = acquireLock(paths.LOCK_PATH);
  if (!lock.acquired) {
    log("ERROR", `Lock acquisition failed: ${lock.reason}`, paths.LOG_PATH);
    process.exit(2);
  }

  let token: string;
  try {
    token = loadToken(paths.SECRETS_PATH);
  } catch (err) {
    log("ERROR", (err as Error).message, paths.LOG_PATH);
    releaseLock(paths.LOCK_PATH);
    process.exit(1);
  }
  const allowlist = loadAllowlist(paths.ACCESS_PATH);
  log(
    "INFO",
    `Allowlist: ${allowlist.users.size} user(s), ${allowlist.groups.size} group(s)`,
    paths.LOG_PATH,
  );

  let lastUpdateId = loadLastUpdateId(paths.STATE_PATH);
  log("INFO", `Resuming from lastUpdateId=${lastUpdateId}`, paths.LOG_PATH);

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    log(
      "INFO",
      `Received ${signal} — flushing state and exiting`,
      paths.LOG_PATH,
    );
    try {
      saveLastUpdateId(paths.STATE_PATH, lastUpdateId);
    } catch (err) {
      log(
        "ERROR",
        `Failed to flush state on shutdown: ${(err as Error).message}`,
        paths.LOG_PATH,
      );
    }
    releaseLock(paths.LOCK_PATH);
    stopping = true;
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let backoffIdx = 0;

  while (!stopping) {
    heartbeatLock(paths.LOCK_PATH); // refresh ts on every iteration
    log("DEBUG", `Polling getUpdates offset=${lastUpdateId + 1}`, paths.LOG_PATH);
    const result = await pollOnce(token, lastUpdateId + 1, {
      logPath: paths.LOG_PATH,
    });

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
        BACKOFF_GENERAL_MS[Math.min(backoffIdx, BACKOFF_GENERAL_MS.length - 1)]!;
      log("DEBUG", `Backoff ${wait}ms (idx=${backoffIdx})`, paths.LOG_PATH);
      await sleep(wait);
      backoffIdx = Math.min(backoffIdx + 1, BACKOFF_GENERAL_MS.length - 1);
      continue;
    }

    backoffIdx = 0;
    const { updates } = result;
    if (updates.length === 0) continue;

    let maxIdInBatch = lastUpdateId;
    for (const update of updates) {
      const r = processUpdate(update, allowlist, paths.INBOX_ROOT, paths.LOG_PATH);
      if (r.written && r.entry) {
        log(
          "INFO",
          `Wrote ${r.path} (chat=${r.entry.chat_id} msg=${r.entry.message_id} text="${r.entry.text.slice(0, 60).replace(/\n/g, " ")}")`,
          paths.LOG_PATH,
        );
        notify(
          "Agent Mesh",
          r.entry.text || `[${r.entry.attachment?.kind ?? "message"}]`,
        );
      }
      if (update.update_id > maxIdInBatch) maxIdInBatch = update.update_id;
    }
    try {
      saveLastUpdateId(paths.STATE_PATH, maxIdInBatch);
      lastUpdateId = maxIdInBatch;
    } catch (err) {
      log(
        "ERROR",
        `Failed to persist lastUpdateId=${maxIdInBatch}: ${(err as Error).message}`,
        paths.LOG_PATH,
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
    const paths = getPaths();
    releaseLock(paths.LOCK_PATH);
    process.exit(1);
  });
}

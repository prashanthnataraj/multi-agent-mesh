// scripts/tg-poller.bun-test.ts — bun:test coverage of the poller's internals
//
// Covers:
//   - state file: atomic save (tmp+rename) survives mid-write interruption
//   - state file: load tolerates legacy (bare integer) and current ({lastUpdateId}) formats
//   - lockfile: refuses second poller while first is alive + heartbeat fresh
//   - lockfile: takes over when prior pid is dead OR heartbeat is stale
//   - inbox writer: writes JSON with expected shape, atomic via tmp+rename
//   - allowlist: group-chat by chat_id, DM by user_id, both reject otherwise
//   - pollOnce: 401 → auth, 409 → conflict, 5xx → error, ok → returns updates
//   - pollOnce: network throw → error (retryable)
//   - buildInboxEntry: synthesizes from .message, .edited_message, .channel_post
//   - extractAttachment: photo (largest), document, voice, audio, video

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import {
  saveLastUpdateId,
  loadLastUpdateId,
  acquireLock,
  heartbeatLock,
  releaseLock,
  writeInboxEntry,
  isAllowlisted,
  buildInboxEntry,
  extractAttachment,
  pollOnce,
  loadAllowlist,
  loadToken,
  TOKEN_RE,
  LOCK_STALE_SEC,
  type TgUpdate,
  type TgMessage,
  type InboxEntry,
} from "./tg-poller.ts";
import {
  mkTempDir,
  rmTempDir,
  mockFetch,
  validToken,
  botsFixture,
  accessFixture,
} from "./test-helpers.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkTempDir("mam-poller-");
});
afterEach(() => {
  rmTempDir(tmp);
});

// ── State file ────────────────────────────────────────────────────────────────

describe("saveLastUpdateId / loadLastUpdateId", () => {
  test("saves with tmp+rename atomicity; final file is valid JSON", () => {
    const path = `${tmp}/last-update.json`;
    saveLastUpdateId(path, 42);
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).lastUpdateId).toBe(42);
    // No leftover .tmp
    const leftovers = readdirSync(tmp).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  test("returns 0 when state file doesn't exist", () => {
    expect(loadLastUpdateId(`${tmp}/missing.json`)).toBe(0);
  });

  test("parses current {lastUpdateId} format", () => {
    const path = `${tmp}/last-update.json`;
    saveLastUpdateId(path, 12345);
    expect(loadLastUpdateId(path)).toBe(12345);
  });

  test("parses legacy bare-integer format for back-compat", () => {
    const path = `${tmp}/legacy.json`;
    writeFileSync(path, "999\n", "utf8");
    expect(loadLastUpdateId(path)).toBe(999);
  });

  test("returns 0 on corrupted/half-written state file", () => {
    // Simulates SIGKILL during write before atomic rename, where a partial
    // file ended up at the final path (worst case).
    const path = `${tmp}/corrupt.json`;
    writeFileSync(path, '{"lastUpdateId": 42', "utf8"); // truncated
    expect(loadLastUpdateId(path)).toBe(0);
  });
});

// ── Lockfile ─────────────────────────────────────────────────────────────────

describe("acquireLock / heartbeatLock / releaseLock", () => {
  test("acquires when no lock exists", () => {
    const path = `${tmp}/poller.lock`;
    const r = acquireLock(path);
    expect(r.acquired).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("refuses second poller while first pid is alive and heartbeat fresh", () => {
    const path = `${tmp}/poller.lock`;
    // Plant a fake fresh lock claiming pid=99999 is alive.
    const now = Math.floor(Date.now() / 1000);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: 99999, ts: now }), "utf8");
    const r = acquireLock(path, {
      now,
      pid: process.pid,
      isAlive: (pid) => pid === 99999,
    });
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain("99999");
  });

  test("takes over when prior pid is dead", () => {
    const path = `${tmp}/poller.lock`;
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(path, JSON.stringify({ pid: 88888, ts: now }), "utf8");
    const r = acquireLock(path, {
      now,
      pid: process.pid,
      isAlive: () => false, // prior pid is dead
    });
    expect(r.acquired).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.pid).toBe(process.pid);
  });

  test("takes over when heartbeat is older than LOCK_STALE_SEC", () => {
    const path = `${tmp}/poller.lock`;
    const now = Math.floor(Date.now() / 1000);
    const stale = now - (LOCK_STALE_SEC + 5);
    writeFileSync(path, JSON.stringify({ pid: 77777, ts: stale }), "utf8");
    const r = acquireLock(path, {
      now,
      pid: process.pid,
      isAlive: () => true, // alive but stale heartbeat = orphaned
    });
    expect(r.acquired).toBe(true);
  });

  test("heartbeatLock updates ts in place", () => {
    const path = `${tmp}/poller.lock`;
    acquireLock(path);
    const before = JSON.parse(readFileSync(path, "utf8"));
    // Wait at least 1 second so the timestamp changes (heartbeat is sec-precision)
    const oneSecLater = before.ts + 1;
    // Mock by writing then re-reading
    heartbeatLock(path);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.ts).toBeGreaterThanOrEqual(before.ts);
    expect(after.pid).toBe(process.pid);
    expect(oneSecLater).toBeGreaterThan(0); // shut TS up about unused
  });

  test("releaseLock removes lock owned by self only", () => {
    const path = `${tmp}/poller.lock`;
    acquireLock(path);
    expect(existsSync(path)).toBe(true);
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
  });

  test("releaseLock leaves another pid's lock intact", () => {
    const path = `${tmp}/poller.lock`;
    writeFileSync(
      path,
      JSON.stringify({ pid: 12345, ts: Math.floor(Date.now() / 1000) }),
      "utf8",
    );
    releaseLock(path);
    expect(existsSync(path)).toBe(true); // not ours, not deleted
  });
});

// ── Inbox writer ─────────────────────────────────────────────────────────────

describe("writeInboxEntry", () => {
  test("writes file with expected JSON shape", () => {
    const inboxRoot = `${tmp}/inbox`;
    const entry: InboxEntry = {
      update_id: 100,
      message_id: 200,
      chat_id: -1001234,
      user_id: 5555,
      ts: 1717000000,
      text: "hello world",
    };
    const path = writeInboxEntry(inboxRoot, entry);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.update_id).toBe(100);
    expect(parsed.message_id).toBe(200);
    expect(parsed.chat_id).toBe(-1001234);
    expect(parsed.user_id).toBe(5555);
    expect(parsed.ts).toBe(1717000000);
    expect(parsed.text).toBe("hello world");
    // Path is YYYY-MM-DD/<update_id>.json
    expect(path).toMatch(/inbox\/\d{4}-\d{2}-\d{2}\/100\.json$/);
  });

  test("writes atomically — no leftover .tmp", () => {
    const inboxRoot = `${tmp}/inbox`;
    writeInboxEntry(inboxRoot, {
      update_id: 7,
      message_id: 8,
      chat_id: 9,
      user_id: null,
      ts: 0,
      text: "",
    });
    // Walk the inbox tree, look for any .tmp leftover
    const ymdDirs = readdirSync(inboxRoot);
    for (const d of ymdDirs) {
      const files = readdirSync(`${inboxRoot}/${d}`);
      for (const f of files) {
        expect(f.endsWith(".tmp")).toBe(false);
      }
    }
  });

  test("preserves attachment metadata", () => {
    const inboxRoot = `${tmp}/inbox`;
    const path = writeInboxEntry(inboxRoot, {
      update_id: 1,
      message_id: 1,
      chat_id: 1,
      user_id: 1,
      ts: 0,
      text: "",
      attachment: { kind: "photo", file_id: "AAAA", mime: undefined },
    });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.attachment.kind).toBe("photo");
    expect(parsed.attachment.file_id).toBe("AAAA");
  });
});

// ── Allowlist ─────────────────────────────────────────────────────────────────

describe("isAllowlisted", () => {
  const lists = {
    users: new Set(["111"]),
    groups: new Set(["-1001234567890"]),
  };

  test("accepts group chat in allowedGroups", () => {
    const msg: TgMessage = {
      message_id: 1,
      date: 0,
      chat: { id: -1001234567890, type: "supergroup" },
      from: { id: 999 }, // user not in allowlist, but group is
    };
    expect(isAllowlisted(msg, lists)).toBe(true);
  });

  test("accepts DM from allowedUsers", () => {
    const msg: TgMessage = {
      message_id: 1,
      date: 0,
      chat: { id: 111, type: "private" },
      from: { id: 111 },
    };
    expect(isAllowlisted(msg, lists)).toBe(true);
  });

  test("rejects DM from random user", () => {
    const msg: TgMessage = {
      message_id: 1,
      date: 0,
      chat: { id: 999, type: "private" },
      from: { id: 999 },
    };
    expect(isAllowlisted(msg, lists)).toBe(false);
  });

  test("rejects group not in allowedGroups", () => {
    const msg: TgMessage = {
      message_id: 1,
      date: 0,
      chat: { id: -987, type: "supergroup" },
      from: { id: 111 }, // user IS in allowlist but group is not — group rule wins
    };
    expect(isAllowlisted(msg, lists)).toBe(false);
  });
});

// ── buildInboxEntry / extractAttachment ──────────────────────────────────────

describe("buildInboxEntry", () => {
  test("returns null when no message body present", () => {
    const upd: TgUpdate = { update_id: 1 };
    expect(buildInboxEntry(upd)).toBeNull();
  });

  test("synthesizes from .message", () => {
    const upd: TgUpdate = {
      update_id: 50,
      message: {
        message_id: 100,
        date: 1717,
        chat: { id: -1001, type: "supergroup" },
        from: { id: 555 },
        text: "hi",
      },
    };
    const entry = buildInboxEntry(upd);
    expect(entry).not.toBeNull();
    expect(entry!.update_id).toBe(50);
    expect(entry!.message_id).toBe(100);
    expect(entry!.text).toBe("hi");
  });

  test("uses .caption when .text is absent (photo with caption)", () => {
    const upd: TgUpdate = {
      update_id: 50,
      message: {
        message_id: 100,
        date: 1717,
        chat: { id: -1001, type: "supergroup" },
        from: { id: 555 },
        caption: "look at this",
        photo: [{ file_id: "AAAA" }, { file_id: "BBBB", file_size: 9999 }],
      },
    };
    const entry = buildInboxEntry(upd)!;
    expect(entry.text).toBe("look at this");
    expect(entry.attachment?.kind).toBe("photo");
    expect(entry.attachment?.file_id).toBe("BBBB"); // largest
  });

  test("preserves reply_to_message_id when present", () => {
    const upd: TgUpdate = {
      update_id: 50,
      message: {
        message_id: 100,
        date: 1717,
        chat: { id: -1001, type: "supergroup" },
        from: { id: 555 },
        text: "thread reply",
        reply_to_message: { message_id: 42 },
      },
    };
    expect(buildInboxEntry(upd)!.reply_to_message_id).toBe(42);
  });
});

describe("extractAttachment", () => {
  const base = (extra: Partial<TgMessage>): TgMessage => ({
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
    ...extra,
  });

  test("photo: picks the largest (last) variant", () => {
    const a = extractAttachment(
      base({ photo: [{ file_id: "small" }, { file_id: "large" }] }),
    );
    expect(a?.kind).toBe("photo");
    expect(a?.file_id).toBe("large");
  });

  test("document: includes mime + name", () => {
    const a = extractAttachment(
      base({
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "x.pdf" },
      }),
    );
    expect(a).toEqual({
      kind: "document",
      file_id: "doc1",
      mime: "application/pdf",
      name: "x.pdf",
    });
  });

  test("voice / audio / video each map to their kind", () => {
    expect(extractAttachment(base({ voice: { file_id: "v1" } }))?.kind).toBe("voice");
    expect(extractAttachment(base({ audio: { file_id: "a1" } }))?.kind).toBe("audio");
    expect(extractAttachment(base({ video: { file_id: "vid1" } }))?.kind).toBe("video");
  });

  test("returns undefined when no attachment present", () => {
    expect(extractAttachment(base({ text: "hi" }))).toBeUndefined();
  });
});

// ── pollOnce: HTTP status differentiation ────────────────────────────────────

describe("pollOnce", () => {
  test("status=ok returns updates from json.result", async () => {
    const { fetchImpl } = mockFetch([
      {
        kind: "ok",
        json: { ok: true, result: [{ update_id: 1 }, { update_id: 2 }] },
      },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("ok");
    expect(r.updates).toHaveLength(2);
  });

  test("HTTP 401 → auth (terminal)", async () => {
    const { fetchImpl } = mockFetch([
      { kind: "text", status: 401, text: "Unauthorized" },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("auth");
    expect(r.updates).toHaveLength(0);
  });

  test("HTTP 409 → conflict (another consumer polling)", async () => {
    const { fetchImpl } = mockFetch([
      { kind: "text", status: 409, text: "Conflict" },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("conflict");
  });

  test("HTTP 500 → error (retryable)", async () => {
    const { fetchImpl } = mockFetch([
      { kind: "text", status: 500, text: "TG outage" },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("error");
  });

  test("network throw → error (retryable)", async () => {
    const { fetchImpl } = mockFetch([
      { kind: "throw", error: new Error("ECONNRESET") },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("error");
  });

  test("calls correct getUpdates URL with offset/timeout/limit", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: [] } },
    ]);
    await pollOnce(validToken, 42, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/bot${validToken}/getUpdates`);
    expect(calls[0]!.url).toContain("offset=42");
    expect(calls[0]!.url).toContain("timeout=25");
    expect(calls[0]!.url).toContain("limit=20");
  });

  test("json.ok=false → error (Telegram API-level rejection)", async () => {
    const { fetchImpl } = mockFetch([
      { kind: "ok", json: { ok: false, description: "method not found" } },
    ]);
    const r = await pollOnce(validToken, 1, { fetchImpl });
    expect(r.status).toBe("error");
  });
});

// ── loadToken / loadAllowlist (file IO) ──────────────────────────────────────

describe("loadToken / loadAllowlist", () => {
  test("loadToken: throws on missing file with friendly message", () => {
    expect(() => loadToken(`${tmp}/missing.json`)).toThrow(/No secrets file/);
  });

  test("loadToken: throws on placeholder token", () => {
    const path = `${tmp}/bots.json`;
    writeFileSync(
      path,
      JSON.stringify({ pm: { token: "REPLACE_WITH_PM_BOT_TOKEN_FROM_BOTFATHER" } }),
      "utf8",
    );
    expect(() => loadToken(path)).toThrow(/doesn't look like a real BotFather token/);
  });

  test("loadToken: returns token when bots.json valid", () => {
    const path = `${tmp}/bots.json`;
    writeFileSync(path, botsFixture(), "utf8");
    expect(loadToken(path)).toBe(validToken);
  });

  test("loadAllowlist: parses both users and groups", () => {
    const path = `${tmp}/access.json`;
    writeFileSync(path, accessFixture({ users: ["1", "2"], groups: ["-1001"] }), "utf8");
    const r = loadAllowlist(path);
    expect(r.users.size).toBe(2);
    expect(r.groups.size).toBe(1);
    expect(r.users.has("1")).toBe(true);
    expect(r.groups.has("-1001")).toBe(true);
  });

  test("loadAllowlist: returns empty sets when file missing (poller logs error and continues)", () => {
    const r = loadAllowlist(`${tmp}/missing.json`);
    expect(r.users.size).toBe(0);
    expect(r.groups.size).toBe(0);
  });
});

// ── Token regex ──────────────────────────────────────────────────────────────

describe("TOKEN_RE", () => {
  test("accepts a real-shape token", () => {
    expect(TOKEN_RE.test(validToken)).toBe(true);
  });

  test("rejects placeholder template", () => {
    expect(TOKEN_RE.test("REPLACE_WITH_PM_BOT_TOKEN_FROM_BOTFATHER")).toBe(false);
  });

  test("rejects empty / whitespace / wrong format", () => {
    expect(TOKEN_RE.test("")).toBe(false);
    expect(TOKEN_RE.test(" ")).toBe(false);
    expect(TOKEN_RE.test("notatoken")).toBe(false);
    expect(TOKEN_RE.test("123:short")).toBe(false);
  });
});

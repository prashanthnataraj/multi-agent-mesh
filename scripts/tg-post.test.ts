// scripts/tg-post.test.ts — bun:test coverage of the poster
//
// Covers:
//   - TOKEN_RE: accepts real-shape, rejects placeholders / malformed
//   - chunkText: under-limit pass-through, splits long text on newline boundary
//   - dedupKey: deterministic for same args, varies on each component
//   - tgPost: sends sendMessage with correct chat_id + text + parse_mode
//   - tgPost: passes reply_to via reply_parameters.message_id
//   - tgPost: dedups within TTL, sends new after expiry
//   - tgPost: retries 5xx, surfaces 4xx as hard error (no retry)
//   - tgPost: 429 honors retry_after parameter
//   - tgPost: TG_POST_ENABLED=0 short-circuits to no-op
//   - loadBots: parses fixture
//
// Module-load-time setup:
//   AGENT_MESH_ROOT and AGENT_MESH_HOME are set BEFORE the dynamic import of
//   tg-post.ts so the module-level path constants resolve to per-test temp dirs.

import { test, expect, describe, beforeEach, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, validToken, botsFixture } from "./test-helpers.ts";

// ── Module-load-time setup ──────────────────────────────────────────────────
// IMPORTANT: ES module static `import` statements are hoisted, so importing
// tg-post.ts before these env-var assignments would resolve module-level
// paths against the user's real home dir. We use dynamic `import()` after
// setting env so paths resolve against our temp dirs.

const ROOT_DIR = join(tmpdir(), `mam-tgpost-root-${process.pid}`);
const STATE_DIR = join(tmpdir(), `mam-tgpost-state-${process.pid}`);
process.env.AGENT_MESH_ROOT = ROOT_DIR;
process.env.AGENT_MESH_HOME = STATE_DIR;
delete process.env.TG_POST_ENABLED;

mkdirSync(`${ROOT_DIR}/secrets`, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const tgPostMod = await import("./tg-post.ts");
const {
  TOKEN_RE,
  chunkText,
  dedupKey,
  tgPost,
  loadBots,
  loadDedup,
  saveDedup,
  callTelegram,
  DEDUP_PATH,
  DEDUP_TTL_SEC,
  SECRETS_PATH,
} = tgPostMod;

beforeAll(() => {
  // Sanity: confirm SECRETS_PATH + DEDUP_PATH point at our temp dirs (i.e.
  // the env vars resolved BEFORE module load). If this fails, the env-var
  // contract above is broken and every test below is meaningless.
  if (!SECRETS_PATH.startsWith(ROOT_DIR)) {
    throw new Error(
      `SECRETS_PATH (${SECRETS_PATH}) didn't pick up AGENT_MESH_ROOT — test setup broken.`,
    );
  }
  if (!DEDUP_PATH.startsWith(STATE_DIR)) {
    throw new Error(
      `DEDUP_PATH (${DEDUP_PATH}) didn't pick up AGENT_MESH_HOME — test setup broken.`,
    );
  }
});

beforeEach(() => {
  // Fresh secrets/bots.json + clean dedup before each test.
  writeFileSync(SECRETS_PATH, botsFixture(), "utf8");
  if (existsSync(DEDUP_PATH)) rmSync(DEDUP_PATH);
});

// ── TOKEN_RE ─────────────────────────────────────────────────────────────────

describe("TOKEN_RE", () => {
  test("accepts a real-shape BotFather token", () => {
    expect(TOKEN_RE.test(validToken)).toBe(true);
  });

  test("rejects the example-file placeholder", () => {
    expect(TOKEN_RE.test("REPLACE_WITH_PM_BOT_TOKEN_FROM_BOTFATHER")).toBe(false);
  });

  test("rejects malformed shapes", () => {
    expect(TOKEN_RE.test("")).toBe(false);
    expect(TOKEN_RE.test("123456789")).toBe(false); // no colon
    expect(TOKEN_RE.test("123:short")).toBe(false); // post-colon too short
    expect(TOKEN_RE.test(":nodigits")).toBe(false);
  });

  test("accepts the exact length BotFather emits (35 chars after colon)", () => {
    const t = "1234567890:" + "A".repeat(35);
    expect(TOKEN_RE.test(t)).toBe(true);
  });
});

// ── chunkText ────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  test("returns single-element array for under-limit text", () => {
    expect(chunkText("hello", 4096)).toEqual(["hello"]);
  });

  test("splits a long block on newline boundary", () => {
    const block = "A".repeat(3000) + "\n" + "B".repeat(3000);
    const chunks = chunkText(block, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.endsWith("A")).toBe(true);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
    expect(chunks[1]!.startsWith("B")).toBe(true);
  });

  test("splits at hard limit when no good newline boundary exists", () => {
    const block = "A".repeat(5000);
    const chunks = chunkText(block, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
    expect(chunks[0]!.length + chunks[1]!.length).toBe(5000);
  });

  test("preserves total content across chunks", () => {
    const original = "x".repeat(10000);
    const chunks = chunkText(original, 4096);
    const recombined = chunks.join("");
    expect(recombined.length).toBe(original.length);
  });
});

// ── dedupKey ─────────────────────────────────────────────────────────────────

describe("dedupKey", () => {
  test("identical inputs → identical key", () => {
    const a = dedupKey("pm", "-100", undefined, "hello");
    const b = dedupKey("pm", "-100", undefined, "hello");
    expect(a).toBe(b);
  });

  test("different bot → different key", () => {
    const a = dedupKey("pm", "-100", undefined, "hello");
    const b = dedupKey("engineer", "-100", undefined, "hello");
    expect(a).not.toBe(b);
  });

  test("different chat → different key", () => {
    const a = dedupKey("pm", "-100", undefined, "hello");
    const b = dedupKey("pm", "-200", undefined, "hello");
    expect(a).not.toBe(b);
  });

  test("different replyTo → different key", () => {
    const a = dedupKey("pm", "-100", undefined, "hello");
    const b = dedupKey("pm", "-100", 42, "hello");
    expect(a).not.toBe(b);
  });

  test("different text → different key", () => {
    const a = dedupKey("pm", "-100", undefined, "hello");
    const b = dedupKey("pm", "-100", undefined, "world");
    expect(a).not.toBe(b);
  });
});

// ── loadBots ─────────────────────────────────────────────────────────────────

describe("loadBots", () => {
  test("returns parsed bots config", () => {
    const bots = loadBots();
    expect(bots.pm.token).toBe(validToken);
    expect(bots.pm.username).toBe("pm_bot");
    expect(bots.engineer.username).toBe("eng_bot");
  });
});

// ── loadDedup / saveDedup ────────────────────────────────────────────────────

describe("loadDedup / saveDedup", () => {
  test("loadDedup returns [] when file doesn't exist", () => {
    expect(loadDedup()).toEqual([]);
  });

  test("saveDedup writes file containing the entry", () => {
    saveDedup([{ key: "k1", message_id: 1, ts: Math.floor(Date.now() / 1000) }]);
    expect(existsSync(DEDUP_PATH)).toBe(true);
    const parsed = JSON.parse(readFileSync(DEDUP_PATH, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("k1");
  });

  test("loadDedup returns [] on corrupt JSON (graceful degradation)", () => {
    writeFileSync(DEDUP_PATH, "{not json", "utf8");
    expect(loadDedup()).toEqual([]);
  });
});

// ── tgPost end-to-end with mocked fetch ──────────────────────────────────────

describe("tgPost", () => {
  test("posts sendMessage with chat_id + text + parse_mode=Markdown", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: { message_id: 555 } } },
    ]);
    const r = await tgPost(
      { botName: "pm", chatId: "-1001234", text: "hello world" },
      fetchImpl,
    );
    expect(r.message_id).toBe(555);
    expect(r.deduped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendMessage");
    expect(calls[0]!.method).toBe("POST");
    const body = JSON.parse(calls[0]!.body as string);
    expect(body.chat_id).toBe("-1001234");
    expect(body.text).toBe("hello world");
    expect(body.parse_mode).toBe("Markdown");
    expect(body.reply_parameters).toBeUndefined();
  });

  test("passes reply_to as reply_parameters.message_id", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: { message_id: 999 } } },
    ]);
    await tgPost(
      { botName: "pm", chatId: "-1001234", text: "thread reply", replyTo: 42 },
      fetchImpl,
    );
    const body = JSON.parse(calls[0]!.body as string);
    expect(body.reply_parameters).toEqual({ message_id: 42 });
  });

  test("dedups within TTL — second call returns same message_id, no fetch", async () => {
    const { fetchImpl: fetch1 } = mockFetch([
      { kind: "ok", json: { ok: true, result: { message_id: 777 } } },
    ]);
    const r1 = await tgPost(
      { botName: "pm", chatId: "-1001234", text: "duplicate" },
      fetch1,
    );
    expect(r1.deduped).toBe(false);

    // Second call with the same args must NOT reach the fetch impl.
    const { fetchImpl: fetch2, calls: calls2 } = mockFetch([]);
    const r2 = await tgPost(
      { botName: "pm", chatId: "-1001234", text: "duplicate" },
      fetch2,
    );
    expect(r2.deduped).toBe(true);
    expect(r2.message_id).toBe(777);
    expect(calls2).toHaveLength(0);
  });

  test("does NOT dedup after TTL expiry — manually expires the entry", async () => {
    const oldKey = dedupKey("pm", "-1001234", undefined, "expired");
    saveDedup([
      {
        key: oldKey,
        message_id: 100,
        ts: Math.floor(Date.now() / 1000) - DEDUP_TTL_SEC - 5,
      },
    ]);
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: { message_id: 200 } } },
    ]);
    const r = await tgPost(
      { botName: "pm", chatId: "-1001234", text: "expired" },
      fetchImpl,
    );
    expect(r.deduped).toBe(false);
    expect(r.message_id).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("retries on 5xx and succeeds on retry", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "text", status: 503, text: "TG outage" },
      { kind: "ok", json: { ok: true, result: { message_id: 1234 } } },
    ]);
    const r = await tgPost(
      { botName: "pm", chatId: "-100", text: "retry me" },
      fetchImpl,
    );
    expect(r.message_id).toBe(1234);
    expect(calls).toHaveLength(2);
  }, 10000);

  test("does NOT retry on 4xx (other than 429) — surfaces hard error", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "text", status: 400, text: "Bad Request: chat not found" },
    ]);
    await expect(
      tgPost(
        { botName: "pm", chatId: "-9999999", text: "no such chat" },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  test("429 with retry_after waits then retries", async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        kind: "ok",
        status: 429,
        json: { ok: false, parameters: { retry_after: 0 } },
      },
      { kind: "ok", json: { ok: true, result: { message_id: 5555 } } },
    ]);
    const r = await tgPost(
      { botName: "pm", chatId: "-100", text: "rate-limited" },
      fetchImpl,
    );
    expect(r.message_id).toBe(5555);
    expect(calls).toHaveLength(2);
  });

  test("TG_POST_ENABLED=0 short-circuits to no-op", async () => {
    process.env.TG_POST_ENABLED = "0";
    try {
      const { fetchImpl, calls } = mockFetch([]);
      const r = await tgPost(
        { botName: "pm", chatId: "-100", text: "should not send" },
        fetchImpl,
      );
      expect(r.message_id).toBe(-1);
      expect(r.deduped).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.TG_POST_ENABLED;
    }
  });

  test("chunked send: 5000-char text → two sendMessage calls, second replies to first", async () => {
    const longText = "x".repeat(5000);
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: { message_id: 100 } } },
      { kind: "ok", json: { ok: true, result: { message_id: 101 } } },
    ]);
    const r = await tgPost(
      { botName: "pm", chatId: "-100", text: longText },
      fetchImpl,
    );
    expect(r.message_id).toBe(100);
    expect(calls).toHaveLength(2);
    const body2 = JSON.parse(calls[1]!.body as string);
    expect(body2.reply_parameters).toEqual({ message_id: 100 });
  });
});

// ── callTelegram (unit) ──────────────────────────────────────────────────────

describe("callTelegram", () => {
  test("rejects malformed token before any network call", async () => {
    const { fetchImpl, calls } = mockFetch([]);
    await expect(
      callTelegram("REPLACE_WITH_TOKEN", "sendMessage", { chat_id: "1" }, fetchImpl),
    ).rejects.toThrow(/doesn't look like a BotFather token/);
    expect(calls).toHaveLength(0);
  });

  test("posts JSON body when given a plain object", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: { hi: 1 } } },
    ]);
    await callTelegram(validToken, "sendMessage", { chat_id: "1", text: "hi" }, fetchImpl);
    expect(calls[0]!.method).toBe("POST");
    expect((calls[0]!.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  test("uses FormData transport when body is FormData (file upload)", async () => {
    const { fetchImpl, calls } = mockFetch([
      { kind: "ok", json: { ok: true, result: {} } },
    ]);
    const fd = new FormData();
    fd.append("chat_id", "1");
    fd.append("photo", new Blob(["fake"]), "fake.png");
    await callTelegram(validToken, "sendPhoto", fd, fetchImpl);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
  });
});

// scripts/test-helpers.ts — shared utilities for *.bun-test.ts files
//
// Test seam helpers:
//   - mkTempDir(): per-test temp dir under os.tmpdir(), cleaned via afterEach
//   - mockFetch(): fetch impl that returns scripted responses + records calls
//   - validToken(): a token shape that matches TOKEN_RE, for fixtures
//
// Pure utilities; never imports from production code so it can't drift.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FetchCall = {
  url: string;
  method: string;
  body?: string | FormData;
  headers?: Record<string, string>;
};

export type ScriptedResponse =
  | { kind: "ok"; status?: number; json: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "throw"; error: Error };

export function mkTempDir(prefix = "mam-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Build a fetch stub that returns scripted responses in order. Records each
 * call so tests can assert URL, method, body, etc.
 *
 * If the script runs out of responses, the next call throws — this is loud
 * by design so we catch unintended fetch calls.
 */
export function mockFetch(responses: ScriptedResponse[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    const body = init?.body as string | FormData | undefined;
    calls.push({ url, method, body, headers });

    if (i >= responses.length) {
      throw new Error(
        `mockFetch ran out of scripted responses on call ${i + 1} to ${url}. Add more.`,
      );
    }
    const r = responses[i++]!;
    if (r.kind === "throw") throw r.error;
    if (r.kind === "ok") {
      return new Response(JSON.stringify(r.json), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(r.text, {
      status: r.status,
      headers: { "content-type": "text/plain" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A token that matches TOKEN_RE — 10 digits, colon, 35 base64-ish chars. */
export const validToken = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

/** Common bots.json fixture content. */
export function botsFixture(): string {
  return JSON.stringify({
    pm: { token: validToken, username: "pm_bot", user_id: "111" },
    engineer: {
      token: "9876543210:ZYXWVUTSRQPONMLKJIHGFEDCBAabcdefghi",
      username: "eng_bot",
      user_id: "222",
    },
  });
}

/** Common access.json fixture content. */
export function accessFixture(opts: {
  users?: string[];
  groups?: string[];
} = {}): string {
  return JSON.stringify({
    allowedUsers: opts.users ?? ["111"],
    allowedGroups: opts.groups ?? ["-1001234567890"],
  });
}

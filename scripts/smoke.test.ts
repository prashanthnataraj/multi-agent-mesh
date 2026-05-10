// scripts/smoke.bun-test.ts — checks that smoke.sh fails friendly (not stack-trace)
// when secrets/bots.json is missing or contains placeholder tokens.
//
// Runs scripts/smoke.sh in a temp REPO_ROOT to avoid touching the user's real
// secrets. Asserts on exit code + stderr/stdout content.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkTempDir, rmTempDir, validToken } from "./test-helpers.ts";

let tmp: string;
let repoCopy: string;

beforeEach(() => {
  tmp = mkTempDir("mam-smoke-");
  // Copy the entire scripts dir + secrets stub into a fresh "repo" so
  // smoke.sh's $REPO_ROOT/secrets/bots.json path resolves cleanly.
  repoCopy = join(tmp, "mam");
  mkdirSync(repoCopy, { recursive: true });
  mkdirSync(join(repoCopy, "scripts"), { recursive: true });
  mkdirSync(join(repoCopy, "secrets"), { recursive: true });

  // Copy production scripts into the test repo. Resolve via __dirname-ish.
  // import.meta.dir gives the dir of THIS test file, which is scripts/ in
  // the real repo.
  const realScriptsDir = import.meta.dir;
  cpSync(join(realScriptsDir, "smoke.sh"), join(repoCopy, "scripts/smoke.sh"));
  cpSync(join(realScriptsDir, "tg-post.ts"), join(repoCopy, "scripts/tg-post.ts"));
  cpSync(
    join(realScriptsDir, "tg-poller.ts"),
    join(repoCopy, "scripts/tg-poller.ts"),
  );
});

afterEach(() => {
  rmTempDir(tmp);
});

// Helper: run smoke.sh in our temp repo, return exit + stdout + stderr
function runSmoke(): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [join(repoCopy, "scripts/smoke.sh")], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, TEST_CHAT_ID: undefined as unknown as string },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("smoke.sh", () => {
  test("missing bots.json → exits 1 with friendly error (no stack trace)", () => {
    // No bots.json present
    const r = runSmoke();
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("secrets/bots.json not found");
    expect(combined).toContain("Cannot continue without bots.json");
    // No stack trace markers
    expect(combined).not.toContain("at Object.");
    expect(combined).not.toContain("UnhandledPromiseRejection");
  });

  test("placeholder tokens → fails per-bot with friendly hint", () => {
    // bots.json with all REPLACE_WITH_ placeholders
    writeFileSync(
      join(repoCopy, "secrets/bots.json"),
      JSON.stringify({
        pm: {
          token: "REPLACE_WITH_PM_BOT_TOKEN_FROM_BOTFATHER",
          username: "x",
          user_id: "1",
        },
      }),
      "utf8",
    );
    const r = runSmoke();
    // smoke continues per-bot; some bots skip ("not configured"), pm fails
    // because its token is a placeholder.
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("placeholder");
    expect(combined).not.toContain("UnhandledPromiseRejection");
  });

  test("malformed bots.json → exits 1 with 'not valid JSON' message", () => {
    // Wrapping the JSON.parse in try/catch + process.exit(1) is required because
    // `bun -e` swallows top-level throws from require()-wrapped calls and exits 0
    // on parse error (verified on bun 1.x). See smoke.sh comment for context.
    writeFileSync(join(repoCopy, "secrets/bots.json"), "{not valid json", "utf8");
    const r = runSmoke();
    const combined = r.stdout + r.stderr;
    expect(r.code).toBe(1);
    expect(combined).toContain("not valid JSON");
    expect(combined).not.toContain("UnhandledPromiseRejection");
    expect(combined).not.toContain("at Object.");
  });

  test("valid-shape tokens but unreachable getMe → fails getMe per role with hint", () => {
    // Valid token shape but Telegram won't recognize it. smoke calls real
    // api.telegram.org/getMe — this test requires network. We assert ONLY that
    // the script gets past the JSON-parse / placeholder gates and reaches the
    // network step, where Telegram returns ok:false. We don't assert exit code
    // because behavior depends on whether the test environment has internet.
    writeFileSync(
      join(repoCopy, "secrets/bots.json"),
      JSON.stringify({
        pm: { token: validToken, username: "x", user_id: "1" },
      }),
      "utf8",
    );
    const r = runSmoke();
    const combined = r.stdout + r.stderr;
    // Got past the JSON / placeholder / shape gates
    expect(combined).toContain("getMe");
    // No crash
    expect(combined).not.toContain("UnhandledPromiseRejection");
    expect(existsSync(join(repoCopy, "secrets/bots.json"))).toBe(true);
  });
});

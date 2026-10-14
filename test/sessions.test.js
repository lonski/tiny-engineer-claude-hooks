import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_TTL_MS,
  isValidSessionId,
  readSessions,
  removeSession,
  stateDir,
  withSessionLock,
  writeSession,
} from "../src/sessions.js";

const NOW = 1_800_000_000_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "te-hooks-sessions-"));
}

function state(overrides = {}) {
  return { status: "working", anim: "typing", updatedAt: NOW, oneShotUntil: 0, ...overrides };
}

test("stateDir honours TINY_ENGINEER_STATE_DIR, else ~/.cache", () => {
  const saved = process.env.TINY_ENGINEER_STATE_DIR;
  try {
    process.env.TINY_ENGINEER_STATE_DIR = "  /tmp/te-state  ";
    assert.equal(stateDir(), "/tmp/te-state");
    delete process.env.TINY_ENGINEER_STATE_DIR;
    assert.match(stateDir(), /\.cache[\\/]tiny-engineer[\\/]claude-code[\\/]sessions$/);
  } finally {
    if (saved === undefined) delete process.env.TINY_ENGINEER_STATE_DIR;
    else process.env.TINY_ENGINEER_STATE_DIR = saved;
  }
});

test("isValidSessionId accepts ids and rejects path tricks", () => {
  assert.equal(isValidSessionId("0f6c1a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"), true);
  assert.equal(isValidSessionId("abc_DEF-123"), true);
  for (const bad of ["", "../x", "a/b", "a\\b", "a.b", "x".repeat(129), 42, null, undefined]) {
    assert.equal(isValidSessionId(bad), false, String(bad));
  }
});

test("write then read round-trips sessions", () => {
  const dir = join(tempDir(), "nested", "sessions");
  writeSession(dir, "a", state({ status: "waiting", anim: "attention" }));
  writeSession(dir, "b", state({ oneShotUntil: NOW + 3000, anim: "ring" }));
  const sessions = readSessions(dir, NOW);
  assert.deepEqual(sessions.get("a"), state({ status: "waiting", anim: "attention" }));
  assert.deepEqual(sessions.get("b"), state({ oneShotUntil: NOW + 3000, anim: "ring" }));
  assert.equal(sessions.size, 2);
});

test("write leaves no temp file behind", () => {
  const dir = tempDir();
  writeSession(dir, "a", state());
  writeSession(dir, "a", state({ anim: "reading" }));
  assert.deepEqual(readdirSync(dir), ["a.json"]);
  assert.equal(readSessions(dir, NOW).get("a").anim, "reading");
});

test("missing directory reads as no sessions", () => {
  assert.equal(readSessions(join(tempDir(), "missing"), NOW).size, 0);
});

test("unreadable directory throws", () => {
  const file = join(tempDir(), "not-a-dir");
  writeFileSync(file, "x");
  assert.throws(() => readSessions(file, NOW));
});

test("expired sessions are pruned", () => {
  const dir = tempDir();
  writeSession(dir, "old", state({ updatedAt: NOW - SESSION_TTL_MS - 1 }));
  writeSession(dir, "fresh", state({ updatedAt: NOW - SESSION_TTL_MS + 1 }));
  const sessions = readSessions(dir, NOW);
  assert.deepEqual([...sessions.keys()], ["fresh"]);
  assert.equal(existsSync(join(dir, "old.json")), false);
});

test("temp and corrupt files are skipped", () => {
  const dir = tempDir();
  writeSession(dir, "good", state());
  writeFileSync(join(dir, "half.json"), '{"status":"work');
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ status: "busy", updatedAt: NOW }));
  writeFileSync(join(dir, "good.json.123.tmp"), JSON.stringify(state()));
  writeFileSync(join(dir, "bad.name.json"), JSON.stringify(state()));
  assert.deepEqual([...readSessions(dir, NOW).keys()], ["good"]);
});

test("withSessionLock runs the callback, returns its value and releases the lock", () => {
  const dir = join(tempDir(), "sessions");
  assert.equal(withSessionLock(dir, "a", () => 42), 42);
  assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => withSessionLock(dir, "a", () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(readdirSync(dir), []);
});

test("withSessionLock waits for a held lock, then gives up", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.lock"), "");
  const started = Date.now();
  assert.throws(() => withSessionLock(dir, "a", () => 1, { timeoutMs: 60, staleMs: 10_000 }), /lock/);
  assert.ok(Date.now() - started >= 50);
});

test("withSessionLock takes over a stale lock", () => {
  const dir = tempDir();
  const lock = join(dir, "a.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(withSessionLock(dir, "a", () => "ok", { timeoutMs: 60, staleMs: 1000 }), "ok");
  assert.equal(existsSync(lock), false);
});

test("removeSession deletes the file and ignores a missing one", () => {
  const dir = tempDir();
  writeSession(dir, "a", state());
  removeSession(dir, "a");
  removeSession(dir, "a");
  assert.equal(readSessions(dir, NOW).size, 0);
});

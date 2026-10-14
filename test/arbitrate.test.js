import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arbitrate } from "../src/cli.js";
import { readSessions, writeSession } from "../src/sessions.js";

function withStateDir(fn) {
  const saved = process.env.TINY_ENGINEER_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "te-hooks-arbitrate-"));
  process.env.TINY_ENGINEER_STATE_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (saved === undefined) delete process.env.TINY_ENGINEER_STATE_DIR;
    else process.env.TINY_ENGINEER_STATE_DIR = saved;
  }
}

test("a PreToolUse landing after its own PermissionRequest keeps the session waiting", () => {
  withStateDir((dir) => {
    writeSession(dir, "a", { status: "waiting", anim: "attention", updatedAt: 2000, oneShotUntil: 0 });
    const post = arbitrate({ session_id: "a", hook_event_name: "PreToolUse", tool_name: "Bash" }, "typing", 2001);
    assert.equal(post, null);
    assert.equal(readSessions(dir, 2001).get("a").status, "waiting");
  });
});

test("a newer event of the same session still goes through", () => {
  withStateDir((dir) => {
    writeSession(dir, "a", { status: "waiting", anim: "attention", updatedAt: 2000, oneShotUntil: 0 });
    const post = arbitrate({ session_id: "a", hook_event_name: "PostToolBatch" }, "thinking", 2500);
    assert.equal(post, "thinking");
    assert.equal(readSessions(dir, 2500).get("a").status, "working");
  });
});

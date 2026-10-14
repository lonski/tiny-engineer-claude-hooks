import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tiny-engineer-claude-hooks.js");

async function startRobot() {
  const posts = [];
  const server = createServer((req, res) => {
    posts.push(new URL(req.url, "http://robot").searchParams.get("name"));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { posts, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

function hook(robot, stateDirPath, event) {
  const home = mkdtempSync(join(tmpdir(), "te-hooks-home-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TINY_ENGINEER_URL: robot.url,
    TINY_ENGINEER_STATE_DIR: stateDirPath,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { cwd: home, env, stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(event));
  });
}

const A = "session-a";
const B = "session-b";

test("two sessions: waiting wins, sleep only for the last one", async () => {
  const robot = await startRobot();
  const dir = mkdtempSync(join(tmpdir(), "te-hooks-state-"));
  try {
    const steps = [
      { session_id: A, hook_event_name: "SessionStart", source: "startup" },
      { session_id: B, hook_event_name: "SessionStart", source: "startup" },
      { session_id: A, hook_event_name: "PermissionRequest" },
      { session_id: B, hook_event_name: "PreToolUse", tool_name: "Bash" },
      { session_id: A, hook_event_name: "PostToolBatch" },
      { session_id: B, hook_event_name: "PreToolUse", tool_name: "Read" },
      { session_id: A, hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
      { session_id: B, hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
    ];
    for (const event of steps) {
      const { code, stdout } = await hook(robot, dir, event);
      assert.equal(code, 0, JSON.stringify(event));
      assert.equal(stdout, "", JSON.stringify(event));
    }
    assert.deepEqual(robot.posts, ["welcome", "attention", "thinking", "reading", "sleep"]);
  } finally {
    await robot.close();
  }
});

test("event without session_id stays stateless", async () => {
  const robot = await startRobot();
  const dir = mkdtempSync(join(tmpdir(), "te-hooks-state-"));
  try {
    await hook(robot, dir, { session_id: A, hook_event_name: "PermissionRequest" });
    await hook(robot, dir, { hook_event_name: "Stop" });
    assert.deepEqual(robot.posts, ["attention", "ring"]);
  } finally {
    await robot.close();
  }
});

test("unusable state dir falls back to stateless", async () => {
  const robot = await startRobot();
  const file = join(mkdtempSync(join(tmpdir(), "te-hooks-state-")), "not-a-dir");
  writeFileSync(file, "x");
  try {
    await hook(robot, file, { session_id: A, hook_event_name: "PermissionRequest" });
    await hook(robot, file, { session_id: B, hook_event_name: "PreToolUse", tool_name: "Bash" });
    assert.deepEqual(robot.posts, ["attention", "typing"]);
  } finally {
    await robot.close();
  }
});

test("invalid session_id stays stateless", async () => {
  const robot = await startRobot();
  const dir = mkdtempSync(join(tmpdir(), "te-hooks-state-"));
  try {
    await hook(robot, dir, { session_id: A, hook_event_name: "PermissionRequest" });
    await hook(robot, dir, { session_id: "../escape", hook_event_name: "PreToolUse", tool_name: "Bash" });
    assert.deepEqual(robot.posts, ["attention", "typing"]);
  } finally {
    await robot.close();
  }
});

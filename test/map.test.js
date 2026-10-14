import test from "node:test";
import assert from "node:assert/strict";
import { animationForEvent } from "../src/map.js";
import { parseArgs } from "../src/cli.js";

test("lifecycle events map to their poses", () => {
  assert.equal(animationForEvent({ hook_event_name: "SessionEnd" }), "sleep");
  assert.equal(
    animationForEvent({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }),
    "sleep"
  );
  for (const reason of ["clear", "resume"]) {
    assert.equal(
      animationForEvent({ hook_event_name: "SessionEnd", reason }),
      null,
      reason
    );
  }
  assert.equal(
    animationForEvent({ hook_event_name: "UserPromptSubmit" }),
    "reading"
  );
  assert.equal(
    animationForEvent({ hook_event_name: "SubagentStart" }),
    "thinking"
  );
  assert.equal(
    animationForEvent({ hook_event_name: "PostToolBatch" }),
    "thinking"
  );
  assert.equal(
    animationForEvent({ hook_event_name: "PostToolUseFailure" }),
    "error"
  );
  assert.equal(animationForEvent({ hook_event_name: "PreCompact" }), "thinking");
  assert.equal(
    animationForEvent({ hook_event_name: "PermissionRequest" }),
    "attention"
  );
  assert.equal(
    animationForEvent({ hook_event_name: "PermissionDenied" }),
    "abort"
  );
  assert.equal(
    animationForEvent({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    }),
    "attention"
  );
  assert.equal(animationForEvent({ hook_event_name: "Stop" }), "ring");
  assert.equal(animationForEvent({ hook_event_name: "StopFailure" }), "error");
});

test("idle_prompt is skipped; other notifications ask for attention", () => {
  assert.equal(
    animationForEvent({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    null
  );
  for (const type of ["elicitation_dialog", "auth_success", undefined]) {
    assert.equal(
      animationForEvent({ hook_event_name: "Notification", notification_type: type }),
      "attention",
      String(type)
    );
  }
});

test("subagent events keep work poses and prompts; other poses stay the main agent's", () => {
  const sub = { agent_id: "a1b2", agent_type: "Explore" };
  for (const [event, pose] of [
    [{ hook_event_name: "PreToolUse", tool_name: "Bash" }, "typing"],
    [{ hook_event_name: "PreToolUse", tool_name: "Read" }, "reading"],
    [{ hook_event_name: "PostToolBatch" }, "thinking"],
    [{ hook_event_name: "PreCompact" }, "thinking"],
  ]) {
    assert.equal(animationForEvent({ ...event, ...sub }), pose, JSON.stringify(event));
  }
  for (const event of [
    { hook_event_name: "PostToolUseFailure" },
    { hook_event_name: "PermissionDenied" },
    { hook_event_name: "Notification", notification_type: "auth_success" },
  ]) {
    assert.equal(animationForEvent({ ...event, ...sub }), null, JSON.stringify(event));
  }
  assert.equal(animationForEvent({ hook_event_name: "PermissionRequest", ...sub }), "attention");
  assert.equal(
    animationForEvent({ hook_event_name: "Notification", notification_type: "permission_prompt", ...sub }),
    "attention"
  );
  assert.equal(animationForEvent({ hook_event_name: "SubagentStart", ...sub }), "thinking");
  // --agent sessions carry agent_type without agent_id; they are the main agent.
  assert.equal(
    animationForEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "reviewer" }),
    "typing"
  );
});

test("muted-subagents mode plays only a subagent's prompts and SubagentStart", () => {
  const sub = { agent_id: "a1b2", agent_type: "Explore" };
  const muted = (event) => animationForEvent(event, "muted-subagents");
  for (const event of [
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    { hook_event_name: "PreToolUse", tool_name: "Read" },
    { hook_event_name: "PostToolBatch" },
    { hook_event_name: "PreCompact" },
    { hook_event_name: "PostToolUseFailure" },
    { hook_event_name: "PermissionDenied" },
  ]) {
    assert.equal(muted({ ...event, ...sub }), null, JSON.stringify(event));
  }
  assert.equal(muted({ hook_event_name: "PermissionRequest", ...sub }), "attention");
  assert.equal(muted({ hook_event_name: "SubagentStart", ...sub }), "thinking");
  assert.equal(muted({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "typing");
  assert.equal(
    animationForEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", ...sub }),
    "typing",
    "working-subagents is the default"
  );
});

test("SessionStart welcomes only a fresh launch; every other start wakes up", () => {
  assert.equal(
    animationForEvent({ hook_event_name: "SessionStart", source: "startup" }),
    "welcome"
  );
  for (const source of ["resume", "clear", "compact", "fork", "other", undefined]) {
    assert.equal(
      animationForEvent({ hook_event_name: "SessionStart", source }),
      "wakeup",
      String(source)
    );
  }
});

test("PreToolUse maps reading tools to reading", () => {
  for (const tool of ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
    assert.equal(
      animationForEvent({ hook_event_name: "PreToolUse", tool_name: tool }),
      "reading",
      tool
    );
  }
});

test("PreToolUse maps typing tools to typing", () => {
  for (const tool of ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit"]) {
    assert.equal(
      animationForEvent({ hook_event_name: "PreToolUse", tool_name: tool }),
      "typing",
      tool
    );
  }
});

test("PreToolUse skips unknown or missing tools", () => {
  assert.equal(
    animationForEvent({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    null
  );
  assert.equal(
    animationForEvent({ hook_event_name: "PreToolUse", tool_name: "mcp__x__y" }),
    null
  );
  assert.equal(animationForEvent({ hook_event_name: "PreToolUse" }), null);
});

test("skips missing, unknown, or Cursor-cased hook_event_name", () => {
  assert.equal(animationForEvent(undefined), null);
  assert.equal(animationForEvent(null), null);
  assert.equal(animationForEvent({}), null);
  assert.equal(animationForEvent({ hook_event_name: "" }), null);
  assert.equal(animationForEvent({ hook_event_name: "PostToolUse" }), null);
  assert.equal(animationForEvent({ hook_event_name: "stop" }), null);
  assert.equal(animationForEvent({ hook_event_name: "constructor" }), null);
});

test("parseArgs reads --url in both forms and rejects unknown args", () => {
  assert.deepEqual(parseArgs([]), { help: false, url: undefined, mode: undefined });
  assert.equal(parseArgs(["--url", "http://10.0.0.5"]).url, "http://10.0.0.5");
  assert.equal(parseArgs(["--url=http://10.0.0.5"]).url, "http://10.0.0.5");
  assert.equal(parseArgs(["-h"]).help, true);
  assert.match(parseArgs(["--url"]).error, /requires a value/);
  assert.match(parseArgs(["ring"]).error, /Unknown argument/);
});

test("parseArgs reads --mode in both forms; an unknown mode falls back instead of failing", () => {
  assert.equal(parseArgs(["--mode", "muted-subagents"]).mode, "muted-subagents");
  assert.equal(parseArgs(["--mode=working-subagents"]).mode, "working-subagents");
  assert.match(parseArgs(["--mode"]).error, /requires a value/);
  assert.deepEqual(parseArgs(["--mode", "loud"]), { help: false, url: undefined, mode: undefined });
});

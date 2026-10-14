import test from "node:test";
import assert from "node:assert/strict";
import { LIFECYCLE_ACTIVE_MS, ONE_SHOT_MS, WAITING_TTL_MS, decide, isBlocking } from "../src/arbiter.js";
import { animationForEvent } from "../src/map.js";

const NOW = 1_800_000_000_000;

function other(overrides = {}) {
  return { status: "working", anim: "typing", updatedAt: NOW - 1000, oneShotUntil: 0, ...overrides };
}

function run(event, others = [], self = null) {
  return decide({ event, anim: animationForEvent(event), self, others, now: NOW });
}

const PERMISSION = { hook_event_name: "PermissionRequest" };
const BASH = { hook_event_name: "PreToolUse", tool_name: "Bash" };
const READ = { hook_event_name: "PreToolUse", tool_name: "Read" };
const STOP = { hook_event_name: "Stop" };

test("isBlocking: permission requests and permission/elicitation notifications only", () => {
  assert.equal(isBlocking(PERMISSION), true);
  assert.equal(isBlocking({ hook_event_name: "Notification", notification_type: "permission_prompt" }), true);
  assert.equal(isBlocking({ hook_event_name: "Notification", notification_type: "elicitation_dialog" }), true);
  assert.equal(isBlocking({ hook_event_name: "Notification", notification_type: "idle_prompt" }), false);
  assert.equal(isBlocking({ hook_event_name: "Notification" }), false);
  assert.equal(isBlocking(STOP), false);
  assert.equal(isBlocking(null), false);
});

test("single session: every event posts exactly what the map returns", () => {
  const events = [
    { hook_event_name: "SessionStart", source: "startup" },
    { hook_event_name: "SessionStart", source: "resume" },
    { hook_event_name: "SessionEnd" },
    { hook_event_name: "SessionEnd", reason: "clear" },
    { hook_event_name: "UserPromptSubmit" },
    BASH,
    READ,
    { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" },
    { hook_event_name: "SubagentStart" },
    { hook_event_name: "PostToolBatch" },
    { hook_event_name: "PostToolUseFailure" },
    { hook_event_name: "PreCompact" },
    PERMISSION,
    { hook_event_name: "PermissionDenied" },
    { hook_event_name: "Notification", notification_type: "idle_prompt" },
    STOP,
    { hook_event_name: "StopFailure" },
  ];
  // Own previous state must never filter its own events (a waiting self is covered below).
  const self = { status: "working", anim: "ring", updatedAt: NOW - 10, oneShotUntil: NOW + 5000 };
  for (const event of events) {
    assert.equal(run(event, [], self).post, animationForEvent(event), JSON.stringify(event));
  }
});

test("SessionStart stays quiet while another session is live", () => {
  const result = run({ hook_event_name: "SessionStart", source: "startup" }, [other()]);
  assert.equal(result.post, null);
  assert.equal(result.nextSelf.status, "working");
});

test("SessionEnd sleeps only for the last session and always drops own state", () => {
  assert.deepEqual(run({ hook_event_name: "SessionEnd" }, [other()]), { post: null, nextSelf: null });
  assert.deepEqual(run({ hook_event_name: "SessionEnd" }, []), { post: "sleep", nextSelf: null });
  assert.deepEqual(run({ hook_event_name: "SessionEnd", reason: "clear" }, []), { post: null, nextSelf: null });
});

test("a dormant session does not hold back welcome or sleep", () => {
  const start = { hook_event_name: "SessionStart", source: "startup" };
  const end = { hook_event_name: "SessionEnd" };
  const dormant = other({ updatedAt: NOW - LIFECYCLE_ACTIVE_MS - 1 });
  assert.equal(run(start, [dormant]).post, "welcome");
  assert.equal(run(end, [dormant]).post, "sleep");
  const recent = other({ updatedAt: NOW - LIFECYCLE_ACTIVE_MS + 1 });
  assert.equal(run(start, [recent]).post, null);
  assert.equal(run(end, [recent]).post, null);
});

test("a dormant session that is still waiting keeps welcome and sleep quiet", () => {
  const waiting = other({ status: "waiting", updatedAt: NOW - LIFECYCLE_ACTIVE_MS - 1 });
  assert.equal(run({ hook_event_name: "SessionStart", source: "startup" }, [waiting]).post, null);
  assert.equal(run({ hook_event_name: "SessionEnd" }, [waiting]).post, null);
});

test("another waiting session blocks work and one-shots", () => {
  const waiting = other({ status: "waiting", anim: "attention" });
  assert.equal(run(BASH, [waiting]).post, null);
  assert.equal(run(READ, [waiting]).post, null);
  assert.equal(run(STOP, [waiting]).post, null);
  assert.equal(run({ hook_event_name: "Notification", notification_type: "idle_prompt" }, [waiting]).post, null);
});

test("a session entering waiting always posts attention", () => {
  const waiting = other({ status: "waiting", anim: "attention" });
  const result = run(PERMISSION, [waiting]);
  assert.equal(result.post, "attention");
  assert.equal(result.nextSelf.status, "waiting");
});

test("a waiting session stays waiting through PreToolUse and reminders", () => {
  const self = { status: "waiting", anim: "attention", updatedAt: NOW - 5000, oneShotUntil: 0 };
  const tool = run(BASH, [], self);
  assert.equal(tool.post, null);
  assert.equal(tool.nextSelf.status, "waiting");
  const reminder = run({ hook_event_name: "Notification", notification_type: "idle_prompt" }, [], self);
  assert.equal(reminder.post, "attention");
  assert.equal(reminder.nextSelf.status, "waiting");
  const stale = { ...self, updatedAt: NOW - WAITING_TTL_MS - 1 };
  assert.equal(run(BASH, [], stale).nextSelf.status, "working");
});

test("answering clears waiting", () => {
  const self = { status: "waiting", anim: "attention", updatedAt: NOW - 5000, oneShotUntil: 0 };
  const result = run({ hook_event_name: "PostToolBatch" }, [], self);
  assert.equal(result.post, "thinking");
  assert.equal(result.nextSelf.status, "working");
});

test("a stale waiting session no longer blocks", () => {
  const stale = other({ status: "waiting", updatedAt: NOW - WAITING_TTL_MS - 1 });
  assert.equal(run(BASH, [stale]).post, "typing");
  const fresh = other({ status: "waiting", updatedAt: NOW - WAITING_TTL_MS + 1 });
  assert.equal(run(BASH, [fresh]).post, null);
});

test("another session's running one-shot blocks work poses only", () => {
  const ringing = other({ anim: "ring", oneShotUntil: NOW + 1000 });
  assert.equal(run(BASH, [ringing]).post, null);
  assert.equal(run(READ, [ringing]).post, null);
  assert.equal(run({ hook_event_name: "PostToolBatch" }, [ringing]).post, null);
  assert.equal(run(STOP, [ringing]).post, "ring");
  assert.equal(run(PERMISSION, [ringing]).post, "attention");
  const finished = other({ anim: "ring", oneShotUntil: NOW });
  assert.equal(run(BASH, [finished]).post, "typing");
});

test("posting a one-shot records its protection window", () => {
  assert.equal(run(STOP).nextSelf.oneShotUntil, NOW + ONE_SHOT_MS.get("ring"));
  assert.equal(run({ hook_event_name: "StopFailure" }).nextSelf.oneShotUntil, NOW + ONE_SHOT_MS.get("error"));
  assert.equal(run(BASH).nextSelf.oneShotUntil, 0);
});

test("a skipped post keeps the previous protection window", () => {
  const self = { status: "working", anim: "ring", updatedAt: NOW - 500, oneShotUntil: NOW + 2500 };
  const waiting = other({ status: "waiting" });
  assert.equal(run(STOP, [waiting], self).nextSelf.oneShotUntil, NOW + 2500);
  const unmapped = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" };
  assert.equal(run(unmapped, [], self).nextSelf.oneShotUntil, NOW + 2500);
});

test("next state records the requested animation and time", () => {
  assert.deepEqual(run(READ).nextSelf, { status: "working", anim: "reading", updatedAt: NOW, oneShotUntil: 0 });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TTL_MS,
  LIFECYCLE_ACTIVE_MS,
  ONE_SHOT_MS,
  WAITING_TTL_MS,
  decide,
  isBlocking,
} from "../src/arbiter.js";
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
  // Own previous state never filters its own events, except a waiting self and
  // its own one-shot still playing (both covered below).
  const self = { status: "working", anim: "ring", updatedAt: NOW - 10, oneShotUntil: NOW - 1 };
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

test("idle_prompt after a finished turn posts nothing", () => {
  const self = { status: "working", anim: "ring", updatedAt: NOW - 60_000, oneShotUntil: 0 };
  const idle = run({ hook_event_name: "Notification", notification_type: "idle_prompt" }, [], self);
  assert.equal(idle.post, null);
  assert.equal(idle.nextSelf.status, "working");
});

const BG = "agent-bg";
const MAIN = "";

/** A session waiting on these owners; agents lists the running subagents. */
function waitingOn(owners, agents = {}) {
  return { status: "waiting", anim: "attention", updatedAt: NOW - 5000, oneShotUntil: 0, agents, waitingFor: owners };
}

function running(...ids) {
  return Object.fromEntries(ids.map((id) => [id, NOW - 5000]));
}

test("a subagent's answered prompt clears waiting and its work poses post", () => {
  const answered = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], waitingOn([BG], running(BG)));
  assert.equal(answered.post, "thinking");
  assert.equal(answered.nextSelf.status, "working");
  assert.deepEqual(answered.nextSelf.waitingFor, []);
  const asking = run({ hook_event_name: "PermissionRequest", agent_id: BG }, [], answered.nextSelf);
  assert.equal(asking.post, "attention");
  assert.equal(asking.nextSelf.status, "waiting");
  assert.deepEqual(asking.nextSelf.waitingFor, [BG]);
});

test("a background subagent's work does not answer the main agent's prompt", () => {
  const asked = run(PERMISSION).nextSelf;
  assert.deepEqual(asked.waitingFor, [MAIN]);
  const background = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], asked);
  assert.equal(background.post, null);
  assert.equal(background.nextSelf.status, "waiting");
  assert.deepEqual(background.nextSelf.waitingFor, [MAIN]);
  const answered = run({ hook_event_name: "PostToolBatch" }, [], background.nextSelf);
  assert.equal(answered.post, "thinking");
  assert.equal(answered.nextSelf.status, "working");
});

test("the main agent's work does not answer a subagent's prompt; that subagent stopping does", () => {
  const main = run({ hook_event_name: "PostToolBatch" }, [], waitingOn([BG], running(BG)));
  assert.equal(main.post, null);
  assert.equal(main.nextSelf.status, "waiting");
  assert.deepEqual(main.nextSelf.waitingFor, [BG]);
  const stopped = run({ hook_event_name: "SubagentStop", agent_id: BG }, [], main.nextSelf);
  assert.equal(stopped.nextSelf.status, "working");
  assert.deepEqual(stopped.nextSelf.waitingFor, []);
});

test("another subagent does not answer a subagent's prompt", () => {
  const other = run({ hook_event_name: "PostToolBatch", agent_id: "other" }, [], waitingOn([BG], running(BG, "other")));
  assert.equal(other.post, null);
  assert.equal(other.nextSelf.status, "waiting");
  assert.deepEqual(other.nextSelf.waitingFor, [BG]);
});

test("the asking subagent's PreToolUse keeps its prompt open; any reminder re-asks", () => {
  const self = waitingOn([BG], running(BG));
  const tool = run({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: BG }, [], self);
  assert.equal(tool.post, null);
  assert.deepEqual(tool.nextSelf.waitingFor, [BG]);
  for (const agent_id of [BG, undefined]) {
    const reminder = run({ hook_event_name: "Notification", notification_type: "idle_prompt", agent_id }, [], self);
    assert.equal(reminder.post, "attention", String(agent_id));
    assert.deepEqual(reminder.nextSelf.waitingFor, [BG], String(agent_id));
  }
});

test("two open prompts: answering one keeps attention for the other", () => {
  const both = run(PERMISSION, [], waitingOn([BG], running(BG))).nextSelf;
  assert.deepEqual([...both.waitingFor].sort(), [MAIN, BG].sort());
  const mainAnswered = run({ hook_event_name: "PostToolBatch" }, [], both);
  assert.equal(mainAnswered.post, null);
  assert.deepEqual(mainAnswered.nextSelf.waitingFor, [BG]);
  const bgAnswered = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], mainAnswered.nextSelf);
  assert.equal(bgAnswered.post, "thinking");
  assert.equal(bgAnswered.nextSelf.status, "working");
});

test("a permission-prompt notification while waiting re-asks without taking the prompt over", () => {
  const note = run({ hook_event_name: "Notification", notification_type: "permission_prompt" }, [], waitingOn([BG], running(BG)));
  assert.equal(note.post, "attention");
  assert.deepEqual(note.nextSelf.waitingFor, [BG]);
});

test("a permission-prompt notification before its PermissionRequest is a placeholder the request takes over", () => {
  const note = run({ hook_event_name: "Notification", notification_type: "permission_prompt" }).nextSelf;
  assert.deepEqual(note.waitingFor, ["*"]);
  const asked = run({ hook_event_name: "PermissionRequest", agent_id: BG }, [], note).nextSelf;
  assert.deepEqual(asked.waitingFor, [BG]);
  const main = run({ hook_event_name: "PostToolBatch" }, [], asked);
  assert.equal(main.post, null, "the main agent does not answer the subagent's prompt");
  const answered = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], main.nextSelf);
  assert.equal(answered.post, "thinking");
  assert.equal(answered.nextSelf.status, "working");
});

test("a placeholder prompt closes on any agent's answer", () => {
  const next = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], waitingOn(["*"], running(BG)));
  assert.equal(next.post, "thinking");
  assert.deepEqual(next.nextSelf.waitingFor, []);
});

test("an elicitation dialog while another prompt is open is a prompt of its own", () => {
  const elicit = run(
    { hook_event_name: "Notification", notification_type: "elicitation_dialog" },
    [],
    waitingOn([BG], running(BG))
  );
  assert.equal(elicit.post, "attention");
  assert.deepEqual([...elicit.nextSelf.waitingFor].sort(), [MAIN, BG].sort());
  const bgAnswered = run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], elicit.nextSelf);
  assert.equal(bgAnswered.post, null);
  assert.deepEqual(bgAnswered.nextSelf.waitingFor, [MAIN]);
});

test("the user's next prompt clears every open prompt", () => {
  const typed = run({ hook_event_name: "UserPromptSubmit" }, [], waitingOn([BG, MAIN], running(BG)));
  assert.equal(typed.post, "reading");
  assert.equal(typed.nextSelf.status, "working");
  assert.deepEqual(typed.nextSelf.waitingFor, []);
});

test("a subagent's prompt stays open while it is silent past AGENT_TTL_MS", () => {
  const self = { ...waitingOn([BG], { [BG]: NOW - AGENT_TTL_MS - 1 }), waitingSince: NOW - AGENT_TTL_MS - 1 };
  const reminder = run({ hook_event_name: "Notification", notification_type: "idle_prompt" }, [], self);
  assert.equal(reminder.post, "attention");
  assert.deepEqual(reminder.nextSelf.waitingFor, [BG]);
  const main = run({ hook_event_name: "PostToolBatch" }, [], self);
  assert.equal(main.post, null);
  assert.deepEqual(main.nextSelf.waitingFor, [BG]);
});

test("an untracked subagent that asks is registered; its racing PreToolUse keeps attention", () => {
  const asked = run({ hook_event_name: "PermissionRequest", agent_id: BG }).nextSelf;
  assert.deepEqual(asked.waitingFor, [BG]);
  assert.equal(asked.agents[BG], NOW);
  const tool = run({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: BG }, [], asked);
  assert.equal(tool.post, null);
  assert.deepEqual(tool.nextSelf.waitingFor, [BG]);
});

test("the 30 min backstop counts from when the prompt opened, not from the latest event", () => {
  const old = { ...waitingOn([BG], running(BG)), updatedAt: NOW - 1000, waitingSince: NOW - WAITING_TTL_MS - 1 };
  const next = run({ hook_event_name: "PostToolBatch" }, [], old);
  assert.equal(next.post, "thinking");
  assert.equal(next.nextSelf.status, "working");
  assert.equal(run(READ, [old]).post, "reading", "another session stops deferring to it too");
  const kept = run({ hook_event_name: "PostToolBatch" }, [], { ...old, waitingSince: NOW - 60_000 });
  assert.equal(kept.nextSelf.waitingSince, NOW - 60_000, "other agents' events do not move it");
  assert.equal(run(PERMISSION).nextSelf.waitingSince, NOW);
  assert.equal(run(READ).nextSelf.waitingSince, 0);
});

test("SubagentStart answers like the main agent; an id-less SubagentStop never answers", () => {
  const started = run({ hook_event_name: "SubagentStart", agent_id: "new" }, [], waitingOn([MAIN]));
  assert.equal(started.post, "thinking");
  assert.equal(started.nextSelf.status, "working");
  const stopped = run({ hook_event_name: "SubagentStop" }, [], waitingOn([MAIN]));
  assert.equal(stopped.post, null);
  assert.deepEqual(stopped.nextSelf.waitingFor, [MAIN]);
});


test("Stop does not ring while a background subagent is running", () => {
  const started = run({ hook_event_name: "SubagentStart", agent_id: BG }, [], null);
  assert.equal(started.post, "thinking");
  const turnEnd = run(STOP, [], started.nextSelf);
  assert.equal(turnEnd.post, null);
  const done = run({ hook_event_name: "SubagentStop", agent_id: BG }, [], turnEnd.nextSelf);
  assert.equal(done.post, null);
  assert.deepEqual(done.nextSelf.agents, {});
  assert.equal(run(STOP, [], done.nextSelf).post, "ring");
});

test("a subagent silent past AGENT_TTL_MS no longer holds the ring", () => {
  const self = { status: "working", anim: null, updatedAt: NOW - 1000, oneShotUntil: 0 };
  assert.equal(run(STOP, [], { ...self, agents: { [BG]: NOW - AGENT_TTL_MS + 1000 } }).post, null);
  const stale = run(STOP, [], { ...self, agents: { [BG]: NOW - AGENT_TTL_MS - 1 } });
  assert.equal(stale.post, "ring");
  assert.deepEqual(stale.nextSelf.agents, {});
});

test("a running subagent's own events keep it alive; unknown agents are not added", () => {
  const self = { status: "working", anim: null, updatedAt: NOW - 1000, oneShotUntil: 0, agents: { [BG]: NOW - 60_000 } };
  assert.deepEqual(run({ hook_event_name: "PostToolBatch", agent_id: BG }, [], self).nextSelf.agents, { [BG]: NOW });
  const stranger = run({ hook_event_name: "PostToolBatch", agent_id: "other" }, [], { ...self, agents: {} });
  assert.deepEqual(stranger.nextSelf.agents, {});
});

test("a subagent finishing does not answer a waiting prompt", () => {
  const self = { status: "waiting", anim: "attention", updatedAt: NOW - 5000, oneShotUntil: 0, agents: { [BG]: NOW - 5000 } };
  const done = run({ hook_event_name: "SubagentStop", agent_id: BG }, [], self);
  assert.equal(done.post, null);
  assert.equal(done.nextSelf.status, "waiting");
});

test("a session's own work poses do not cut its one-shot short", () => {
  const failed = run({ hook_event_name: "PostToolUseFailure" }, [], {
    status: "working",
    anim: "typing",
    updatedAt: NOW - 1000,
    oneShotUntil: 0,
    agents: running(BG),
  }).nextSelf;
  assert.equal(failed.oneShotUntil, NOW + ONE_SHOT_MS.get("error"));
  for (const event of [{ hook_event_name: "PostToolBatch" }, READ, { ...READ, agent_id: BG }]) {
    const held = run(event, [], failed);
    assert.equal(held.post, null, JSON.stringify(event));
    assert.equal(held.nextSelf.oneShotUntil, failed.oneShotUntil, "a held pose keeps the window");
  }
  assert.equal(run(PERMISSION, [], failed).post, "attention");
  assert.equal(run(STOP, [], { ...failed, agents: {} }).post, "ring");
  assert.equal(run(READ, [], { ...failed, oneShotUntil: NOW - 1 }).post, "reading");
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
  assert.deepEqual(run(READ).nextSelf, {
    status: "working",
    anim: "reading",
    updatedAt: NOW,
    oneShotUntil: 0,
    agents: {},
    waitingFor: [],
    waitingSince: 0,
  });
});

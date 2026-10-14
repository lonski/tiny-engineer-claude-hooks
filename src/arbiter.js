import { isValidAgentId } from "./sessions.js";

/** A waiting session older than this stops blocking others. */
export const WAITING_TTL_MS = 30 * 60 * 1000;

/**
 * A session silent this long no longer holds back another session's welcome or
 * sleep, so one that ended without SessionEnd (crash, closed terminal) does not
 * mute them for the whole session TTL.
 */
export const LIFECYCLE_ACTIVE_MS = 10 * 60 * 1000;

/**
 * A running subagent with no event for this long counts as finished, so a lost
 * SubagentStop cannot mute the ring for good.
 */
export const AGENT_TTL_MS = 10 * 60 * 1000;

export const WORK_ANIMS = new Set(["typing", "reading", "thinking"]);

// Approximate gesture lengths. Other sessions' work poses wait this long so the
// gesture is not cut short.
export const ONE_SHOT_MS = new Map([
  ["ring", 3000],
  ["welcome", 4000],
  ["abort", 4000],
  ["error", 4000],
]);

const BLOCKING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

// Events that never answer a prompt: a PreToolUse racing (or running in parallel
// with) its own permission prompt, reminder notifications, and SubagentStop (the
// asking subagent's stop ends its prompt by leaving `agents`).
const KEEPS_WAITING = new Set(["PreToolUse", "Notification", "SubagentStop"]);

/** waitingFor entry for the main agent. */
const MAIN = "";

/**
 * agents: background subagents still running, agent_id → last event (epoch ms).
 * waitingFor: owners of the open prompts, agent_id or "" for the main agent.
 * @typedef {{ status: "waiting" | "working", anim: string | null, updatedAt: number, oneShotUntil: number, agents: Record<string, number>, waitingFor: string[] }} SessionState
 */

/**
 * True when the event means the session is asking the user for something.
 * @param {{ hook_event_name?: string, notification_type?: string } | null | undefined} event
 */
export function isBlocking(event) {
  const name = event?.hook_event_name;
  if (name === "PermissionRequest") return true;
  return name === "Notification" && BLOCKING_NOTIFICATIONS.has(event.notification_type);
}

/**
 * @param {SessionState} session
 * @param {number} now
 */
function isFreshWaiting(session, now) {
  return session.status === "waiting" && now - session.updatedAt < WAITING_TTL_MS;
}

/**
 * True when another session should keep welcome / wakeup / sleep quiet.
 * @param {SessionState[]} others
 * @param {number} now
 */
function holdsLifecycle(others, now) {
  return others.some((o) => now - o.updatedAt < LIFECYCLE_ACTIVE_MS || isFreshWaiting(o, now));
}

/**
 * @param {string | undefined} name
 * @param {string | null} anim
 * @param {boolean} waiting
 * @param {SessionState[]} others
 * @param {number} now
 * @returns {string | null}
 */
function choosePost(name, anim, waiting, others, now) {
  if (!anim) return null;
  if (name === "SessionStart" && holdsLifecycle(others, now)) return null;
  if (waiting) return anim;

  const otherWaiting = others.some((o) => isFreshWaiting(o, now));
  if (otherWaiting) return null;

  const otherOneShot = others.some((o) => o.oneShotUntil > now);
  if (WORK_ANIMS.has(anim) && otherOneShot) return null;

  return anim;
}

/**
 * The subagent an event came from, or null for the main agent.
 * @param {{ agent_id?: unknown } | null | undefined} event
 * @returns {string | null}
 */
export function agentOf(event) {
  const id = event?.agent_id;
  return isValidAgentId(id) ? id : null;
}

/**
 * Subagents of this session still running after the event: SubagentStart adds
 * one, SubagentStop removes it, its other events refresh it.
 * @param {{ hook_event_name?: string, agent_id?: unknown } | null | undefined} event
 * @param {SessionState | null} self
 * @param {number} now
 * @returns {Map<string, number>} agent_id → last event
 */
function runningAgents(event, self, now) {
  const agents = new Map(
    Object.entries(self?.agents ?? {}).filter(([, seenAt]) => now - seenAt < AGENT_TTL_MS)
  );
  const id = agentOf(event);
  if (!id) return agents;
  const name = event.hook_event_name;
  if (name === "SubagentStart") agents.set(id, now);
  else if (name === "SubagentStop") agents.delete(id);
  else if (agents.has(id)) agents.set(id, now);
  return agents;
}

/**
 * Owners of the prompts still open after the event. A prompt belongs to the
 * agent that asked, and only that agent's own answer closes it.
 * @param {{ hook_event_name?: string, agent_id?: unknown } | null | undefined} event
 * @param {boolean} blocking
 * @param {SessionState | null} self
 * @param {Map<string, number>} agents running subagents after the event
 * @param {number} now
 * @returns {Set<string>}
 */
function openPrompts(event, blocking, self, agents, now) {
  const name = event?.hook_event_name;
  // SubagentStart carries the new subagent's id but is the main agent delegating.
  const actor = name === "SubagentStart" ? MAIN : (agentOf(event) ?? MAIN);
  const open = new Set();
  if (self && isFreshWaiting(self, now)) {
    for (const owner of self.waitingFor?.length ? self.waitingFor : [MAIN]) open.add(owner);
  }
  // A subagent that stopped or went silent can no longer be answered.
  for (const owner of open) if (owner !== MAIN && !agents.has(owner)) open.delete(owner);
  // The user typing again means every prompt was answered or abandoned (Esc).
  if (name === "UserPromptSubmit" && actor === MAIN) open.clear();

  if (blocking) {
    // A permission-prompt notification while waiting re-announces an open prompt.
    if (name !== "Notification" || open.size === 0) open.add(actor);
  } else if (!KEEPS_WAITING.has(name)) {
    open.delete(actor);
  }
  return open;
}

/**
 * Decide what this session may post, given the other live sessions.
 * @param {{
 *   event: object,
 *   anim: string | null,
 *   self?: SessionState | null,
 *   others?: SessionState[],
 *   now: number,
 * }} input
 * @returns {{ post: string | null, nextSelf: SessionState | null }} nextSelf null → delete own state
 */
export function decide({ event, anim, self = null, others = [], now }) {
  const name = event?.hook_event_name;

  if (name === "SessionEnd") {
    return { post: holdsLifecycle(others, now) ? null : anim, nextSelf: null };
  }

  const agents = runningAgents(event, self, now);
  // Running subagents will report back and start another turn; ring after the
  // turn that follows the last one.
  const pose = name === "Stop" && agents.size > 0 ? null : anim;

  const blocking = isBlocking(event);
  const open = openPrompts(event, blocking, self, agents, now);
  const waiting = open.size > 0;
  // While a prompt stays open the session only ever re-asks for attention, and
  // any notification (idle_prompt too) re-asks.
  const post =
    waiting && !blocking
      ? name === "Notification" ? "attention" : null
      : choosePost(name, pose, waiting, others, now);

  let oneShotUntil = self?.oneShotUntil ?? 0;
  if (post) oneShotUntil = ONE_SHOT_MS.has(post) ? now + ONE_SHOT_MS.get(post) : 0;

  return {
    post,
    nextSelf: {
      status: waiting ? "waiting" : "working",
      anim: pose,
      updatedAt: now,
      oneShotUntil,
      agents: Object.fromEntries(agents),
      waitingFor: [...open],
    },
  };
}

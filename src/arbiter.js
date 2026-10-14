/** A waiting session older than this stops blocking others. */
export const WAITING_TTL_MS = 30 * 60 * 1000;

/**
 * A session silent this long no longer holds back another session's welcome or
 * sleep, so one that ended without SessionEnd (crash, closed terminal) does not
 * mute them for the whole session TTL.
 */
export const LIFECYCLE_ACTIVE_MS = 10 * 60 * 1000;

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

// Events that do not mean the user answered: a PreToolUse racing (or running in
// parallel with) the permission prompt, and reminder notifications.
const KEEPS_WAITING = new Set(["PreToolUse", "Notification"]);

/**
 * @typedef {{ status: "waiting" | "working", anim: string | null, updatedAt: number, oneShotUntil: number }} SessionState
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

  const blocking = isBlocking(event);
  const keptWaiting =
    !blocking && KEEPS_WAITING.has(name) && self !== null && isFreshWaiting(self, now);
  const waiting = blocking || keptWaiting;
  // A session still waiting on the user only ever re-asks for attention.
  const post = keptWaiting
    ? anim === "attention" ? anim : null
    : choosePost(name, anim, waiting, others, now);

  let oneShotUntil = self?.oneShotUntil ?? 0;
  if (post) oneShotUntil = ONE_SHOT_MS.has(post) ? now + ONE_SHOT_MS.get(post) : 0;

  return {
    post,
    nextSelf: { status: waiting ? "waiting" : "working", anim, updatedAt: now, oneShotUntil },
  };
}

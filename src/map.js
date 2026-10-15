import { WORK_ANIMS, agentOf, isBlocking } from "./arbiter.js";
import { DEFAULT_MODE, MUTED_SUBAGENTS } from "./env.js";

export const READING_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
]);

export const TYPING_TOOLS = new Set([
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "NotebookEdit",
]);

const EVENT_ANIM = new Map([
  ["UserPromptSubmit", "reading"],
  ["SubagentStart", "thinking"],
  ["PostToolBatch", "thinking"],
  ["PreCompact", "thinking"],
  ["PermissionRequest", "attention"],
  ["PermissionDenied", "abort"],
  ["Notification", "attention"],
  ["Stop", "ring"],
  ["StopFailure", "error"],
]);

/**
 * Map a Claude Code hook payload to an animation name, or null to skip.
 * @param {{ hook_event_name?: string, tool_name?: string, source?: string, reason?: string, notification_type?: string, agent_id?: string }} event
 * @param {string} [mode] one of MODES
 * @returns {string | null}
 */
export function animationForEvent(event, mode = DEFAULT_MODE) {
  const anim = poseForEvent(event);
  if (!agentOf(event) || !anim || isBlocking(event)) return anim;
  // Hooks fire inside subagents too, marked by agent_id. A prompt the user has
  // to answer always shows, a subagent's error or abort never does.
  // muted-subagents keeps only SubagentStart: the main agent delegating.
  if (mode === MUTED_SUBAGENTS) return event.hook_event_name === "SubagentStart" ? anim : null;
  return WORK_ANIMS.has(anim) ? anim : null;
}

/**
 * @param {{ hook_event_name?: string, tool_name?: string, source?: string, reason?: string, notification_type?: string }} event
 * @returns {string | null}
 */
function poseForEvent(event) {
  const name = event?.hook_event_name;
  if (!name) return null;

  if (name === "PreToolUse") {
    const tool = event.tool_name;
    if (READING_TOOLS.has(tool)) return "reading";
    if (TYPING_TOOLS.has(tool)) return "typing";
    return null;
  }

  // Only a fresh launch welcomes; resume, /clear, compaction, fork, or an
  // unknown source wakes up, so one session never plays welcome twice.
  if (name === "SessionStart") {
    return event.source === "startup" ? "welcome" : "wakeup";
  }

  // /clear and /resume end one session and start the next at once. The
  // SessionStart that follows owns the pose; a sleep posted alongside it makes
  // the robot drop the wakeup, so skip it.
  if (name === "SessionEnd") {
    return event.reason === "clear" || event.reason === "resume" ? null : "sleep";
  }

  // Claude Code sends idle_prompt about a minute after a finished turn, which
  // would replay attention right after the ring. The arbiter still uses it to
  // re-ask for a prompt that is waiting on the user.
  if (name === "Notification" && event.notification_type === "idle_prompt") {
    return null;
  }

  return EVENT_ANIM.get(name) ?? null;
}

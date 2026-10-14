import { decide } from "./arbiter.js";
import { DEFAULT_MODE, DEFAULT_URL, MODES, getBaseUrl, getMode, getToken, loadDotEnv, parseMode } from "./env.js";
import { animationForEvent } from "./map.js";
import { postAnim } from "./post.js";
import {
  isValidSessionId,
  readSessions,
  removeSession,
  stateDir,
  withSessionLock,
  writeSession,
} from "./sessions.js";

function printHelp() {
  console.log(`Usage: tiny-engineer-claude-hooks [options]

Claude Code hook helper: read event JSON from stdin, pick an animation, POST to the robot.
Install it into Claude Code with: node install.js

Options:
  --url <base>   Robot base URL (default: TINY_ENGINEER_URL, else ${DEFAULT_URL})
  --mode <mode>  ${MODES.join(" | ")} (default: TINY_ENGINEER_MODE,
                 else ${DEFAULT_MODE})
  -h, --help     Show this help

Auth:
  If TINY_ENGINEER_TOKEN is set (process env or project-root .env), requests
  send Authorization: Bearer <token>. Must match the device access_token.
  No token → no Authorization header (device auth disabled).
  A token from the process env is never sent to a TINY_ENGINEER_URL taken from
  the project .env; set the URL in the env or with --url instead.

Hook mode:
  Claude Code pipes JSON with hook_event_name (plus tool_name for PreToolUse and
  source for SessionStart). The CLI maps the event to a pose and POSTs
  \${url}/anim?name=…. Unknown or unmatched events exit 0 with no request.
  Nothing is written to stdout, because Claude Code adds SessionStart /
  UserPromptSubmit stdout to the model's context.

Event map:
  SessionStart (source startup)                    → welcome
  SessionStart (any other or missing source)       → wakeup
  SessionEnd (reason clear/resume)                 → (skip)
  SessionEnd (any other reason)                    → sleep
  UserPromptSubmit                                 → reading
  PreToolUse + Read/Grep/Glob/WebFetch/WebSearch   → reading
  PreToolUse + Bash/PowerShell/Edit/Write/NotebookEdit → typing
  other PreToolUse tools                           → (skip)
  SubagentStart                                    → thinking
  PostToolBatch                                    → thinking
  PostToolUseFailure                               → error
  PreCompact                                       → thinking
  PermissionRequest                                → attention
  PermissionDenied                                 → abort
  Notification (idle_prompt)                       → (skip)
  Notification (any other type)                    → attention
  SubagentStop                                     → (skip; marks the subagent finished)
  Stop                                             → ring, unless background subagents still run
  StopFailure                                      → error

Subagents:
  Events carrying agent_id come from a subagent. Its permission prompts
  (attention) post; its error and abort do not. working-subagents also posts
  its reading/typing/thinking; muted-subagents only its SubagentStart (thinking).
  A Stop while background subagents still run posts nothing; the turn after
  the last one reports back rings. A subagent silent for 10 min counts as done.

Multiple sessions:
  Hooks from concurrent sessions on this computer share state in
  TINY_ENGINEER_STATE_DIR (default ~/.cache/tiny-engineer/claude-code/sessions).
  A session asking for permission keeps attention until it is answered, and
  only the agent that asked (main agent or that subagent) can answer it, or
  the user's next prompt;
  ring/welcome/abort/error are not cut short by any work pose, own or another's;
  welcome/wakeup play only for the first session and sleep only for the last.
  Events without session_id, or any state error, behave as a single session.

Examples:
  echo '{"hook_event_name":"Stop"}' | tiny-engineer-claude-hooks
  echo '{"hook_event_name":"PreToolUse","tool_name":"Read"}' | tiny-engineer-claude-hooks --url http://192.168.1.10
`);
}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, url?: string, mode?: string, error?: string }}
 */
export function parseArgs(argv) {
  let url;
  let mode;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--url") {
      const next = argv[++i];
      if (!next) return { help: false, error: "--url requires a value" };
      url = next;
      continue;
    }
    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      if (!url) return { help: false, error: "--url requires a value" };
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const value = arg === "--mode" ? argv[++i] : arg.slice("--mode=".length);
      if (!value) return { help: false, error: "--mode requires a value" };
      // An unknown mode (hand-edited settings, a renamed mode) must not silence
      // every hook, so it falls back like TINY_ENGINEER_MODE does.
      mode = parseMode(value) ?? undefined;
      continue;
    }
    return { help: false, error: `Unknown argument: ${arg}` };
  }

  return { help, url, mode };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", () => resolve(""));
  });
}

// /clear and /resume fire the old session's SessionEnd and the new session's
// SessionStart together. Waiting this long lets the old hook remove its state
// first, so the new session is not muted by its own predecessor.
const RESTART_SETTLE_MS = 300;

/**
 * Filter an animation against the other live sessions and record this session's
 * state. Without a usable session_id or state dir, return anim unchanged.
 * @param {object | null} event
 * @param {string | null} anim
 * @param {number} [now]
 * @returns {string | null}
 */
export function arbitrate(event, anim, now = Date.now()) {
  const id = event?.session_id;
  if (!isValidSessionId(id)) return anim;

  try {
    const dir = stateDir();
    // Hooks of one session run concurrently (a PermissionRequest races its own
    // PreToolUse), so read → decide → write happens under the session's lock.
    return withSessionLock(dir, id, () => {
      const sessions = readSessions(dir, now);
      const self = sessions.get(id) ?? null;
      sessions.delete(id);
      const decision = decide({ event, anim, self, others: [...sessions.values()], now });
      try {
        if (decision.nextSelf) writeSession(dir, id, decision.nextSelf);
        else removeSession(dir, id);
      } catch {
        // State is best effort; the decision still stands.
      }
      return decision.post;
    });
  } catch {
    return anim;
  }
}

/**
 * @param {string[]} argv
 */
export async function run(argv) {
  loadDotEnv();

  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const raw = await readStdin();
  let event = null;
  if (raw.trim()) {
    try {
      event = JSON.parse(raw);
    } catch {
      process.exitCode = 0;
      return;
    }
  }

  if (event?.hook_event_name === "SessionStart" && event.source !== "startup") {
    await new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS));
  }
  const anim = arbitrate(event, animationForEvent(event, opts.mode ?? getMode()));
  if (anim) {
    await postAnim(opts.url ?? getBaseUrl(), anim, getToken());
    // A timed-out fetch leaves its connect attempt open, which keeps Node alive
    // until undici's 10s connect timeout. Claude Code enforces no timeout on
    // async hooks, so exit now instead of lingering once per tool call.
    process.exit(0);
  }
  process.exitCode = 0;
}

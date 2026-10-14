import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_URL } from "./env.js";
import { robotRequest } from "./post.js";

export const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "PreToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "PreCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
];

// Ours, plus upstream tiny-engineer's deprecated bin and unified CLI (node or npx,
// optionally versioned), so a global install never runs two Tiny Engineer hooks
// for one event. Anchored on the bin names so unrelated user hooks never match.
export const MANAGED_PATTERNS = [
  /tiny-engineer-claude-hooks\.js/,
  /tiny-engineer-claude-code(\.js)?(["'\s]|$)/,
  /tiny-engineer(@[^\s"']+|\.js)?["']?\s+hook\s+claude-code(\s|$)/,
];

// The URL is embedded in a shell command, so reject anything a shell would interpret.
const URL_PATTERN = /^https?:\/\/[^\s"'`\\$]+$/;

// The bin path is embedded in double quotes; these characters would break or expand it.
const UNSAFE_PATH = /["`$\\]/;

const HELP = `Usage: node install.js [--url <base>] [--uninstall] [--dry-run]

Install Tiny Engineer hooks into the global Claude Code settings
(<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json), for every project.

Options:
  --url <base>   Robot base URL baked into the hooks (default: TINY_ENGINEER_URL,
                 else ${DEFAULT_URL})
  --uninstall    Remove Tiny Engineer hooks, keep everything else
  --dry-run      Show what would change, write nothing
  -h, --help     Show this help

Re-run after moving this folder. Existing settings are backed up first.`;

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function settingsPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(dir, "settings.json");
}

/**
 * @param {string} binPath absolute path to bin/tiny-engineer-claude-hooks.js
 * @param {string} [url]
 */
export function hookCommand(binPath, url) {
  const path = binPath.replace(/\\/g, "/");
  return url ? `node "${path}" --url "${url}"` : `node "${path}"`;
}

/**
 * @param {unknown} command
 */
function isManaged(command) {
  return typeof command === "string" && MANAGED_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Remove every managed hook. Wrappers and events emptied by the removal are dropped.
 * @param {object} settings
 * @returns {{ settings: object, removed: number }}
 */
export function removeHooks(settings) {
  const next = structuredClone(settings);
  let removed = 0;
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return { settings: next, removed };
  }

  for (const [event, wrappers] of Object.entries(hooks)) {
    if (!Array.isArray(wrappers)) continue;
    const kept = [];
    for (const wrapper of wrappers) {
      if (!Array.isArray(wrapper?.hooks)) {
        kept.push(wrapper);
        continue;
      }
      const remaining = wrapper.hooks.filter((hook) => !isManaged(hook?.command));
      removed += wrapper.hooks.length - remaining.length;
      if (remaining.length > 0 || wrapper.hooks.length === 0) {
        kept.push({ ...wrapper, hooks: remaining });
      }
    }
    if (kept.length > 0 || wrappers.length === 0) hooks[event] = kept;
    else delete hooks[event];
  }

  if (removed > 0 && Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

/**
 * Replace managed hooks with one async command hook per Claude Code event.
 * @param {object} settings
 * @param {string} command
 */
export function addHooks(settings, command) {
  const { settings: next } = removeHooks(settings);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) {
    next.hooks = {};
  }
  for (const event of CLAUDE_EVENTS) {
    if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
    next.hooks[event].push({ hooks: [{ type: "command", command, async: true }] });
  }
  return next;
}

/**
 * @param {string[]} argv
 */
export function parseInstallArgs(argv) {
  const opts = { url: undefined, uninstall: false, dryRun: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--uninstall") {
      opts.uninstall = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--url" || arg.startsWith("--url=")) {
      const value = arg === "--url" ? argv[++i] : arg.slice("--url=".length);
      if (!value) return { error: "--url requires a value" };
      if (!URL_PATTERN.test(value)) {
        return { error: `--url must be an http:// or https:// URL without spaces or quotes: ${value}` };
      }
      opts.url = value.replace(/\/+$/, "");
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return opts;
}

/**
 * @param {Record<string, string | undefined>} env
 */
function baseUrlFrom(env) {
  const value = env.TINY_ENGINEER_URL?.trim().replace(/\/+$/, "");
  return value || DEFAULT_URL;
}

/**
 * GET /health once and report the result. Never throws.
 * @param {string} base
 * @param {(line: string) => void} log
 * @param {number} [timeoutMs]
 */
export async function checkRobot(base, log, timeoutMs = 2000) {
  try {
    const { status, body } = await robotRequest(base, "/health", { timeoutMs });
    if (status >= 200 && status < 300) {
      let version = "";
      try {
        version = JSON.parse(body)?.version ?? "";
      } catch {
        // Health body is informational only.
      }
      log(`Robot reachable at ${base}${version ? ` (${version})` : ""}`);
      return true;
    }
    log(`Robot at ${base} answered HTTP ${status}`);
    return false;
  } catch (err) {
    const reason = err?.cause?.code ?? err?.message ?? String(err);
    log(
      `Robot not reachable at ${base} (${reason}). Hooks are installed anyway.\n` +
        "  - Is this computer on the same network as the robot (VPN off)?\n" +
        "  - .local names can fail: re-run with --url http://<IP shown on the OLED>"
    );
    return false;
  }
}

/**
 * @param {string[]} argv
 * @param {{
 *   binPath: string,
 *   env?: Record<string, string | undefined>,
 *   now?: number,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function runInstall(
  argv,
  { binPath, env = process.env, now = Date.now(), log = console.log, error = console.error }
) {
  const opts = parseInstallArgs(argv);
  if ("error" in opts) {
    error(opts.error);
    return 1;
  }
  if (opts.help) {
    log(HELP);
    return 0;
  }
  if (UNSAFE_PATH.test(binPath.replace(/\\/g, "/"))) {
    error(
      `This folder path contains a character a shell would interpret (" \` $ or \\):\n  ${binPath}\n` +
        "Move the clone to a folder path without them and run install.js again. Nothing written."
    );
    return 1;
  }

  const path = settingsPath(env);
  const exists = existsSync(path);
  let current = {};
  if (exists) {
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      error(`Cannot parse ${path}: ${err.message}. Nothing written.`);
      return 1;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      error(`${path} is not a JSON object. Nothing written.`);
      return 1;
    }
  }

  const command = hookCommand(binPath, opts.url);
  const { settings: stripped, removed } = removeHooks(current);
  const next = opts.uninstall ? stripped : addHooks(current, command);

  if (opts.dryRun) {
    log(
      opts.uninstall
        ? `Would remove ${removed} hook(s) from ${path}`
        : `Would write ${CLAUDE_EVENTS.length} hooks to ${path} (replacing ${removed}):\n  ${command}`
    );
    return 0;
  }
  if (opts.uninstall && removed === 0) {
    log(`No Tiny Engineer hooks in ${path}`);
    return 0;
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    if (exists) {
      const backup = `${path}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(path, backup);
      log(`Backup: ${backup}`);
    }
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    error(`Cannot write ${path}: ${err.message}`);
    return 1;
  }

  if (opts.uninstall) {
    log(`Removed ${removed} hook(s) from ${path}`);
    return 0;
  }

  log(`Installed ${CLAUDE_EVENTS.length} hooks in ${path}\n  ${command}`);
  await checkRobot(opts.url ?? baseUrlFrom(env), log);
  log("Start a new Claude Code session (or run /hooks) to pick up the change.");
  return 0;
}

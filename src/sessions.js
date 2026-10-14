import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A session with no event for this long counts as ended. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SUFFIX = ".json";

/**
 * @typedef {{ status: "waiting" | "working", anim: string | null, updatedAt: number, oneShotUntil: number }} SessionState
 */

/**
 * @returns {string} TINY_ENGINEER_STATE_DIR, else ~/.cache/tiny-engineer/claude-code/sessions
 */
export function stateDir() {
  const override = process.env.TINY_ENGINEER_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".cache", "tiny-engineer", "claude-code", "sessions");
}

/**
 * The id becomes a file name, so only allow characters that cannot leave the dir.
 * @param {unknown} id
 */
export function isValidSessionId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * @param {string} raw
 * @returns {SessionState | null}
 */
function parseState(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.status !== "waiting" && value.status !== "working") return null;
  if (!Number.isFinite(value.updatedAt)) return null;
  return {
    status: value.status,
    anim: typeof value.anim === "string" ? value.anim : null,
    updatedAt: value.updatedAt,
    oneShotUntil: Number.isFinite(value.oneShotUntil) ? value.oneShotUntil : 0,
  };
}

/**
 * Read every live session, pruning expired files. Unparsable files are skipped.
 * A missing dir means no sessions; any other dir error throws.
 * @param {string} dir
 * @param {number} now epoch ms
 * @returns {Map<string, SessionState>}
 */
export function readSessions(dir, now) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return new Map();
    throw err;
  }

  const sessions = new Map();
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue;
    const id = name.slice(0, -SUFFIX.length);
    if (!isValidSessionId(id)) continue;

    const path = join(dir, name);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const state = parseState(raw);
    if (!state) continue;

    if (now - state.updatedAt > SESSION_TTL_MS) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Another hook may be pruning the same file.
      }
      continue;
    }
    sessions.set(id, state);
  }
  return sessions;
}

/**
 * Write via temp file + rename so a concurrent reader never sees half a file.
 * @param {string} dir
 * @param {string} id
 * @param {SessionState} state
 */
export function writeSession(dir, id, state) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, id + SUFFIX);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, target);
}

/**
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn while holding `<id>.lock`, so read → decide → write of one session never
 * interleaves with another hook of the same session. A lock older than staleMs is
 * left over from a killed hook and taken over. Throws when the lock stays held.
 * @template T
 * @param {string} dir
 * @param {string} id
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {T}
 */
export function withSessionLock(dir, id, fn, { timeoutMs = 500, staleMs = 2000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${id}.lock`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // Released between our open and stat.
    }
    if (Date.now() >= deadline) throw new Error(`session lock busy: ${lock}`);
    sleepSync(5);
  }

  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * @param {string} dir
 * @param {string} id
 */
export function removeSession(dir, id) {
  rmSync(join(dir, id + SUFFIX), { force: true });
}

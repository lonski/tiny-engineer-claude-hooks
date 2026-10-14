# tiny-engineer-claude-hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloneable repo whose `node install.js` puts Tiny Engineer hooks into the global Claude Code settings, with hooks that coordinate several concurrent sessions on one computer.

**Architecture:** The stateless upstream hook CLI (stdin event → animation → `POST /anim`) gains an arbitration step: each hook process records its session in `<stateDir>/<session_id>.json`, reads the other sessions, and a pure `decide()` says whether to post. A separate installer merges hook entries into `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` idempotently and checks the robot's `/health`.

**Tech Stack:** Node.js ≥ 18 ESM, `node:fs`, `node:http` (tests), `node:test`, no dependencies; `gh` for publishing.

**Spec:** [`docs/superpowers/specs/2026-10-14-tiny-engineer-claude-hooks-design.md`](../specs/2026-10-14-tiny-engineer-claude-hooks-design.md)

Repo root: `/home/sps/sources/tiny-engineer-claude-hooks` (all paths below are relative to it). Upstream checkout for copying: `/home/sps/sources/tiny-engineer`, commit `738d8d6`.

## Global Constraints

- Node 18+; zero dependencies; `package.json` has no `dependencies` / `devDependencies`.
- Hook mode never writes to stdout.
- HTTP: `postAnim` 2 s timeout, errors swallowed, `process.exit(0)` after a post.
- State dir: `~/.cache/tiny-engineer/claude-code/sessions/`, override `TINY_ENGINEER_STATE_DIR`.
- Session TTL **2 h**; waiting TTL **30 min**.
- One-shot windows: `ring` 3000 ms, `welcome` 4000 ms, `abort` 4000 ms, `error` 4000 ms.
- Blocking events: `PermissionRequest`; `Notification` with `notification_type` `permission_prompt` or `elicitation_dialog`.
- `session_id` must match `^[A-Za-z0-9_-]{1,128}$`, else stateless fallback.
- With one session, every event posts exactly what `animationForEvent` returns.
- Installer target: `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`; managed markers `tiny-engineer-claude-hooks`, `tiny-engineer-claude-code`, `hook claude-code`.
- Bin name: `bin/tiny-engineer-claude-hooks.js`.
- Tests must never contact `tiny-engineer.local` or any real robot — always pass a `127.0.0.1` URL.
- Commits: `type: summary` (conventional, lowercase, imperative, no period), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command: `npm test` (from repo root).

## Review Focus

- Event without `session_id` (the README smoke test `echo '{"hook_event_name":"Stop"}' | node bin/…`) → posts `ring`. Test: Task 4 "event without session_id stays stateless".
- State dir unusable (path is a file) → every event posts unfiltered. Test: Task 4 "unusable state dir falls back to stateless".
- Existing `~/.claude/settings.json` with the user's own hooks, other keys, or broken JSON → own content preserved, backup written, broken file never overwritten. Tests: Task 5 "addHooks … keeps foreign hooks and keys", "backs up existing settings", "invalid JSON aborts without writing".
- Re-running the installer after moving the clone, or on a machine with upstream hooks installed → exactly one Tiny Engineer hook per event, at the new path. Test: Task 5 "addHooks is idempotent and replaces old paths and upstream entries".
- A session killed while `waiting` (no `SessionEnd`) → other sessions resume after 30 min, file pruned after 2 h. Tests: Task 2 "expired sessions are pruned", Task 3 "a stale waiting session no longer blocks".

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json`, `LICENSE`, `.gitignore` | Package metadata (no deps), MIT with both copyrights |
| `bin/tiny-engineer-claude-hooks.js` | Hook entry: `run(argv)` |
| `src/env.js`, `src/map.js`, `src/post.js` | Upstream copies, unchanged |
| `src/cli.js` | Args, stdin, map → arbitrate → post; help |
| `src/sessions.js` | State dir, id validation, read/prune, atomic write, delete |
| `src/arbiter.js` | Pure multi-session decision |
| `src/install.js` | Settings merge/strip, args, run, health check |
| `install.js` | Installer entry |
| `test/map.test.js`, `test/env.test.js` | Upstream copies |
| `test/sessions.test.js`, `test/arbiter.test.js`, `test/cli.test.js`, `test/install.test.js` | New tests |
| `README.md` | User docs |

---

### Task 1: Scaffold with the stateless upstream CLI

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore`, `bin/tiny-engineer-claude-hooks.js`, `src/cli.js`
- Copy from upstream: `src/env.js`, `src/map.js`, `src/post.js`, `test/map.test.js`, `test/env.test.js`

**Interfaces:**
- Consumes: upstream `env.js` (`DEFAULT_URL`, `getBaseUrl()`, `getToken()`, `loadDotEnv()`), `map.js` (`animationForEvent(event)`), `post.js` (`postAnim(baseUrl, animName, token)`).
- Produces: `src/cli.js` exports `parseArgs(argv) → { help: boolean, url?: string, error?: string }` and `run(argv): Promise<void>`.

- [ ] **Step 1: Copy upstream files**

```bash
cd /home/sps/sources/tiny-engineer-claude-hooks
mkdir -p bin src test
R=738d8d6:packages/tiny-engineer-claude-code
for f in src/env.js src/map.js src/post.js test/map.test.js test/env.test.js; do
  git -C /home/sps/sources/tiny-engineer show "$R/$f" > "$f"
done
grep -c . src/env.js src/map.js src/post.js test/map.test.js test/env.test.js
```

Expected: five non-zero line counts.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "tiny-engineer-claude-hooks",
  "version": "0.1.0",
  "private": true,
  "description": "Global Claude Code hooks for the Tiny Engineer desk robot, with multi-session coordination",
  "type": "module",
  "bin": {
    "tiny-engineer-claude-hooks": "./bin/tiny-engineer-claude-hooks.js"
  },
  "scripts": {
    "test": "node --test",
    "install-hooks": "node install.js"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 Krzysztof Jamroz
Copyright (c) 2026 Michal Lonski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.env
*.log
```

- [ ] **Step 5: Create `bin/tiny-engineer-claude-hooks.js`**

```js
#!/usr/bin/env node
import { run } from "../src/cli.js";

await run(process.argv.slice(2));
```

Then: `chmod +x bin/tiny-engineer-claude-hooks.js`

- [ ] **Step 6: Create `src/cli.js` (stateless; upstream CLI without `play`)**

```js
import { DEFAULT_URL, getBaseUrl, getToken, loadDotEnv } from "./env.js";
import { animationForEvent } from "./map.js";
import { postAnim } from "./post.js";

function printHelp() {
  console.log(`Usage: tiny-engineer-claude-hooks [options]

Claude Code hook helper: read event JSON from stdin, pick an animation, POST to the robot.
Install it into Claude Code with: node install.js

Options:
  --url <base>   Robot base URL (default: TINY_ENGINEER_URL, else ${DEFAULT_URL})
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
  Notification                                     → attention
  Stop                                             → ring
  StopFailure                                      → error

Examples:
  echo '{"hook_event_name":"Stop"}' | tiny-engineer-claude-hooks
  echo '{"hook_event_name":"PreToolUse","tool_name":"Read"}' | tiny-engineer-claude-hooks --url http://192.168.1.10
`);
}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, url?: string, error?: string }}
 */
export function parseArgs(argv) {
  let url;
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
    return { help: false, error: `Unknown argument: ${arg}` };
  }

  return { help, url };
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

  const anim = animationForEvent(event);
  if (anim) {
    await postAnim(opts.url ?? getBaseUrl(), anim, getToken());
    // A timed-out fetch leaves its connect attempt open, which keeps Node alive
    // until undici's 10s connect timeout. Claude Code enforces no timeout on
    // async hooks, so exit now instead of lingering once per tool call.
    process.exit(0);
  }
  process.exitCode = 0;
}
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS (upstream `map` and `env` tests). Also: `node bin/tiny-engineer-claude-hooks.js --help | head -3` prints the usage line.

- [ ] **Step 8: Commit**

```bash
git add package.json LICENSE .gitignore bin src test
git commit -m "feat: import stateless claude code hook cli from tiny-engineer

Copied from jamro/tiny-engineer@738d8d6 packages/tiny-engineer-claude-code
without the play subcommand.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Session state store

**Files:**
- Create: `src/sessions.js`
- Test: `test/sessions.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SESSION_TTL_MS: number` (7 200 000)
  - `stateDir(): string`
  - `isValidSessionId(id: unknown): boolean`
  - `readSessions(dir: string, now: number): Map<string, SessionState>` — live sessions only; prunes expired files; missing dir → empty map; other dir errors throw.
  - `writeSession(dir: string, id: string, state: SessionState): void` — atomic; creates dir; throws on error.
  - `removeSession(dir: string, id: string): void` — no error if missing.
  - `SessionState = { status: "waiting" | "working", anim: string | null, updatedAt: number, oneShotUntil: number }`

- [ ] **Step 1: Write the failing tests**

Create `test/sessions.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_TTL_MS,
  isValidSessionId,
  readSessions,
  removeSession,
  stateDir,
  writeSession,
} from "../src/sessions.js";

const NOW = 1_800_000_000_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "te-hooks-sessions-"));
}

function state(overrides = {}) {
  return { status: "working", anim: "typing", updatedAt: NOW, oneShotUntil: 0, ...overrides };
}

test("stateDir honours TINY_ENGINEER_STATE_DIR, else ~/.cache", () => {
  const saved = process.env.TINY_ENGINEER_STATE_DIR;
  try {
    process.env.TINY_ENGINEER_STATE_DIR = "  /tmp/te-state  ";
    assert.equal(stateDir(), "/tmp/te-state");
    delete process.env.TINY_ENGINEER_STATE_DIR;
    assert.match(stateDir(), /\.cache[\\/]tiny-engineer[\\/]claude-code[\\/]sessions$/);
  } finally {
    if (saved === undefined) delete process.env.TINY_ENGINEER_STATE_DIR;
    else process.env.TINY_ENGINEER_STATE_DIR = saved;
  }
});

test("isValidSessionId accepts ids and rejects path tricks", () => {
  assert.equal(isValidSessionId("0f6c1a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"), true);
  assert.equal(isValidSessionId("abc_DEF-123"), true);
  for (const bad of ["", "../x", "a/b", "a\\b", "a.b", "x".repeat(129), 42, null, undefined]) {
    assert.equal(isValidSessionId(bad), false, String(bad));
  }
});

test("write then read round-trips sessions", () => {
  const dir = join(tempDir(), "nested", "sessions");
  writeSession(dir, "a", state({ status: "waiting", anim: "attention" }));
  writeSession(dir, "b", state({ oneShotUntil: NOW + 3000, anim: "ring" }));
  const sessions = readSessions(dir, NOW);
  assert.deepEqual(sessions.get("a"), state({ status: "waiting", anim: "attention" }));
  assert.deepEqual(sessions.get("b"), state({ oneShotUntil: NOW + 3000, anim: "ring" }));
  assert.equal(sessions.size, 2);
});

test("write leaves no temp file behind", () => {
  const dir = tempDir();
  writeSession(dir, "a", state());
  writeSession(dir, "a", state({ anim: "reading" }));
  assert.deepEqual(readdirSync(dir), ["a.json"]);
  assert.equal(readSessions(dir, NOW).get("a").anim, "reading");
});

test("missing directory reads as no sessions", () => {
  assert.equal(readSessions(join(tempDir(), "missing"), NOW).size, 0);
});

test("unreadable directory throws", () => {
  const file = join(tempDir(), "not-a-dir");
  writeFileSync(file, "x");
  assert.throws(() => readSessions(file, NOW));
});

test("expired sessions are pruned", () => {
  const dir = tempDir();
  writeSession(dir, "old", state({ updatedAt: NOW - SESSION_TTL_MS - 1 }));
  writeSession(dir, "fresh", state({ updatedAt: NOW - SESSION_TTL_MS + 1 }));
  const sessions = readSessions(dir, NOW);
  assert.deepEqual([...sessions.keys()], ["fresh"]);
  assert.equal(existsSync(join(dir, "old.json")), false);
});

test("temp and corrupt files are skipped", () => {
  const dir = tempDir();
  writeSession(dir, "good", state());
  writeFileSync(join(dir, "half.json"), '{"status":"work');
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ status: "busy", updatedAt: NOW }));
  writeFileSync(join(dir, "good.json.123.tmp"), JSON.stringify(state()));
  writeFileSync(join(dir, "bad.name.json"), JSON.stringify(state()));
  assert.deepEqual([...readSessions(dir, NOW).keys()], ["good"]);
});

test("removeSession deletes the file and ignores a missing one", () => {
  const dir = tempDir();
  writeSession(dir, "a", state());
  removeSession(dir, "a");
  removeSession(dir, "a");
  assert.equal(readSessions(dir, NOW).size, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '…/src/sessions.js'`.

- [ ] **Step 3: Implement `src/sessions.js`**

```js
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
 * @param {string} dir
 * @param {string} id
 */
export function removeSession(dir, id) {
  rmSync(join(dir, id + SUFFIX), { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.js test/sessions.test.js
git commit -m "feat: add session state store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Arbiter (decision rules)

**Files:**
- Create: `src/arbiter.js`
- Test: `test/arbiter.test.js`

**Interfaces:**
- Consumes: `SessionState` shape from Task 2 (plain objects); `animationForEvent(event)` from `src/map.js` (tests only).
- Produces:
  - `WAITING_TTL_MS: number` (1 800 000)
  - `WORK_ANIMS: Set<string>`
  - `ONE_SHOT_MS: Map<string, number>`
  - `isBlocking(event: object | null): boolean`
  - `decide({ event, anim, self, others, now }): { post: string | null, nextSelf: SessionState | null }` — `self: SessionState | null` (this session's previous state), `others: SessionState[]` (other **live** sessions), `nextSelf: null` means delete this session's file.

- [ ] **Step 1: Write the failing tests**

Create `test/arbiter.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ONE_SHOT_MS, WAITING_TTL_MS, decide, isBlocking } from "../src/arbiter.js";
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
  // Own previous state must never filter its own events.
  const self = { status: "waiting", anim: "ring", updatedAt: NOW - 10, oneShotUntil: NOW + 5000 };
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '…/src/arbiter.js'`.

- [ ] **Step 3: Implement `src/arbiter.js`**

```js
/** A waiting session older than this stops blocking others. */
export const WAITING_TTL_MS = 30 * 60 * 1000;

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
 * @param {string | undefined} name
 * @param {string | null} anim
 * @param {boolean} waiting
 * @param {SessionState[]} others
 * @param {number} now
 * @returns {string | null}
 */
function choosePost(name, anim, waiting, others, now) {
  if (!anim) return null;
  if (name === "SessionStart" && others.length > 0) return null;
  if (waiting) return anim;

  const otherWaiting = others.some(
    (o) => o.status === "waiting" && now - o.updatedAt < WAITING_TTL_MS
  );
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
    return { post: others.length > 0 ? null : anim, nextSelf: null };
  }

  const waiting = isBlocking(event);
  const post = choosePost(name, anim, waiting, others, now);

  let oneShotUntil = self?.oneShotUntil ?? 0;
  if (post) oneShotUntil = ONE_SHOT_MS.has(post) ? now + ONE_SHOT_MS.get(post) : 0;

  return {
    post,
    nextSelf: { status: waiting ? "waiting" : "working", anim, updatedAt: now, oneShotUntil },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/arbiter.js test/arbiter.test.js
git commit -m "feat: add multi-session arbiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Arbitrate in the hook CLI, end-to-end tests

**Files:**
- Modify: `src/cli.js` (imports; new `arbitrate`; one line in `run()`; help text)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: Task 2 `stateDir`, `isValidSessionId`, `readSessions`, `writeSession`, `removeSession`; Task 3 `decide`; `animationForEvent`, `postAnim`.
- Produces: `arbitrate(event: object | null, anim: string | null, now?: number): string | null` exported from `src/cli.js`.

- [ ] **Step 1: Write the failing end-to-end tests**

Create `test/cli.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL in "two sessions…" — actual posts contain a second `welcome`, an extra `typing`, and a second `sleep` (CLI still stateless). The other three new tests pass already (they pin stateless behavior).

- [ ] **Step 3: Add `arbitrate` and wire it into `run()`**

In `src/cli.js`, replace the imports at the top:

```js
import { DEFAULT_URL, getBaseUrl, getToken, loadDotEnv } from "./env.js";
import { animationForEvent } from "./map.js";
import { postAnim } from "./post.js";
```

with:

```js
import { decide } from "./arbiter.js";
import { DEFAULT_URL, getBaseUrl, getToken, loadDotEnv } from "./env.js";
import { animationForEvent } from "./map.js";
import { postAnim } from "./post.js";
import {
  isValidSessionId,
  readSessions,
  removeSession,
  stateDir,
  writeSession,
} from "./sessions.js";
```

Add directly above `export async function run(argv) {`:

```js
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

  let dir;
  let decision;
  try {
    dir = stateDir();
    const sessions = readSessions(dir, now);
    const self = sessions.get(id) ?? null;
    sessions.delete(id);
    decision = decide({ event, anim, self, others: [...sessions.values()], now });
  } catch {
    return anim;
  }

  try {
    if (decision.nextSelf) writeSession(dir, id, decision.nextSelf);
    else removeSession(dir, id);
  } catch {
    // State is best effort; the decision still stands.
  }
  return decision.post;
}
```

In `run()`, replace:

```js
  const anim = animationForEvent(event);
```

with:

```js
  const anim = arbitrate(event, animationForEvent(event));
```

- [ ] **Step 4: Add the help-text note**

In `printHelp()` in `src/cli.js`, insert directly before the `Examples:` line:

```
Multiple sessions:
  Hooks from concurrent sessions on this computer share state in
  TINY_ENGINEER_STATE_DIR (default ~/.cache/tiny-engineer/claude-code/sessions).
  A session asking for permission keeps attention until it is answered;
  ring/welcome/abort/error are not cut short by another session's work poses;
  welcome/wakeup play only for the first session and sleep only for the last.
  Events without session_id, or any state error, behave as a single session.

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests.

Also: `node bin/tiny-engineer-claude-hooks.js --help | grep -A6 "Multiple sessions"` prints the block.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: coordinate concurrent claude code sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Global installer

**Files:**
- Create: `src/install.js`, `install.js`
- Test: `test/install.test.js`

**Interfaces:**
- Consumes: `DEFAULT_URL` from `src/env.js`.
- Produces (from `src/install.js`):
  - `CLAUDE_EVENTS: string[]` (13 names), `MARKERS: string[]`
  - `settingsPath(env?: Record<string, string | undefined>): string`
  - `hookCommand(binPath: string, url?: string): string`
  - `removeHooks(settings: object): { settings: object, removed: number }` — never mutates input
  - `addHooks(settings: object, command: string): object` — never mutates input
  - `parseInstallArgs(argv: string[]): { url?: string, uninstall: boolean, dryRun: boolean, help: boolean } | { error: string }`
  - `checkRobot(base: string, log: (line: string) => void, timeoutMs?: number): Promise<boolean>`
  - `runInstall(argv, { binPath, env?, now?, log?, error? }): Promise<number>` — exit code

- [ ] **Step 1: Write the failing tests**

Create `test/install.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_EVENTS,
  addHooks,
  hookCommand,
  parseInstallArgs,
  removeHooks,
  runInstall,
  settingsPath,
} from "../src/install.js";

const BIN = "/opt/te/bin/tiny-engineer-claude-hooks.js";
const CMD = hookCommand(BIN);
const OURS = { type: "command", command: CMD, async: true };
const FOREIGN = { type: "command", command: "bash ~/.claude/hooks/other.sh", timeout: 10 };
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function tempConfig() {
  return mkdtempSync(join(tmpdir(), "te-hooks-config-"));
}

function readSettings(dir) {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
}

async function startHealth(body) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function closedUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

async function install(argv, configDir, extraEnv = {}) {
  const lines = [];
  const errors = [];
  const code = await runInstall(argv, {
    binPath: BIN,
    env: { CLAUDE_CONFIG_DIR: configDir, ...extraEnv },
    now: NOW,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

test("settingsPath honours CLAUDE_CONFIG_DIR", () => {
  assert.equal(settingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }), join("/cfg", "settings.json"));
  assert.match(settingsPath({}), /\.claude[\\/]settings\.json$/);
});

test("hookCommand quotes the path, uses forward slashes, appends --url", () => {
  assert.equal(hookCommand(BIN), `node "${BIN}"`);
  assert.equal(
    hookCommand("C:\\Users\\me\\te\\bin\\tiny-engineer-claude-hooks.js"),
    'node "C:/Users/me/te/bin/tiny-engineer-claude-hooks.js"'
  );
  assert.equal(
    hookCommand(BIN, "http://192.168.1.154"),
    `node "${BIN}" --url "http://192.168.1.154"`
  );
});

test("parseInstallArgs reads flags and validates --url", () => {
  assert.deepEqual(parseInstallArgs([]), { url: undefined, uninstall: false, dryRun: false, help: false });
  assert.equal(parseInstallArgs(["--url", "http://10.0.0.5/"]).url, "http://10.0.0.5");
  assert.equal(parseInstallArgs(["--url=https://robot.lan"]).url, "https://robot.lan");
  assert.equal(parseInstallArgs(["--uninstall"]).uninstall, true);
  assert.equal(parseInstallArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseInstallArgs(["-h"]).help, true);
  assert.match(parseInstallArgs(["--url"]).error, /requires a value/);
  for (const bad of ["robot.local", "ftp://x", 'http://x"; rm -rf ~', "http://a b", "http://$HOME"]) {
    assert.match(parseInstallArgs(["--url", bad]).error, /must be an http/, bad);
  }
  assert.match(parseInstallArgs(["--force"]).error, /Unknown argument/);
});

test("addHooks adds every event once and keeps foreign hooks and keys", () => {
  const settings = { model: "opus", hooks: { SessionStart: [{ matcher: "*", hooks: [FOREIGN] }] } };
  const next = addHooks(settings, CMD);
  assert.equal(next.model, "opus");
  assert.deepEqual(Object.keys(next.hooks).sort(), [...CLAUDE_EVENTS].sort());
  assert.deepEqual(next.hooks.SessionStart[0], { matcher: "*", hooks: [FOREIGN] });
  for (const event of CLAUDE_EVENTS) {
    const ours = next.hooks[event].flatMap((w) => w.hooks).filter((h) => h.command === CMD);
    assert.deepEqual(ours, [OURS], event);
  }
  assert.deepEqual(settings, { model: "opus", hooks: { SessionStart: [{ matcher: "*", hooks: [FOREIGN] }] } });
});

test("addHooks is idempotent and replaces old paths and upstream entries", () => {
  const upstream = {
    type: "command",
    command: 'node "$CLAUDE_PROJECT_DIR/packages/tiny-engineer-cli/bin/tiny-engineer.js" hook claude-code',
    async: true,
  };
  const legacy = {
    type: "command",
    command: 'node "/old/packages/tiny-engineer-claude-code/bin/tiny-engineer-claude-code.js"',
    async: true,
  };
  let settings = addHooks(
    { hooks: { Stop: [{ hooks: [upstream] }, { hooks: [legacy, FOREIGN] }] } },
    hookCommand("/old/place/bin/tiny-engineer-claude-hooks.js")
  );
  settings = addHooks(settings, CMD);
  settings = addHooks(settings, CMD);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [FOREIGN] }, { hooks: [OURS] }]);
  assert.equal(JSON.stringify(settings).includes("/old/"), false);
});

test("removeHooks strips only managed entries and drops what it emptied", () => {
  const original = { env: { A: "1" }, hooks: { Stop: [{ hooks: [FOREIGN] }], Custom: [] } };
  const { settings, removed } = removeHooks(addHooks(original, CMD));
  assert.equal(removed, CLAUDE_EVENTS.length);
  assert.deepEqual(settings, original);
  assert.deepEqual(removeHooks(addHooks({}, CMD)).settings, {});
});

test("creates settings when missing and reports an unreachable robot", async () => {
  const dir = tempConfig();
  const url = await closedUrl();
  const { code, out } = await install(["--url", url], dir);
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
  const stop = readSettings(dir).hooks.Stop;
  assert.deepEqual(stop, [{ hooks: [{ type: "command", command: hookCommand(BIN, url), async: true }] }]);
  assert.match(out, /not reachable/);
});

test("backs up existing settings and keeps them", async () => {
  const dir = tempConfig();
  writeFileSync(join(dir, "settings.json"), '{"model":"opus"}');
  const { code } = await install(["--url", await closedUrl()], dir);
  assert.equal(code, 0);
  const backup = join(dir, "settings.json.bak-2026-10-14T12-00-00-000Z");
  assert.equal(readFileSync(backup, "utf8"), '{"model":"opus"}');
  const settings = readSettings(dir);
  assert.equal(settings.model, "opus");
  assert.equal(Object.keys(settings.hooks).length, CLAUDE_EVENTS.length);
});

test("invalid JSON aborts without writing", async () => {
  const dir = tempConfig();
  writeFileSync(join(dir, "settings.json"), "{oops");
  const { code, err } = await install(["--url", await closedUrl()], dir);
  assert.equal(code, 1);
  assert.match(err, /Cannot parse/);
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{oops");
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("non-object JSON aborts without writing", async () => {
  const dir = tempConfig();
  writeFileSync(join(dir, "settings.json"), "[]");
  const { code, err } = await install(["--url", await closedUrl()], dir);
  assert.equal(code, 1);
  assert.match(err, /not a JSON object/);
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "[]");
});

test("bad --url exits 1 and writes nothing", async () => {
  const dir = tempConfig();
  const { code } = await install(["--url", "robot.local"], dir);
  assert.equal(code, 1);
  assert.equal(existsSync(join(dir, "settings.json")), false);
});

test("dry run writes nothing", async () => {
  const dir = tempConfig();
  const { code, out } = await install(["--dry-run"], dir);
  assert.equal(code, 0);
  assert.match(out, /Would write 13 hooks/);
  assert.equal(existsSync(join(dir, "settings.json")), false);
});

test("uninstall removes managed hooks and keeps the rest", async () => {
  const dir = tempConfig();
  writeFileSync(join(dir, "settings.json"), '{"model":"opus"}');
  await install(["--url", await closedUrl()], dir);
  const { code, out } = await install(["--uninstall"], dir);
  assert.equal(code, 0);
  assert.match(out, /Removed 13 hook/);
  assert.deepEqual(readSettings(dir), { model: "opus" });
});

test("uninstall with nothing installed writes nothing", async () => {
  const dir = tempConfig();
  const { code, out } = await install(["--uninstall"], dir);
  assert.equal(code, 0);
  assert.match(out, /No Tiny Engineer hooks/);
  assert.equal(existsSync(join(dir, "settings.json")), false);
});

test("reports a reachable robot with its version", async () => {
  const robot = await startHealth({ ok: true, version: "v0.2.0" });
  try {
    const { out } = await install(["--url", robot.url], tempConfig());
    assert.match(out, /Robot reachable at http:\/\/127\.0\.0\.1:\d+ \(v0\.2\.0\)/);
  } finally {
    await robot.close();
  }
});

test("health check falls back to TINY_ENGINEER_URL without --url", async () => {
  const robot = await startHealth({ ok: true, version: "v0.2.0" });
  const dir = tempConfig();
  try {
    const { out } = await install([], dir, { TINY_ENGINEER_URL: robot.url });
    assert.match(out, /Robot reachable/);
    assert.equal(readSettings(dir).hooks.Stop[0].hooks[0].command, CMD);
  } finally {
    await robot.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '…/src/install.js'`.

- [ ] **Step 3: Implement `src/install.js`**

```js
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_URL } from "./env.js";

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

// Ours, plus upstream tiny-engineer's deprecated bin and unified CLI, so a global
// install never runs two Tiny Engineer hooks for one event.
export const MARKERS = ["tiny-engineer-claude-hooks", "tiny-engineer-claude-code", "hook claude-code"];

// The URL is embedded in a shell command, so reject anything a shell would interpret.
const URL_PATTERN = /^https?:\/\/[^\s"'`\\$]+$/;

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
  return typeof command === "string" && MARKERS.some((marker) => command.includes(marker));
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
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      let version = "";
      try {
        version = (await response.json())?.version ?? "";
      } catch {
        // Health body is informational only.
      }
      log(`Robot reachable at ${base}${version ? ` (${version})` : ""}`);
      return true;
    }
    log(`Robot at ${base} answered HTTP ${response.status}`);
    return false;
  } catch {
    log(
      `Robot not reachable at ${base}. Hooks are installed anyway.\n` +
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
```

- [ ] **Step 4: Create `install.js` (repo root)**

```js
#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "./src/install.js";

const binPath = join(dirname(fileURLToPath(import.meta.url)), "bin", "tiny-engineer-claude-hooks.js");
const code = await runInstall(process.argv.slice(2), { binPath });
// A timed-out health check can leave a socket open; do not wait for it.
process.exit(code);
```

Then: `chmod +x install.js`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests.

Also, against a throwaway config dir (never the real `~/.claude`):

```bash
CLAUDE_CONFIG_DIR="$(mktemp -d)" node install.js --dry-run
node install.js --help | head -1
```

Expected: `Would write 13 hooks to …/settings.json (replacing 0):` followed by the command with this repo's absolute path; help prints the usage line.

- [ ] **Step 6: Commit**

```bash
git add src/install.js install.js test/install.test.js
git commit -m "feat: add global hook installer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: README and publish to GitHub

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: CLI and installer behavior from Tasks 1–5 (flags, paths, env vars as defined there).
- Produces: public repo `https://github.com/lonski/tiny-engineer-claude-hooks`.

- [ ] **Step 1: Create `README.md`**

````markdown
# tiny-engineer-claude-hooks

Claude Code hooks for the [Tiny Engineer](https://github.com/jamro/tiny-engineer) desk robot,
installed **globally** (every project on the computer) with one command, and safe to use
with **several Claude Code sessions at once**.

Based on the Claude Code hook CLI from [jamro/tiny-engineer](https://github.com/jamro/tiny-engineer)
(MIT). Upstream also offers `npx tiny-engineer setup`, which installs hooks per project.

## Requirements

- Node.js 18+
- Claude Code
- A Tiny Engineer on the same network (`http://tiny-engineer.local/health` answers)

## Install

```bash
git clone https://github.com/lonski/tiny-engineer-claude-hooks.git
cd tiny-engineer-claude-hooks
node install.js
```

If `tiny-engineer.local` does not resolve on this computer, pass the robot's IP (shown on its OLED):

```bash
node install.js --url http://192.168.1.154
```

The installer:

- writes one async hook per Claude Code event into `~/.claude/settings.json`
  (or `$CLAUDE_CONFIG_DIR/settings.json`), pointing at this folder;
- backs up the existing file to `settings.json.bak-<timestamp>` first;
- keeps your other hooks and settings, and replaces older Tiny Engineer hooks
  (from this repo or from upstream `tiny-engineer`) in that file;
- checks `GET /health` on the robot and tells you if it is unreachable.

Start a new Claude Code session afterwards. `/hooks` lists the installed hooks.

Options: `--dry-run` (show, don't write), `--uninstall`, `--help`.

### Update or move

```bash
git pull
node install.js          # re-run after moving the folder; paths are absolute
```

### Uninstall

```bash
node install.js --uninstall
```

### Auth token

If the robot has an `access_token`, set it in the environment Claude Code starts from
(for example in `~/.bashrc` / `~/.zshrc`):

```bash
export TINY_ENGINEER_TOKEN=...
```

The installer never writes the token into Claude Code settings.

## What the robot does

| Claude Code event | Animation |
| --- | --- |
| `SessionStart` (fresh launch) / other starts | `welcome` / `wakeup` |
| `SessionEnd` | `sleep` (skipped for `/clear` and `/resume`) |
| `UserPromptSubmit`, `PreToolUse` Read/Grep/Glob/WebFetch/WebSearch | `reading` |
| `PreToolUse` Bash/PowerShell/Edit/Write/NotebookEdit | `typing` |
| `SubagentStart`, `PostToolBatch`, `PreCompact` | `thinking` |
| `PermissionRequest`, `Notification` | `attention` |
| `PermissionDenied` | `abort` |
| `PostToolUseFailure`, `StopFailure` | `error` |
| `Stop` | `ring` |

## Multiple sessions

Each hook records its session in `~/.cache/tiny-engineer/claude-code/sessions/`
(override with `TINY_ENGINEER_STATE_DIR`) and checks the other sessions before posting:

- A session asking for permission keeps the robot in `attention`; other sessions' poses are
  skipped until you answer it.
- `ring`, `welcome`, `abort`, and `error` are not cut short by another session's
  `typing` / `reading` / `thinking`.
- `welcome` / `wakeup` play only when no other session is running; `sleep` only when the last
  session ends.
- A session silent for 2 h counts as ended; a permission prompt older than 30 min stops blocking.

With one session, behavior is the same as upstream. Sessions on different computers do not
see each other.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| Installer says robot not reachable | Same Wi-Fi/LAN as the robot? VPN off? Re-run with `--url http://<IP>` |
| Nothing happens in Claude Code | New session started? `/hooks` shows `tiny-engineer-claude-hooks`? Organization-managed settings may block user hooks |
| Robot reacts twice inside the `tiny-engineer` repo | That repo has its own project hooks. Disable them for yourself with a `.claude/settings.local.json` containing `{"hooks": {}}`, or ignore it |
| Smoke test | `echo '{"hook_event_name":"Stop"}' \| node bin/tiny-engineer-claude-hooks.js` rings the bell |

## Development

```bash
npm test
```

Design and plan: [`docs/superpowers/`](docs/superpowers/).

## License

MIT — see [LICENSE](LICENSE). Original hook CLI © Krzysztof Jamroz.
````

- [ ] **Step 2: Verify README claims against the code**

Run: `npm test` (PASS) and `node install.js --help` — flags in the README (`--url`, `--dry-run`, `--uninstall`, `--help`) match the help output; env vars named in the README (`CLAUDE_CONFIG_DIR`, `TINY_ENGINEER_STATE_DIR`, `TINY_ENGINEER_TOKEN`, `TINY_ENGINEER_URL`) appear in `src/`:

```bash
for v in CLAUDE_CONFIG_DIR TINY_ENGINEER_STATE_DIR TINY_ENGINEER_TOKEN TINY_ENGINEER_URL; do grep -rl "$v" src >/dev/null && echo "ok $v" || echo "MISSING $v"; done
```

Expected: four `ok` lines.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add readme

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Pre-publish secret check**

```bash
git status --short
git ls-files
git grep -n -I -E "TINY_ENGINEER_TOKEN=[^.\"' ]|Bearer [A-Za-z0-9]{8,}|password\s*[:=]|PRIVATE KEY|ghp_[A-Za-z0-9]" || echo "no secret patterns"
```

Expected: clean working tree; only the files from this plan; exactly one hit — `test/env.test.js` with the fake fixture `TINY_ENGINEER_TOKEN=projtok` (upstream test data, not a secret). Any other hit: stop and report it before pushing.

- [ ] **Step 5: Create the public GitHub repo and push**

```bash
gh repo create lonski/tiny-engineer-claude-hooks --public --source . --remote origin --push \
  --description "Global Claude Code hooks for the Tiny Engineer desk robot, with multi-session support"
gh repo view lonski/tiny-engineer-claude-hooks --json url,visibility
```

Expected: JSON with `"visibility":"PUBLIC"` and the repo URL.

- [ ] **Step 6: Verify a fresh clone installs (throwaway config)**

```bash
D="$(mktemp -d)"
git clone -q https://github.com/lonski/tiny-engineer-claude-hooks.git "$D/clone"
(cd "$D/clone" && npm test >/dev/null && CLAUDE_CONFIG_DIR="$D/cfg" node install.js --dry-run)
```

Expected: tests pass silently; dry run prints `Would write 13 hooks` with a path inside `$D/clone`.

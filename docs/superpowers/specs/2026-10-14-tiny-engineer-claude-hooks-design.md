# tiny-engineer-claude-hooks — design

Date: 2026-10-14

A standalone, cloneable repo that drives a [Tiny Engineer](https://github.com/jamro/tiny-engineer)
desk robot from Claude Code hooks, installs those hooks globally with one command, and
coordinates several concurrent Claude Code sessions on one computer.

## Background

Upstream (`jamro/tiny-engineer`) ships Claude Code hooks two ways:

- `packages/tiny-engineer-claude-code` — small stateless Node CLI, now marked deprecated.
- `packages/tiny-engineer-cli` (`npx tiny-engineer setup`) — unified CLI for several IDEs;
  installs hooks **per project** only.

Neither installs hooks for every project on a machine, and neither coordinates concurrent
sessions. The event → animation map is identical in both.

## Goals

1. Clone on any computer, run one command, and every Claude Code session on that machine
   drives the robot.
2. A session waiting on the user keeps the robot in `attention` until it is answered.
3. One-shot gestures (`ring`, `welcome`, `abort`, `error`) are not cut short by another
   session's work animations.
4. `sleep` only when the last session ends; no `welcome`/`wakeup` while others are active.
5. With exactly one session, behavior is identical to upstream's CLI.

## Non-goals

- Coordination across several computers (state stays on one machine).
- Cursor / Antigravity, upstream's `play` command, setup wizard, `doctor`.
- Automatic sync with upstream; map changes are ported by hand.
- Repeating `attention` reminders while a session keeps waiting.

## Repository

`~/sources/tiny-engineer-claude-hooks`, public on GitHub as `lonski/tiny-engineer-claude-hooks`.

```
README.md            install, behavior, multiple sessions, troubleshooting
LICENSE              MIT; upstream copyright (Krzysztof Jamroz) kept, plus own copyright
package.json         no dependencies, Node >= 18, "test": "node --test"
install.js           entry point: node install.js [...]
bin/tiny-engineer-claude-hooks.js
src/cli.js           hook entry: stdin → map → arbitrate → POST
src/env.js           upstream, unchanged
src/map.js           upstream, unchanged
src/post.js          upstream, unchanged
src/sessions.js      session state store
src/arbiter.js       multi-session decision rules
src/install.js       installer logic
test/*.test.js
docs/superpowers/{specs,plans}/
```

Provenance: `env.js`, `map.js`, `post.js`, `test/map.test.js`, `test/env.test.js` copied from
`jamro/tiny-engineer@738d8d6`, `packages/tiny-engineer-claude-code/`. `cli.js` is that package's
CLI without the `play` subcommand, with its own bin name and the arbitration step.

The bin has its own name (`tiny-engineer-claude-hooks`) so the installer can tell its hooks
apart from upstream's (`tiny-engineer-claude-code`, `hook claude-code`).

## Installer

`node install.js [--url <base>] [--uninstall] [--dry-run] [-h|--help]`

- Target: `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` (global, all projects).
- Events (14: upstream's 13 plus `SubagentStop`): `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
  `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolBatch`, `PostToolUseFailure`, `PreCompact`,
  `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`.
- Each event gets `{ "hooks": [{ "type": "command", "command": <cmd>, "async": true }] }`,
  where `<cmd>` is `node "<absolute bin path>"` plus ` --url "<base>"` when `--url` is given.
  Backslashes in the path become `/` (works for Node on Windows and in Claude Code's shell).
- Idempotent: first remove every managed hook from the global file, then add ours. Managed =
  command matches this repo's bin (`tiny-engineer-claude-hooks.js`), upstream's deprecated
  bin (`tiny-engineer-claude-code`, as a whole word), or upstream's unified CLI
  (`tiny-engineer[@version|.js] hook claude-code`). Unrelated user hooks never match.
  Wrappers and event keys left empty by that removal are dropped. Re-running after moving
  the clone fixes the paths.
- Foreign hooks and all other settings keys are preserved.
- Missing settings file → created (with its directory). Existing file → copied to
  `settings.json.bak-<ISO timestamp>` before writing. Unparsable or non-object JSON → print an
  error, write nothing, exit 1.
- `--url` must be an `http://` or `https://` URL without whitespace or quotes; otherwise exit 1.
- The clone path must not contain `"`, `` ` ``, `$` or `\` (after `\` → `/`); otherwise exit 1
  with a message, nothing written. *(Added after final review.)*
- `--dry-run` prints what would change and writes nothing.
- `--uninstall` removes only managed entries (same markers), with the same backup rule.
- After install (not uninstall, not dry-run): `GET <base>/health` with a 2 s timeout, where
  `<base>` is `--url`, else `TINY_ENGINEER_URL`, else `http://tiny-engineer.local`. Prints
  reachable/unreachable; unreachable prints hints (same network, VPN, try the IP shown on the
  OLED with `--url`) and still exits 0.
- The token is never written to settings. README explains `TINY_ENGINEER_TOKEN`.

Known limitation: the upstream `tiny-engineer` repo has its own project hooks in
`.claude/settings.json`; inside that repo events fire twice. README explains disabling them
with a project `.claude/settings.local.json`.

## Session state

Directory: `~/.cache/tiny-engineer/claude-code/sessions/`, overridable with
`TINY_ENGINEER_STATE_DIR` (also used by tests). One file per session:
`<session_id>.json`, where `session_id` comes from the hook payload.

```json
{ "status": "working", "anim": "typing", "updatedAt": 1739500000000, "oneShotUntil": 0, "agents": {} }
```

| Field | Meaning |
| --- | --- |
| `status` | `waiting` or `working` (see below) |
| `anim` | Last animation this session asked for (diagnostics only) |
| `updatedAt` | Epoch ms of this session's latest event |
| `oneShotUntil` | Epoch ms until which this session's one-shot must not be cut by other sessions' work animations; `0` when none |
| `agents` | Running subagents, `agent_id` → epoch ms of its latest event. `SubagentStart` adds, `SubagentStop` removes, the agent's other events refresh; entries older than `AGENT_TTL_MS` (10 min) are dropped. *(Added after use.)* |

Status transitions, applied for every event of the session:

- `waiting` — set by `PermissionRequest`, and by `Notification` whose
  `notification_type` is `permission_prompt` or `elicitation_dialog`.
- `working` — set by any other event of that session. Answering the prompt produces
  a later event (`PostToolBatch`, `PostToolUseFailure`, `UserPromptSubmit`,
  `PermissionDenied`, `Stop`, …), which clears `waiting`.
- `Notification` with `notification_type` `idle_prompt` (or any other type, or none)
  does not set `waiting`.
- A `PreToolUse` or non-blocking `Notification` of a session that is already (freshly)
  `waiting` keeps it `waiting` and posts nothing (a reminder still posts `attention`):
  neither means the user answered, and a `PreToolUse` can race its own
  `PermissionRequest`. *(Added after final review.)*

Lifecycle:

- The first event of a session creates its file.
- `SessionEnd` deletes the file (any reason). `/clear` and `/resume` start a new
  `session_id`, whose `SessionStart` creates a new file.
- A session with no event for **2 h** counts as ended; its file is pruned when
  another hook reads the directory.
- A `waiting` status older than **30 min** no longer blocks other sessions.

"Other live sessions" = files other than the current session's, with
`updatedAt` within 2 h. For the `SessionStart` / `SessionEnd` overrides only, another
session counts when it had an event within **10 min** or is freshly `waiting`, so a
session that died without `SessionEnd` mutes `welcome` / `sleep` for at most 10 min.
*(Added after final review.)*

## Decision rules

Subagents *(added after use)*: hooks from settings files also fire inside subagents, and their
input carries `agent_id` (main-agent events, including `--agent` sessions, have none).
`animationForEvent` returns `null` for such events unless they are blocking (`isBlocking`) or
`SubagentStart`. They still run through the arbiter, so a subagent's events keep or clear the
session's `waiting` status (answering a subagent's prompt clears it) without posting.
`SubagentStop` keeps `waiting` (a subagent finishing is not an answer).

Ring once per job *(added after use)*: a background subagent's report-back starts a new
main-agent turn, so each one used to end in `Stop` → `ring`. A `Stop` while `agents` is
non-empty now posts nothing; the turn after the last `SubagentStop` rings.

On each event from session S:

1. Compute `anim` with `animationForEvent` (`src/map.js`, unchanged).
2. Session-aware overrides:
   - `SessionStart` with other live sessions → no request.
   - `SessionEnd` with other live sessions → no request. (The existing
     `clear`/`resume` skip still applies.)
3. Update S's state (status, `anim`, `updatedAt`; `oneShotUntil` if S posts a one-shot).
4. Filter — first matching row wins:

| # | Condition | Result |
| --- | --- | --- |
| 1 | This event set S to `waiting` (`PermissionRequest` or a blocking `Notification`) | post |
| 2 | Another live session is `waiting` (younger than 30 min) | skip |
| 3 | `anim` is a work animation (`typing`, `reading`, `thinking`) and another live session has `oneShotUntil > now` | skip |
| 4 | Otherwise | post |

One-shot protection windows (constants, approximate gesture lengths; tune on
hardware): `ring` 3 s, `welcome` 4 s, `abort` 4 s, `error` 4 s. One-shots from
different sessions replace each other normally; the newest wins.

`oneShotUntil` is written only when the one-shot is actually posted (not when
rule 2 skipped it). When S posts a non-one-shot, its `oneShotUntil` resets to `0`;
when S posts nothing, it keeps its previous value.

Single-session parity: rules 2–3 and the overrides in step 2 only look at *other*
sessions, so with one session every event yields upstream's result.

Edge cases:

- S is answered while session B is still `waiting`: rule 2 keeps skipping, the robot
  stays in `attention` (firmware returns to idle after its ~1 min waiting loop). No
  reminder is re-posted.
- `idle_prompt` posts nothing via the map: Claude Code sends it about a minute after a
  finished turn, which replayed `attention` right after `ring`. A session still `waiting`
  re-asks `attention` with it. It never blocks others. *(Changed after use.)*

## Error handling

The robot must never stall or break the agent.

- Any file system error (permissions, full disk, unreadable dir) → stateless
  fallback: post `anim` exactly as upstream.
- A corrupt or unparsable file of another session is ignored.
- Event without `session_id` → stateless fallback.
- Writes are atomic: write a temp file in the same dir, then `rename`.
- Read → decide → write of one session runs under `<session_id>.lock` (exclusive create,
  5 ms retry, 500 ms timeout → stateless fallback; a lock older than 2 s is taken over).
  *(Added after final review: concurrent hooks of one session lost `waiting` ~40% of the
  time without it.)*
- `SessionStart` with a source other than `startup` waits 300 ms before reading state, so
  the `SessionEnd` of the session it replaces (`/clear`, `/resume`) can remove its file
  first. *(Added after final review.)*
- `session_id` is restricted to `^[A-Za-z0-9_-]{1,128}$`; anything else → stateless fallback
  (prevents path traversal).
- Unchanged from upstream: no stdout in hook mode, 2 s HTTP timeout,
  `process.exit(0)` after a post.

## Testing

`node --test`, no dependencies.

- `test/map.test.js`, `test/env.test.js` — upstream, unchanged.
- `test/sessions.test.js` — temp dir via `TINY_ENGINEER_STATE_DIR`: round trip, 2 h prune,
  corrupt/temp files skipped, invalid `session_id` rejected, no partial file left.
- `test/arbiter.test.js` — every rule and override; single-session parity.
- `test/cli.test.js` — end-to-end against a local HTTP server: two-session scenario, event
  without `session_id`, unusable state dir, invalid `session_id`.
- `test/install.test.js` — add/remove/idempotency/legacy cleanup/foreign hooks preserved,
  command format (Windows path, `--url`), arg validation, temp `CLAUDE_CONFIG_DIR` runs
  (create, backup, invalid JSON aborts, dry run, uninstall), health check reachable and
  unreachable.

## Open assumption

`notification_type` on `Notification` payloads (`permission_prompt`, `idle_prompt`,
`elicitation_dialog`, …) — upstream's `test/map.test.js` already uses it. If it is missing,
`Notification` never sets `waiting`; `PermissionRequest` still covers permission prompts.

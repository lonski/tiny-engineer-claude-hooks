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

Options: `--mode <mode>` (see [Subagent mode](#subagent-mode)), `--dry-run` (show, don't write),
`--uninstall`, `--help`.

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

### Subagent mode

How subagents move the robot:

| Mode | Subagents |
| --- | --- |
| `working-subagents` (default) | `reading` / `typing` / `thinking` play like the main agent's |
| `muted-subagents` | Only the main agent works the robot; `SubagentStart` still plays `thinking` |

In both modes a subagent's permission prompt plays `attention`, its `error` / `abort` play
nothing, and the bell rings once, when the main agent is done.

Pick one, first match wins:

1. Bake it into the hooks: `node install.js --url http://<IP> --mode muted-subagents`
   (a later `node install.js` without `--mode` keeps it)
2. Claude Code settings (`~/.claude/settings.json`), for every session:
   `{ "env": { "TINY_ENGINEER_MODE": "muted-subagents" } }`
3. A project's `.env`, or the shell Claude Code starts from: `TINY_ENGINEER_MODE=muted-subagents`

`install.js` rejects an unknown `--mode`. The hooks never fail on one: an unknown
`TINY_ENGINEER_MODE` or baked `--mode` falls back to `working-subagents`.

## What the robot does

| Claude Code event | Animation |
| --- | --- |
| `SessionStart` (fresh launch) / other starts | `welcome` / `wakeup` |
| `SessionEnd` | `sleep` (skipped for `/clear` and `/resume`) |
| `UserPromptSubmit`, `PreToolUse` Read/Grep/Glob/WebFetch/WebSearch | `reading` |
| `PreToolUse` Bash/PowerShell/Edit/Write/NotebookEdit | `typing` |
| `SubagentStart`, `PostToolBatch`, `PreCompact` | `thinking` |
| `PermissionRequest`, `Notification` | `attention` |
| `Notification` `idle_prompt` (about 1 min after a finished turn) | (skip), unless a prompt is still waiting |
| `PermissionDenied` | `abort` |
| `PostToolUseFailure`, `StopFailure` | `error` |
| `SubagentStop` | (nothing; marks that subagent finished) |
| `Stop` | `ring`, once no background subagent is still running |

Hooks also fire inside subagents (their input carries `agent_id`). By default a subagent's
`reading`, `typing` and `thinking` play like the main agent's (switch with
[Subagent mode](#subagent-mode)), and its permission prompt plays `attention`; its `error` and
`abort` (failed or denied tool calls) play nothing. Subagents never ring.

The bell means the whole job is done. A turn that ends while background subagents are still
running plays nothing; each one reports back with a new turn, and the turn after the last one
rings. A subagent with no event for 10 min counts as finished, so a lost `SubagentStop` cannot
mute the bell for good. After updating from a version without `SubagentStop`, re-run
`node install.js` to add that hook.

## Multiple sessions

Each hook records its session in `~/.cache/tiny-engineer/claude-code/sessions/`
(override with `TINY_ENGINEER_STATE_DIR`) and checks the other sessions before posting:

- A session asking for permission keeps the robot in `attention`; other sessions' poses are
  skipped until you answer it. Inside the session each prompt belongs to the agent that asked
  (the main agent or a subagent): only its own answer closes it, and the other agents' poses are
  skipped too. Your next prompt, or the asking subagent ending, closes it as well. A
  subagent's prompt stays open however long the subagent waits on it.
- `ring`, `welcome`, `abort`, and `error` play to the end: no `typing` / `reading` / `thinking`
  cuts them short, whether from another session or the same one (a failed tool's next step,
  its subagents). `attention` and other one-shots still replace them.
- `welcome` / `wakeup` play only when no other session is running; `sleep` only when the last
  session ends.
- A session silent for 2 h counts as ended; a permission prompt older than 30 min stops blocking.

With one session, behavior is the same as upstream. Sessions on different computers do not
see each other.

### Known limitations

- Claude Code sends no hook when you approve a permission prompt, only when the tool finishes.
  While an approved long-running tool runs, that session still counts as waiting, so other
  sessions' poses (their bell too) are skipped until it finishes (at most 30 min).
- A session that ends without `SessionEnd` (closed terminal, crash) keeps `welcome` / `sleep`
  of other sessions quiet for up to 10 minutes.
- Hook processes of one session take a short per-session lock (`<session>.lock` in the state
  directory); a lock left behind by a killed hook is taken over after 2 s.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| Installer says robot not reachable | Same Wi-Fi/LAN as the robot? VPN off? Re-run with `--url http://<IP>`. The reason in parentheses comes from curl (macOS) or Node |
| Browser reaches the robot, Node gets `EHOSTUNREACH` | macOS local network privacy blocks some Node binaries. That is why requests on macOS go through `/usr/bin/curl`; on other systems they use Node's `fetch` |
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

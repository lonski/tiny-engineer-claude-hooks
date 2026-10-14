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

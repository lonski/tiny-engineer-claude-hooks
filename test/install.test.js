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
  assert.equal(
    hookCommand(BIN, "http://192.168.1.154", "muted-subagents"),
    `node "${BIN}" --url "http://192.168.1.154" --mode muted-subagents`
  );
  assert.equal(hookCommand(BIN, undefined, "muted-subagents"), `node "${BIN}" --mode muted-subagents`);
  assert.throws(() => hookCommand(BIN, undefined, "muted-subagents; rm -rf ~"), /invalid mode/);
});

test("parseInstallArgs validates --mode", () => {
  assert.equal(parseInstallArgs(["--mode", "muted-subagents"]).mode, "muted-subagents");
  assert.equal(parseInstallArgs(["--mode=working-subagents"]).mode, "working-subagents");
  assert.match(parseInstallArgs(["--mode"]).error, /requires a value/);
  assert.match(parseInstallArgs(["--mode", "loud"]).error, /--mode must be one of/);
});

test("parseInstallArgs reads flags and validates --url", () => {
  assert.deepEqual(parseInstallArgs([]), {
    url: undefined,
    mode: undefined,
    uninstall: false,
    dryRun: false,
    help: false,
  });
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

test("only Tiny Engineer hooks count as managed", () => {
  const userHooks = [
    { type: "command", command: "my-hook claude-code-lint" },
    { type: "command", command: "bash ~/tiny-engineer-claude-hooks/scripts/notify.sh" },
    { type: "command", command: "echo tiny-engineer-claude-code-notes" },
  ];
  const upstreamForms = [
    "npx -y tiny-engineer hook claude-code",
    "npx -y tiny-engineer@0.1.1 hook claude-code",
    "npx -y tiny-engineer-claude-code",
    'node "/x/packages/tiny-engineer-cli/bin/tiny-engineer.js" hook claude-code',
  ].map((command) => ({ type: "command", command }));
  const { settings, removed } = removeHooks({ hooks: { Stop: [{ hooks: [...userHooks, ...upstreamForms] }] } });
  assert.equal(removed, upstreamForms.length);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: userHooks }]);
});

test("refuses a clone path that a shell would mangle", async () => {
  const bad = [
    "/home/u/a $HOME b/bin/tiny-engineer-claude-hooks.js",
    '/home/u/"q"/bin/tiny-engineer-claude-hooks.js',
    "/home/u/`id`/bin/tiny-engineer-claude-hooks.js",
  ];
  for (const binPath of bad) {
    const dir = tempConfig();
    const errors = [];
    const code = await runInstall(["--dry-run"], {
      binPath,
      env: { CLAUDE_CONFIG_DIR: dir },
      log: () => {},
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1, binPath);
    assert.match(errors.join("\n"), /folder path/, binPath);
    assert.equal(existsSync(join(dir, "settings.json")), false, binPath);
  }
});

test("creates settings when missing and reports an unreachable robot", async () => {
  const dir = tempConfig();
  const url = await closedUrl();
  const { code, out } = await install(["--url", url], dir);
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
  const stop = readSettings(dir).hooks.Stop;
  assert.deepEqual(stop, [{ hooks: [{ type: "command", command: hookCommand(BIN, url), async: true }] }]);
  assert.match(out, /not reachable at \S+ \(.+\)\./);
});

test("--mode is baked into every hook and kept when re-run without it", async () => {
  const dir = tempConfig();
  const url = await closedUrl();
  const command = () => readSettings(dir).hooks.Stop[0].hooks[0].command;
  await install(["--url", url, "--mode", "muted-subagents"], dir);
  assert.equal(command(), hookCommand(BIN, url, "muted-subagents"));
  const { out } = await install(["--url", url], dir);
  assert.equal(command(), hookCommand(BIN, url, "muted-subagents"));
  assert.match(out, /Keeping --mode muted-subagents/);
  await install(["--url", url, "--mode", "working-subagents"], dir);
  assert.equal(command(), hookCommand(BIN, url, "working-subagents"));
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
  assert.match(out, /Would write 14 hooks/);
  assert.equal(existsSync(join(dir, "settings.json")), false);
});

test("uninstall removes managed hooks and keeps the rest", async () => {
  const dir = tempConfig();
  writeFileSync(join(dir, "settings.json"), '{"model":"opus"}');
  await install(["--url", await closedUrl()], dir);
  const { code, out } = await install(["--uninstall"], dir);
  assert.equal(code, 0);
  assert.match(out, /Removed 14 hook/);
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

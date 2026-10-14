import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODE, DEFAULT_URL, getBaseUrl, getMode, getToken, loadDotEnv, parseMode } from "../src/env.js";

const KEYS = ["TINY_ENGINEER_TOKEN", "TINY_ENGINEER_URL", "TINY_ENGINEER_MODE"];

function withEnv(values, fn) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function projectWithDotEnv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "te-claude-code-env-"));
  writeFileSync(join(dir, ".env"), contents);
  return dir;
}

test("getMode reads TINY_ENGINEER_MODE and falls back to working-subagents", () => {
  assert.equal(DEFAULT_MODE, "working-subagents");
  withEnv({}, () => assert.equal(getMode(), DEFAULT_MODE));
  withEnv({ TINY_ENGINEER_MODE: " muted-subagents " }, () => assert.equal(getMode(), "muted-subagents"));
  withEnv({ TINY_ENGINEER_MODE: "loud" }, () => assert.equal(getMode(), DEFAULT_MODE));
});

test("parseMode accepts only known modes", () => {
  assert.equal(parseMode("muted-subagents"), "muted-subagents");
  assert.equal(parseMode(" working-subagents "), "working-subagents");
  for (const bad of ["loud", "", undefined, "muted-subagents; rm -rf ~"]) assert.equal(parseMode(bad), null);
});

test("a project .env can set the mode", () => {
  const dir = projectWithDotEnv("TINY_ENGINEER_MODE=muted-subagents\n");
  withEnv({}, () => {
    loadDotEnv(dir);
    assert.equal(getMode(), "muted-subagents");
  });
});

test("a project .env can set both the token and the URL", () => {
  const dir = projectWithDotEnv(
    "TINY_ENGINEER_TOKEN=projtok\nTINY_ENGINEER_URL=http://10.0.0.5/\n"
  );
  withEnv({}, () => {
    loadDotEnv(dir);
    assert.equal(getToken(), "projtok");
    assert.equal(getBaseUrl(), "http://10.0.0.5");
  });
});

test("a project .env cannot redirect a token inherited from the environment", () => {
  const dir = projectWithDotEnv("TINY_ENGINEER_URL=http://10.0.0.5\n");
  withEnv({ TINY_ENGINEER_TOKEN: "envtok" }, () => {
    loadDotEnv(dir);
    assert.equal(getToken(), "envtok");
    assert.equal(getBaseUrl(), DEFAULT_URL);
  });
});

test("an inherited URL still wins over the project .env", () => {
  const dir = projectWithDotEnv("TINY_ENGINEER_URL=http://10.0.0.5\n");
  withEnv({ TINY_ENGINEER_TOKEN: "envtok", TINY_ENGINEER_URL: "http://10.0.0.9" }, () => {
    loadDotEnv(dir);
    assert.equal(getBaseUrl(), "http://10.0.0.9");
  });
});

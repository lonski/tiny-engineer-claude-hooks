import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { CURL, curlInvocation, robotRequest } from "../src/post.js";

const TRANSPORTS = existsSync(CURL) ? ["fetch", "curl"] : ["fetch"];

/**
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler
 */
async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { requests, url, close };
}

for (const transport of TRANSPORTS) {
  test(`${transport}: GET resolves status and body`, async () => {
    const server = await startServer((req, res) => res.end('{"version":"v0.2.0"}\n'));
    try {
      const result = await robotRequest(`${server.url}/`, "/health", { transport });
      assert.deepEqual(result, { status: 200, body: '{"version":"v0.2.0"}\n' });
      assert.deepEqual(server.requests, [{ method: "GET", url: "/health", authorization: undefined }]);
    } finally {
      await server.close();
    }
  });

  test(`${transport}: POST sends the Bearer token intact`, async () => {
    const server = await startServer((req, res) => res.end());
    const token = 'a"b\\c d';
    try {
      await robotRequest(server.url, "/anim?name=ring", { method: "POST", token, transport });
      assert.deepEqual(server.requests, [{ method: "POST", url: "/anim?name=ring", authorization: `Bearer ${token}` }]);
    } finally {
      await server.close();
    }
  });

  test(`${transport}: a non-2xx answer resolves with its status`, async () => {
    const server = await startServer((req, res) => {
      res.statusCode = 401;
      res.end("no");
    });
    try {
      assert.deepEqual(await robotRequest(server.url, "/health", { transport }), { status: 401, body: "no" });
    } finally {
      await server.close();
    }
  });

  test(`${transport}: rejects when nothing listens`, async () => {
    const server = await startServer(() => {});
    await server.close();
    await assert.rejects(robotRequest(server.url, "/health", { transport }));
  });

  test(`${transport}: rejects after the timeout`, async () => {
    const server = await startServer(() => {});
    try {
      const started = Date.now();
      await assert.rejects(robotRequest(server.url, "/health", { timeoutMs: 200, transport }));
      assert.ok(Date.now() - started < 1500, "gave up late");
    } finally {
      await server.close();
    }
  });
}

test("curlInvocation keeps the token out of argv and ignores .curlrc and proxies", () => {
  const { args, input } = curlInvocation("http://robot/anim?name=ring", {
    method: "POST",
    token: "secret",
    timeoutMs: 2000,
  });
  assert.equal(args[0], "-q");
  assert.ok(args.includes("--noproxy"));
  assert.ok(!args.some((arg) => arg.includes("secret")));
  assert.match(input, /secret/);
  assert.equal(curlInvocation("http://robot/health", { method: "GET", token: null, timeoutMs: 2000 }).input, "");
});

test("curlInvocation rejects a token that would inject a header", () => {
  assert.throws(() => curlInvocation("http://robot/", { method: "GET", token: "a\nX-Evil: 1", timeoutMs: 2000 }));
});

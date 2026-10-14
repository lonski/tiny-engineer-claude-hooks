import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const CURL = "/usr/bin/curl";

// macOS local network privacy can refuse LAN connections from a node binary
// (EHOSTUNREACH) even when the terminal is allowed, while Apple's own curl gets
// through. So on macOS requests go through curl; elsewhere through fetch.
function defaultTransport() {
  return process.platform === "darwin" && existsSync(CURL) ? "curl" : "fetch";
}

/**
 * curl arguments and stdin config for one request. The token travels on stdin,
 * not argv, so it never shows in `ps`.
 * @param {string} url
 * @param {{ method: string, token: string | null, timeoutMs: number }} options
 * @returns {{ args: string[], input: string }}
 */
export function curlInvocation(url, { method, token, timeoutMs }) {
  // -q must come first: it skips ~/.curlrc. --noproxy matches fetch, which
  // ignores proxy env vars.
  const args = ["-q", "-sS", "--noproxy", "*", "--request", method, "--max-time", String(timeoutMs / 1000)];
  args.push("--write-out", "\n%{http_code}");
  if (!token) return { args: [...args, "--url", url], input: "" };

  if (/[\r\n]/.test(token)) throw new Error("Token must not contain line breaks");
  const quoted = token.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return {
    args: [...args, "--config", "-", "--url", url],
    input: `header = "Authorization: Bearer ${quoted}"\n`,
  };
}

/**
 * @param {string} url
 * @param {{ method: string, token: string | null, timeoutMs: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function curlRequest(url, options) {
  const { args, input } = curlInvocation(url, options);
  return new Promise((resolve, reject) => {
    // curl's --max-time should end it first; the kill is a backstop.
    const child = execFile(CURL, args, { timeout: options.timeoutMs + 1000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      const split = stdout.lastIndexOf("\n");
      resolve({ status: Number(stdout.slice(split + 1)), body: stdout.slice(0, split) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * @param {string} url
 * @param {{ method: string, token: string | null, timeoutMs: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
async function fetchRequest(url, { method, token, timeoutMs }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.text() };
}

/**
 * Request against the robot: joins base URL and path and adds the Bearer token
 * when set. Resolves with any HTTP status; rejects when the robot does not answer.
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ method?: string, token?: string | null, timeoutMs?: number, transport?: "curl" | "fetch" }} [options]
 * @returns {Promise<{ status: number, body: string }>}
 */
export function robotRequest(
  baseUrl,
  path,
  { method = "GET", token = null, timeoutMs = 2000, transport = defaultTransport() } = {},
) {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const send = transport === "curl" ? curlRequest : fetchRequest;
  return send(url, { method, token, timeoutMs });
}

/**
 * POST /anim?name=… with a 2s timeout. Errors are swallowed.
 * @param {string} baseUrl
 * @param {string} animName
 * @param {string | null} [token]
 */
export async function postAnim(baseUrl, animName, token = null) {
  try {
    await robotRequest(baseUrl, `/anim?name=${encodeURIComponent(animName)}`, { method: "POST", token });
  } catch {
    // Robot offline / timeout — never stall the agent.
  }
}

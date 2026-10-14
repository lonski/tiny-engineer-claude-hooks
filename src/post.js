/**
 * fetch() against the robot: joins base URL and path and adds the Bearer token when set.
 * @param {string} baseUrl
 * @param {string} path
 * @param {RequestInit} init
 * @param {string | null} [token]
 */
export function robotFetch(baseUrl, path, init, token = null) {
  const headers = { ...init.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, { ...init, headers });
}

/**
 * POST /anim?name=… with a 2s timeout. Errors are swallowed.
 * @param {string} baseUrl
 * @param {string} animName
 * @param {string | null} [token]
 */
export async function postAnim(baseUrl, animName, token = null) {
  try {
    await robotFetch(
      baseUrl,
      `/anim?name=${encodeURIComponent(animName)}`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
      token,
    );
  } catch {
    // Robot offline / timeout — never stall the agent.
  }
}

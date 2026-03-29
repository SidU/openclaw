/**
 * Retry helper for API calls that may fail due to expired tokens.
 *
 * MSAL (used by the Teams SDK) caches tokens and applies a clock-skew buffer,
 * but a token can still expire between the moment it is fetched and the moment
 * the HTTP response arrives. This helper retries once on HTTP 401 with a
 * freshly acquired token.
 */

/**
 * Execute a fetch-style request with a single 401-retry using a fresh token.
 *
 * On the first attempt the current token (from `getToken`) is passed to
 * `doFetch`. If the response status is 401 a fresh token is requested and the
 * call is retried exactly once. Any other status (including 403) is returned
 * as-is because 403 typically means insufficient permissions, not an expired
 * token.
 */
export async function fetchWithTokenRetry(params: {
  getToken: () => Promise<string>;
  doFetch: (token: string) => Promise<Response>;
}): Promise<Response> {
  const token = await params.getToken();
  const res = await params.doFetch(token);
  if (res.status !== 401) {
    return res;
  }
  // Token may have been stale — request a fresh one and retry once.
  const freshToken = await params.getToken();
  return await params.doFetch(freshToken);
}

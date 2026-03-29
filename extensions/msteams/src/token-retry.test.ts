import { describe, expect, it, vi } from "vitest";
import { fetchWithTokenRetry } from "./token-retry.js";

describe("fetchWithTokenRetry", () => {
  it("returns the response on success without retrying", async () => {
    const getToken = vi.fn(async () => "token-a");
    const doFetch = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = await fetchWithTokenRetry({ getToken, doFetch });

    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenCalledOnce();
    expect(doFetch).toHaveBeenCalledOnce();
    expect(doFetch).toHaveBeenCalledWith("token-a");
  });

  it("retries once with a fresh token on 401", async () => {
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");

    const doFetch = vi
      .fn<(token: string) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "1" }), { status: 200 }));

    const res = await fetchWithTokenRetry({ getToken, doFetch });

    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(doFetch).toHaveBeenNthCalledWith(1, "stale-token");
    expect(doFetch).toHaveBeenNthCalledWith(2, "fresh-token");
  });

  it("returns 401 if retry also fails with 401", async () => {
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stale-1")
      .mockResolvedValueOnce("stale-2");

    const doFetch = vi
      .fn<(token: string) => Promise<Response>>()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const res = await fetchWithTokenRetry({ getToken, doFetch });

    expect(res.status).toBe(401);
    // Should only retry once (2 total calls), not loop
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 403 (insufficient permissions, not expired token)", async () => {
    const getToken = vi.fn(async () => "valid-token");
    const doFetch = vi.fn(async () => new Response("Forbidden", { status: 403 }));

    const res = await fetchWithTokenRetry({ getToken, doFetch });

    expect(res.status).toBe(403);
    expect(getToken).toHaveBeenCalledOnce();
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("does not retry on 500 (server error)", async () => {
    const getToken = vi.fn(async () => "valid-token");
    const doFetch = vi.fn(async () => new Response("Server Error", { status: 500 }));

    const res = await fetchWithTokenRetry({ getToken, doFetch });

    expect(res.status).toBe(500);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("propagates fetch exceptions without retrying", async () => {
    const getToken = vi.fn(async () => "token");
    const doFetch = vi.fn(async () => {
      throw new Error("network failure");
    });

    await expect(fetchWithTokenRetry({ getToken, doFetch })).rejects.toThrow("network failure");
    expect(doFetch).toHaveBeenCalledOnce();
  });
});

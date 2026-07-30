import { describe, expect, it, vi } from "vitest";
import { HttpClient, responseJson } from "./http-client";

describe("HttpClient", () => {
  it("retries bounded idempotent failures but never retries writes", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(new Response("no", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    await expect(new HttpClient(get, 100).request("https://example.test", {}, { retries: 1 }))
      .resolves.toMatchObject({ status: 200 });
    expect(get).toHaveBeenCalledTimes(2);

    const put = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(new HttpClient(put, 100).request("https://example.test", { method: "PUT" }))
      .rejects.toMatchObject({ code: "offline" });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("turns deadlines and response classes into typed errors", async () => {
    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    await expect(new HttpClient(hanging, 5).request("https://example.test", {}, { retries: 0 }))
      .rejects.toMatchObject({ code: "timeout" });
    await expect(responseJson(new Response(JSON.stringify({ error: "sign in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }))).rejects.toMatchObject({ code: "auth", status: 401 });
    await expect(responseJson(new Response(JSON.stringify({ error: "topic branch required" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }))).rejects.toMatchObject({ code: "auth", status: 403 });
    await expect(responseJson(new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "2" },
    }))).rejects.toMatchObject({ code: "rate-limit", retryAfterMs: 2_000 });
  });
});

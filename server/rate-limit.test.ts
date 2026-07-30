import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { RequestRateLimiter, requestClientAddress } from "./rate-limit.js";

describe("request rate limiting", () => {
  it("uses a validated first forwarding address behind the Render proxy", () => {
    const request = {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
      socket: { remoteAddress: "10.0.0.3" },
    } as IncomingMessage;
    expect(requestClientAddress(request)).toBe("203.0.113.7");
    request.headers["x-forwarded-for"] = "not-an-ip";
    expect(requestClientAddress(request)).toBe("10.0.0.3");
    request.headers["x-forwarded-for"] = ["2001:db8::7, 2001:db8::2"];
    expect(requestClientAddress(request)).toBe("2001:db8::7");
    request.headers["x-forwarded-for"] = "203.0.113.7:443";
    expect(requestClientAddress(request)).toBe("10.0.0.3");
  });

  it("bounds retained clients and expires old windows", () => {
    const limiter = new RequestRateLimiter(2, 1_000, 3);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 1)).toBe(true);
    expect(limiter.allow("a", 2)).toBe(false);
    limiter.allow("b", 2);
    limiter.allow("c", 2);
    limiter.allow("d", 2);
    expect(limiter.size).toBe(3);
    expect(limiter.allow("a", 1_002)).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("remains bounded even when an empty identity is the oldest entry", () => {
    const limiter = new RequestRateLimiter(2, 1_000, 2);
    limiter.allow("", 1);
    limiter.allow("b", 1);
    limiter.allow("c", 1);
    expect(limiter.size).toBe(2);
  });
});

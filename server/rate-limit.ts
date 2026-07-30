import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

interface RateWindow {
  startedAt: number;
  count: number;
}

/** Resolve the original client behind Render's forwarding proxy, defensively. */
export function requestClientAddress(req: IncomingMessage): string {
  // Render's edge sets the first X-Forwarded-For item to the real client IP.
  // Accept only a bounded, syntactically valid address so arbitrary header text
  // cannot create unbounded or attacker-chosen limiter keys.
  const forwarded = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const candidate = forwarded?.split(",", 1)[0]?.trim();
  return candidate && candidate.length <= 64 && isIP(candidate)
    ? candidate
    : req.socket.remoteAddress ?? "unknown";
}

/** Fixed-window limiter with a hard cap on retained client identities. */
export class RequestRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private lastSweep = 0;

  constructor(
    private readonly limit = 180,
    private readonly windowMs = 60_000,
    private readonly maxClients = 4_096,
  ) {}

  allow(client: string, now = Date.now()): boolean {
    // Sweep once per window, not once per request after the map reaches its
    // cap. Repeated O(maxClients) scans at capacity would itself be a cheap CPU
    // denial-of-service. A new identity at capacity evicts one entry in O(1).
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    const current = this.windows.get(client);
    if (!current || now - current.startedAt >= this.windowMs) {
      if (this.windows.size >= this.maxClients) {
        const oldest = this.windows.keys().next().value as string | undefined;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.set(client, { startedAt: now, count: 1 });
      return true;
    }
    current.count++;
    return current.count <= this.limit;
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [client, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(client);
    }
  }
}

import { describe, expect, it } from "vitest";
import { RateLimits, clientAddress, retryAfterHeaders } from "../../src/lib/ratelimit.ts";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("clientAddress", () => {
  /**
   * `x-forwarded-for` is attacker-controlled in general - anyone can send the
   * header - and is only trustworthy because the platform in front of the app
   * overwrites it. Vercel's own header is set by the proxy and is never passed
   * through from the client, so it wins when both are present.
   */
  it("prefers the platform's own header over a client-supplied one", () => {
    const h = headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "1.1.1.1",
      "x-real-ip": "2.2.2.2",
    });
    expect(clientAddress(h)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to x-forwarded-for", () => {
    expect(clientAddress(headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "2.2.2.2",
    );
    expect(clientAddress(headers({ "x-forwarded-for": "1.1.1.1" }))).toBe("1.1.1.1");
  });

  it("takes the first entry of a forwarded chain", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.1, 10.0.0.2" }))).toBe(
      "198.51.100.9",
    );
  });

  /**
   * Unattributable traffic shares one budget rather than getting an unlimited
   * one each. Returning a unique value per request - or skipping the limit -
   * would make stripping the header the way around it.
   */
  it("buckets an address-less request under one shared key", () => {
    expect(clientAddress(headers({}))).toBe("unknown");
    expect(clientAddress(headers({ "x-forwarded-for": "   " }))).toBe("unknown");
    expect(clientAddress(headers({ "x-forwarded-for": "," }))).toBe("unknown");
  });
});

describe("retryAfterHeaders", () => {
  it("reports whole seconds until the window rolls over", () => {
    expect(retryAfterHeaders({ allowed: false, remaining: 0, retryAfterSeconds: 42 })).toEqual({
      "retry-after": "42",
      "x-ratelimit-remaining": "0",
    });
  });

  /**
   * `Retry-After: 0` invites an immediate retry, which is the opposite of what
   * a denial is asking for. HubSpot and the voice providers both honour this
   * header, so the floor is what turns a limit into actual backpressure.
   */
  it("never tells a caller to retry immediately", () => {
    expect(
      retryAfterHeaders({ allowed: false, remaining: 0, retryAfterSeconds: 0 })["retry-after"],
    ).toBe("1");
  });
});

describe("the configured limits", () => {
  it("are all positive, which the SQL function requires", () => {
    for (const [name, rule] of Object.entries(RateLimits)) {
      expect(rule.limit, name).toBeGreaterThan(0);
      expect(rule.windowSeconds, name).toBeGreaterThan(0);
    }
  });

  it("uses a distinct key namespace per rule, so budgets cannot collide", () => {
    const names = Object.values(RateLimits).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The per-account rule has to be narrower than the per-address one, or it
   * never binds: a distributed guess at one known address is exactly the case
   * the broad rule cannot see.
   */
  it("keeps the per-email login budget tighter than the per-IP one", () => {
    const perIpRate = RateLimits.loginPerIp.limit / RateLimits.loginPerIp.windowSeconds;
    const perEmailRate = RateLimits.loginPerEmail.limit / RateLimits.loginPerEmail.windowSeconds;
    expect(perEmailRate).toBeLessThan(perIpRate);
  });
});

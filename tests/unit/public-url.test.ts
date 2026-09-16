import { describe, it, expect, afterEach } from "vitest";
import { publicRequestUrl } from "@/lib/providers/voice/public-url";

/**
 * Twilio signs the absolute URL it called. Behind a tunnel or load balancer
 * that is not the URL this process receives, and comparing against the wrong
 * one rejects every genuine callback with what looks like a bad signature.
 */

const original = process.env.APP_URL;
afterEach(() => {
  if (original === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = original;
});

describe("publicRequestUrl", () => {
  it("rewrites the internal origin to the public one", () => {
    process.env.APP_URL = "https://example.trycloudflare.com";
    expect(publicRequestUrl("http://localhost:3001/api/webhooks/voice/twilio")).toBe(
      "https://example.trycloudflare.com/api/webhooks/voice/twilio",
    );
  });

  it("preserves the query string, which is part of what was signed", () => {
    process.env.APP_URL = "https://example.com";
    expect(
      publicRequestUrl("http://localhost:3001/api/webhooks/voice/twilio/twiml?callId=abc&turn=0"),
    ).toBe("https://example.com/api/webhooks/voice/twilio/twiml?callId=abc&turn=0");
  });

  it("tolerates a trailing slash on APP_URL rather than doubling it", () => {
    process.env.APP_URL = "https://example.com/";
    expect(publicRequestUrl("http://localhost:3001/api/health")).toBe("https://example.com/api/health");
  });

  it("falls back to the request URL when APP_URL is unset", () => {
    delete process.env.APP_URL;
    const url = "http://localhost:3001/api/webhooks/voice/twilio";
    expect(publicRequestUrl(url)).toBe(url);
  });

  it("ignores the forwarded host, which a caller could otherwise spoof", () => {
    // The basis is APP_URL because the worker minted the callback URL from it.
    // A header-derived origin would let an attacker choose the string the
    // signature is checked against.
    process.env.APP_URL = "https://real.example.com";
    expect(publicRequestUrl("http://attacker.example.net/api/webhooks/voice/twilio")).toBe(
      "https://real.example.com/api/webhooks/voice/twilio",
    );
  });
});

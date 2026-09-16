import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SIGNATURE_AGE_MS,
  hubspotSignatureV3,
  verifyHubSpotSignature,
} from "../../src/lib/integrations/hubspot-signature.ts";

const SECRET = "a-private-app-client-secret";
const URL = "https://calls.example.com/api/webhooks/hubspot/events";
const BODY = '[{"eventId":1,"portalId":12345678,"objectId":42,"subscriptionType":"contact.creation"}]';

function signed(overrides: Partial<{ body: string; url: string; method: string; at: number }> = {}) {
  const at = overrides.at ?? Date.now();
  const body = overrides.body ?? BODY;
  const url = overrides.url ?? URL;
  const method = overrides.method ?? "POST";

  return {
    headers: {
      "x-hubspot-signature-v3": hubspotSignatureV3({
        clientSecret: SECRET,
        method,
        url,
        rawBody: body,
        timestamp: String(at),
      }),
      "x-hubspot-request-timestamp": String(at),
    },
    body,
    url,
    method,
    at,
  };
}

describe("hubspotSignatureV3", () => {
  /**
   * Pinned against the documented algorithm rather than against our own
   * implementation: base64 of HMAC-SHA256 over method + uri + body +
   * timestamp. If this drifts, every callback from every client is rejected,
   * which looks like a credential problem and is not one.
   */
  it("is base64 HMAC-SHA256 over method + uri + body + timestamp", () => {
    const timestamp = "1700000000000";
    const expected = createHmac("sha256", SECRET)
      .update(`POST${URL}${BODY}${timestamp}`, "utf8")
      .digest("base64");

    expect(
      hubspotSignatureV3({
        clientSecret: SECRET,
        method: "POST",
        url: URL,
        rawBody: BODY,
        timestamp,
      }),
    ).toBe(expected);
  });

  it("uppercases the method, so a lowercase verb still verifies", () => {
    const timestamp = "1700000000000";
    expect(
      hubspotSignatureV3({ clientSecret: SECRET, method: "post", url: URL, rawBody: BODY, timestamp }),
    ).toBe(
      hubspotSignatureV3({ clientSecret: SECRET, method: "POST", url: URL, rawBody: BODY, timestamp }),
    );
  });
});

describe("verifyHubSpotSignature", () => {
  it("accepts a correctly signed request", () => {
    const s = signed();
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: s.url,
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    ["missing_signature", { "x-hubspot-request-timestamp": String(Date.now()) }],
    ["missing_timestamp", { "x-hubspot-signature-v3": "whatever" }],
    [
      "malformed_timestamp",
      { "x-hubspot-signature-v3": "whatever", "x-hubspot-request-timestamp": "not-a-number" },
    ],
  ])("rejects with %s", (reason, headers) => {
    const result = verifyHubSpotSignature({
      clientSecret: SECRET,
      method: "POST",
      url: URL,
      rawBody: BODY,
      headers,
    });
    expect(result).toEqual({ valid: false, reason });
  });

  it("rejects a signature older than the five-minute window, even though it verifies", () => {
    const old = Date.now() - (MAX_SIGNATURE_AGE_MS + 1_000);
    const s = signed({ at: old });

    // The signature itself is genuine - it is the age that disqualifies it,
    // which is what makes replay bounded.
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: s.url,
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "stale_timestamp" });
  });

  it("rejects a timestamp far in the future", () => {
    const s = signed({ at: Date.now() + MAX_SIGNATURE_AGE_MS + 1_000 });
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: s.url,
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "stale_timestamp" });
  });

  it("rejects a body changed after signing", () => {
    const s = signed();
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: s.url,
        rawBody: BODY.replace("42", "43"),
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  /**
   * The URL is signed material, so comparing against the internal address a
   * proxy forwarded to fails every request. This is the Twilio lesson repeated
   * for HubSpot, and the reason the route passes a URL built from APP_URL.
   */
  it("rejects when the URL differs from the one signed", () => {
    const s = signed();
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: "http://localhost:3000/api/webhooks/hubspot/events",
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects when the query string differs", () => {
    const s = signed({ url: `${URL}?campaign=abc` });
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: URL,
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects another client's secret", () => {
    const s = signed();
    expect(
      verifyHubSpotSignature({
        clientSecret: "a-different-clients-secret",
        method: s.method,
        url: s.url,
        rawBody: s.body,
        headers: s.headers,
      }),
    ).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("reads headers case-insensitively", () => {
    const s = signed();
    expect(
      verifyHubSpotSignature({
        clientSecret: SECRET,
        method: s.method,
        url: s.url,
        rawBody: s.body,
        headers: {
          "X-HubSpot-Signature-v3": s.headers["x-hubspot-signature-v3"],
          "X-HubSpot-Request-Timestamp": s.headers["x-hubspot-request-timestamp"],
        },
      }),
    ).toEqual({ valid: true });
  });
});

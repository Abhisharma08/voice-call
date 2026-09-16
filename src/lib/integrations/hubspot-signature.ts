import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HubSpot's v3 webhook signature.
 *
 * A private app's webhook cannot carry a bearer token - HubSpot posts it, and
 * HubSpot does not hold our credentials - so the signature *is* the
 * credential. It is what lets an endpoint with no session and no service token
 * trust that the `portalId` in the body names the client it claims to.
 *
 * The scheme, per HubSpot's own guide:
 *
 *   base64( HMAC-SHA256( clientSecret, method + uri + body + timestamp ) )
 *
 * carried in `X-HubSpot-Signature-v3`, with the timestamp in
 * `X-HubSpot-Request-Timestamp` and a five-minute freshness window.
 *
 * Three details are easy to get wrong and each one fails the same way - every
 * callback rejected, looking exactly like a wrong secret:
 *
 *   - the URI is the **full public URL including its query string**, not the
 *     path, and not the internal address this process sees behind a proxy.
 *   - the body is the **raw bytes as sent**. Re-serialising the parsed JSON
 *     changes key order and whitespace, and the signature is over the text.
 *   - the timestamp is part of the signed material *and* checked for
 *     freshness. Skipping the freshness check leaves a valid signature
 *     replayable forever.
 */

/** HubSpot's stated window. Older than this is refused even if it verifies. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export type SignatureFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

export type SignatureResult = { valid: true } | { valid: false; reason: SignatureFailure };

export function hubspotSignatureV3(args: {
  clientSecret: string;
  method: string;
  /** Full public URL, query string included, exactly as HubSpot called it. */
  url: string;
  rawBody: string;
  timestamp: string;
}): string {
  const material = `${args.method.toUpperCase()}${args.url}${args.rawBody}${args.timestamp}`;
  return createHmac("sha256", args.clientSecret).update(material, "utf8").digest("base64");
}

export function verifyHubSpotSignature(args: {
  clientSecret: string;
  method: string;
  url: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  now?: Date;
}): SignatureResult {
  const signature = header(args.headers, "x-hubspot-signature-v3");
  if (!signature) return { valid: false, reason: "missing_signature" };

  const timestamp = header(args.headers, "x-hubspot-request-timestamp");
  if (!timestamp) return { valid: false, reason: "missing_timestamp" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || sentAt <= 0) {
    return { valid: false, reason: "malformed_timestamp" };
  }

  // Absolute difference, not just "older than": a timestamp far in the future
  // is equally untrustworthy, and subtracting the other way would let one
  // through.
  const age = Math.abs((args.now?.getTime() ?? Date.now()) - sentAt);
  if (age > MAX_SIGNATURE_AGE_MS) return { valid: false, reason: "stale_timestamp" };

  const expected = hubspotSignatureV3({
    clientSecret: args.clientSecret,
    method: args.method,
    url: args.url,
    rawBody: args.rawBody,
    timestamp,
  });

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

function header(headers: Record<string, string | undefined>, name: string): string | null {
  // Node lowercases incoming header names, but this is also called with plain
  // objects in tests and from other adapters, so do not assume it.
  const direct = headers[name];
  if (direct?.trim()) return direct.trim();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value?.trim()) return value.trim();
  }
  return null;
}

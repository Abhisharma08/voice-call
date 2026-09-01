// The `/max` entry point, not the default. The default ships "min" metadata,
// which reports no line type and accepts numbers that are merely
// well-shaped - it calls +911234567890 valid even though Indian mobiles
// start 6-9. Full metadata is a larger bundle, but this only ever runs
// server-side, and the cost of being lenient here is dialling a stranger.
import { parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js/max";

/**
 * Phone normalisation (FR-011: "Normalize phone numbers to E.164 where
 * possible", FR-012: "Reject or quarantine leads without a callable phone
 * number").
 *
 * This uses libphonenumber-js rather than a hand-rolled regex on purpose. The
 * failure mode of getting this wrong is dialling a real person who is not the
 * lead, which is both a compliance problem (PRD 17.3) and the kind of thing a
 * regex over Indian mobile formats gets wrong quietly.
 */

export type PhoneRejection =
  | "missing"
  | "too_short"
  | "not_a_number"
  | "invalid_for_region"
  | "not_callable";

export type PhoneResult =
  | { ok: true; e164: string; country: string | undefined; last4: string }
  | { ok: false; reason: PhoneRejection; detail: string };

/**
 * `defaultCountry` comes from the campaign or tenant timezone configuration,
 * never from the lead payload - a lead that supplies its own country hint can
 * otherwise steer dialling to an unintended region.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry?: string): PhoneResult {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: false, reason: "missing", detail: "No phone number supplied" };
  }

  const cleaned = raw.trim();

  // Fewer than 7 digits cannot be a routable subscriber number anywhere.
  const digitCount = (cleaned.match(/\d/g) ?? []).length;
  if (digitCount < 7) {
    return { ok: false, reason: "too_short", detail: `Only ${digitCount} digits` };
  }

  let parsed;
  try {
    parsed = parsePhoneNumberWithError(cleaned, defaultCountry as CountryCode | undefined);
  } catch (err) {
    return {
      ok: false,
      reason: "not_a_number",
      detail: err instanceof Error ? err.message : "Unparseable",
    };
  }

  if (!parsed.isValid()) {
    return {
      ok: false,
      reason: "invalid_for_region",
      detail: `Not a valid number${parsed.country ? ` for ${parsed.country}` : ""}`,
    };
  }

  // FR-012 is about a *callable* number, not merely a well-formed one.
  // Voicemail, premium-rate and pager ranges are not leads we can qualify.
  const type = parsed.getType();
  if (type === "VOICEMAIL" || type === "PREMIUM_RATE" || type === "PAGER" || type === "SHARED_COST") {
    return { ok: false, reason: "not_callable", detail: `Number type is ${type}` };
  }

  const e164 = parsed.number;
  return {
    ok: true,
    e164,
    country: parsed.country,
    last4: e164.slice(-4),
  };
}

/** Canonical form for the email blind index. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

/** ISO country to a default calling region, for tenants that do not set one. */
export const DEFAULT_CALLING_COUNTRY = "IN";

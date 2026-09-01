-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — Dial allowlist, for trial provider accounts and staging.
--
-- Every voice provider's free trial restricts outbound calls to numbers you
-- have verified on the account. Twilio: "Outbound trial calls can only be
-- placed to a validated phone number." Sarvam requires KYC before a number can
-- be rented at all.
--
-- Pointed at a real lead list, a trial account therefore fails on every number
-- that is not the tester's own phone - burning an attempt from each lead's
-- retry budget and filling the queue with opaque provider errors. Worse, a
-- half-configured staging environment can attempt real people.
--
-- The allowlist mirrors the provider's own constraint inside the platform: when
-- it is non-empty, only those numbers may be dialled and everything else is
-- suppressed with a legible reason, before a call is placed. Empty means no
-- restriction, which is the production case.
-- ═══════════════════════════════════════════════════════════════════════════

alter table campaigns
  add column dial_allowlist text[] not null default '{}';

comment on column campaigns.dial_allowlist is
  'E.164 numbers this campaign may dial. Empty = unrestricted (production). '
  'Non-empty = only these, for a trial provider account whose outbound calls '
  'are limited to verified numbers, or for staging. Enforced in '
  'checkEligibility, so it applies at intake and again at claim time.';

-- Finding a lead suppressed for this reason should be obvious in the UI rather
-- than looking like a bug, so it gets its own status reason rather than being
-- folded into a generic failure.

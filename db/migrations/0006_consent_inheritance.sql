-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Consent captured upstream.
--
-- In the real operating model, consent is collected at the landing page or
-- Meta lead form and the lead is written to HubSpot before this platform ever
-- sees it. Requiring a second, manual consent step here was friction that
-- recorded nothing the funnel had not already established.
--
-- What is dropped is the *gate*. What is kept is the *record*: intake still
-- writes a consents row for every lead, now derived from where the lead came
-- from, so a call can still cite the specific basis it was placed under.
-- PRD 26.1 wants an evidentiary trail the agency owns; that is satisfied by
-- recording it automatically, not by blocking on a human to retype it.
--
-- The row is honest about its provenance: captured_by = 'inherited_upstream'
-- says the agency did not run the opt-in funnel and has not independently
-- verified it, which is a truer record than a blanket assertion.
-- ═══════════════════════════════════════════════════════════════════════════

create type consent_mode as enum ('require_record', 'inherit_from_source');

alter table campaigns
  add column consent_mode consent_mode not null default 'inherit_from_source';

comment on column campaigns.consent_mode is
  'inherit_from_source: consent was captured upstream (landing page, Meta lead '
  'form) and flows in with the lead; intake records it and never blocks. '
  'require_record: a lead may not be queued without an explicit active consents '
  'row, for lists whose provenance is not established upstream.';

-- Existing campaigns keep the stricter behaviour they were configured under.
-- Only campaigns created from here on inherit by default.
update campaigns set consent_mode = 'require_record';

-- The declared basis is no longer a precondition for compliance approval.
--
-- It was standing in for "somebody confirmed where these leads came from",
-- which the upstream funnel now answers. The compliance attestation itself
-- (PRD 17.3) still records what was reviewed, and that is the check that
-- actually matters before dialling.
alter table campaigns drop constraint campaigns_compliance_needs_consent_ck;

-- Where consent came from, when it is known. Free text rather than an enum:
-- "Meta lead form - Noida 2BHK campaign" is more useful to a human reading an
-- audit trail two years later than a code would be.
alter table campaigns
  add column consent_origin text;

comment on column campaigns.consent_origin is
  'Human-readable origin of consent for this list, e.g. "Meta lead form" or '
  '"landing page /noida-2bhk". Recorded on the consents row of every lead '
  'ingested for this campaign.';

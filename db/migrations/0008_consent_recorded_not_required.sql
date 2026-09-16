-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Consent is recorded, never required to dial.
--
-- 0006 made consent inheritance the default but kept `require_record` as an
-- alternative mode, and set every campaign that already existed to it. That
-- left the gate in place for exactly the campaigns that were already running,
-- so leads kept being suppressed as `no_consent` for a permission the funnel
-- had already collected.
--
-- Consent is collected at the landing page or lead form before the lead ever
-- reaches HubSpot, so there is no second permission for this platform to ask
-- for and nothing a human here could add to it. The mode goes away entirely:
-- intake records a consents row for every lead, and no lead is ever held back
-- for the absence of one.
--
-- What still stops a call is a *withdrawal* — an explicit opt-out or a DNC
-- request after the form. That is not the same permission as the one the form
-- collected, and it is not affected here.
-- ═══════════════════════════════════════════════════════════════════════════

alter table campaigns drop column consent_mode;
drop type consent_mode;

-- Leads the removed gate stranded. They were suppressed for a missing consent
-- record, not for anything the lead said, so they go back in the queue. A lead
-- on DNC, or one whose consent was withdrawn, stays suppressed.
update leads
   set status = 'queued',
       status_reason = null,
       queued_at = coalesce(queued_at, now()),
       next_call_at = now()
 where status = 'suppressed'
   and status_reason like 'no_consent%'
   and dnc = false
   and not exists (
     select 1 from consents c
      where c.lead_id = leads.id
        and c.status in ('withdrawn', 'expired'));

-- The declared basis is documentation now, not a precondition. Approvals that
-- 0005 revoked for lacking one are not restored here: a compliance sign-off is
-- a statement by a named person (PRD 17.3), so it has to be re-made by one.
comment on column campaigns.consent_basis is
  'Optional record of what the client asserted about this list. Documentation '
  'for the audit trail; it gates nothing. Consent itself is collected upstream '
  'in the lead form and recorded per lead at intake.';

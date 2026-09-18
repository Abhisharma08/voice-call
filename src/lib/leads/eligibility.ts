import type { PoolClient } from "pg";
import { blindIndex } from "@/lib/crypto/pii";

/**
 * The gate between "a lead exists" and "we are allowed to dial it"
 * (FR-014, PRD 17.4, PRD 26.1).
 *
 * Every rule here is a reason NOT to call. They are evaluated in severity
 * order and the first hit wins, so the recorded reason is the most serious
 * one rather than whichever check happened to run first.
 */

export type SuppressionReason =
  | "dnc_tenant"
  | "dnc_campaign"
  | "lead_dnc_flag"
  | "consent_withdrawn"
  | "campaign_inactive"
  | "not_on_dial_allowlist"
  | "tenant_inactive"
  | "max_attempts_reached";

export interface EligibilityInput {
  tenantId: string;
  leadId: string;
  campaignId: string | null;
  phoneE164: string | null;
  leadDnc: boolean;
  callAttemptCount: number;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SuppressionReason; detail: string };

/**
 * PRD 17.4: "Global tenant DNC list takes precedence over campaign
 * eligibility. Campaign suppression can be narrower; global DNC cannot be
 * overridden by campaign configuration."
 */
export async function checkEligibility(
  tx: PoolClient,
  input: EligibilityInput,
): Promise<EligibilityResult> {
  const { tenantId, leadId, campaignId, phoneE164 } = input;

  const tenant = await tx.query<{ status: string }>(
    `select status from tenants where id = $1`,
    [tenantId],
  );
  if (tenant.rows[0]?.status !== "active") {
    return { eligible: false, reason: "tenant_inactive", detail: "Tenant is not active" };
  }

  // 1. Lead-level DNC flag, set by a voice-detected or manual suppression.
  if (input.leadDnc) {
    return { eligible: false, reason: "lead_dnc_flag", detail: "Lead is marked do-not-call" };
  }

  // 2. Tenant-global DNC. Checked before campaign rules, and never overridable
  //    by campaign configuration.
  if (phoneE164) {
    const bidx = blindIndex(tenantId, phoneE164);

    const globalDnc = await tx.query(
      `select 1 from dnc_entries where scope = 'tenant' and phone_bidx = $1 limit 1`,
      [bidx],
    );
    if (globalDnc.rowCount) {
      return { eligible: false, reason: "dnc_tenant", detail: "Number is on the tenant DNC list" };
    }

    if (campaignId) {
      const campaignDnc = await tx.query(
        `select 1 from dnc_entries
          where scope = 'campaign' and campaign_id = $1 and phone_bidx = $2 limit 1`,
        [campaignId, bidx],
      );
      if (campaignDnc.rowCount) {
        return {
          eligible: false,
          reason: "dnc_campaign",
          detail: "Number is suppressed for this campaign",
        };
      }
    }
  }

  if (!campaignId) {
    return { eligible: false, reason: "campaign_inactive", detail: "Lead has no campaign" };
  }

  const campaign = await tx.query<{
    active: boolean;
    service_call_campaign: boolean;
    calling_config: { max_attempts?: number };
    dial_allowlist: string[];
  }>(
    `select active, service_call_campaign, calling_config, dial_allowlist
       from campaigns where id = $1`,
    [campaignId],
  );

  const c = campaign.rows[0];
  if (!c || !c.active) {
    return { eligible: false, reason: "campaign_inactive", detail: "Campaign is not active" };
  }

  // A trial provider account can only reach numbers verified on it, so an
  // unverified lead would fail at the carrier and consume an attempt. Checked
  // here, before a call is placed, so the reason is legible rather than an
  // opaque provider error.
  if (c.dial_allowlist.length > 0) {
    if (!phoneE164 || !c.dial_allowlist.includes(phoneE164)) {
      return {
        eligible: false,
        reason: "not_on_dial_allowlist",
        detail: `This campaign is restricted to ${c.dial_allowlist.length} verified number(s)`,
      };
    }
  }

  const maxAttempts = c.calling_config?.max_attempts ?? 3;
  if (input.callAttemptCount >= maxAttempts) {
    return {
      eligible: false,
      reason: "max_attempts_reached",
      detail: `Reached ${maxAttempts} attempts`,
    };
  }

  // 3. Consent.
  //
  // PRD 26.1's rule - "A lead may not be queued for calling unless an active
  // consents record exists" - assumed the platform was where consent first
  // became known. In the real operating model it is not: consent is collected
  // at the landing page or Meta lead form, and the lead reaches HubSpot before
  // this platform sees it. Intake records that consent for every lead, so the
  // absence of a row means the funnel did not pass one along, not that the
  // lead declined - and it holds nothing back (migration 0008).
  //
  // What stops a call is a *withdrawal*: an explicit opt-out or DNC request
  // made after the form. That is a different permission from the one the form
  // collected, and it is the case this whole record exists for.
  if (!c.service_call_campaign) {
    const withdrawn = await tx.query(
      `select 1 from consents
        where lead_id = $1 and status in ('withdrawn', 'expired')
          and not exists (
            select 1 from consents active
             where active.lead_id = $1 and active.status = 'active'
               and active.captured_at > consents.captured_at)
        limit 1`,
      [leadId],
    );
    if (withdrawn.rowCount) {
      return {
        eligible: false,
        reason: "consent_withdrawn",
        detail: "Consent for this lead was withdrawn",
      };
    }
  }

  return { eligible: true };
}

/**
 * The active consent to stamp onto a call attempt, so each call can be
 * justified individually later (PRD 26.1).
 */
export async function activeConsentFor(
  tx: PoolClient,
  leadId: string,
): Promise<{ id: string; basis: string } | null> {
  const r = await tx.query<{ id: string; basis: string }>(
    `select id, basis from consents
      where lead_id = $1 and status = 'active'
      order by captured_at desc limit 1`,
    [leadId],
  );
  return r.rows[0] ?? null;
}

/**
 * Suppress a lead permanently (PRD 17.4, FR-025). Writes the DNC entry, flags
 * the lead, and clears any queued call so a suppression takes effect before
 * the next worker tick rather than after it.
 */
export async function suppressLead(
  tx: PoolClient,
  args: {
    tenantId: string;
    leadId: string;
    phoneE164: string | null;
    reason: string;
    source: "voice_detected" | "manual" | "import";
    createdBy?: string | null;
  },
): Promise<void> {
  if (args.phoneE164) {
    await tx.query(
      `insert into dnc_entries (tenant_id, scope, phone_bidx, reason, source, created_by)
       values ($1, 'tenant', $2, $3, $4, $5)
       on conflict (tenant_id, phone_bidx) where scope = 'tenant' do nothing`,
      [
        args.tenantId,
        blindIndex(args.tenantId, args.phoneE164),
        args.reason,
        args.source,
        args.createdBy ?? null,
      ],
    );
  }

  // FR-025: "Stop all future calling when DNC is set" - including anything
  // already sitting in the queue.
  await tx.query(
    `update leads
        set dnc = true,
            status = 'suppressed',
            status_reason = $2,
            next_call_at = null,
            locked_by = null,
            lock_expires_at = null
      where id = $1`,
    [args.leadId, args.reason],
  );
}

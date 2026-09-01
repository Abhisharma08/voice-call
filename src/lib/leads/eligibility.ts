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
  | "no_consent"
  | "consent_withdrawn"
  | "campaign_inactive"
  | "campaign_not_compliance_approved"
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
    compliance_approved_at: Date | null;
    calling_config: { max_attempts?: number };
  }>(
    `select active, service_call_campaign, compliance_approved_at, calling_config
       from campaigns where id = $1`,
    [campaignId],
  );

  const c = campaign.rows[0];
  if (!c || !c.active) {
    return { eligible: false, reason: "campaign_inactive", detail: "Campaign is not active" };
  }

  // PRD 17.3: "Do not activate India outbound campaigns until a
  // telecom/compliance review confirms..." Phase 0 added the column; this is
  // the check that actually stops a call being placed without it.
  if (!c.compliance_approved_at) {
    return {
      eligible: false,
      reason: "campaign_not_compliance_approved",
      detail: "Campaign has not passed compliance review (PRD 17.3)",
    };
  }

  const maxAttempts = c.calling_config?.max_attempts ?? 3;
  if (input.callAttemptCount >= maxAttempts) {
    return {
      eligible: false,
      reason: "max_attempts_reached",
      detail: `Reached ${maxAttempts} attempts`,
    };
  }

  // 3. Consent. PRD 26.1: "A lead may not be queued for calling unless an
  //    active consents record exists for it, or the campaign is explicitly
  //    flagged as service-call/existing-relationship."
  if (!c.service_call_campaign) {
    const consent = await tx.query<{ status: string }>(
      `select status from consents
        where lead_id = $1 and status = 'active'
        order by captured_at desc limit 1`,
      [leadId],
    );

    if (!consent.rowCount) {
      const anyConsent = await tx.query<{ status: string }>(
        `select status from consents where lead_id = $1 order by captured_at desc limit 1`,
        [leadId],
      );
      const previous = anyConsent.rows[0];

      return previous
        ? {
            eligible: false,
            reason: "consent_withdrawn",
            detail: `Most recent consent is ${previous.status}`,
          }
        : {
            eligible: false,
            reason: "no_consent",
            detail: "No active consent record for this lead (PRD 26.1)",
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

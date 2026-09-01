import type { PoolClient } from "pg";
import { blindIndex, encryptPiiOrNull } from "@/lib/crypto/pii";
import { DEFAULT_CALLING_COUNTRY, normalizeEmail, normalizePhone } from "@/lib/phone";
import { checkEligibility } from "@/lib/leads/eligibility";
import { auditInTx } from "@/lib/audit";

/**
 * Lead intake (FR-010 to FR-014), the platform half of n8n workflow W01.
 *
 * Order matters and follows PRD 7.1: validate and normalise, resolve the
 * campaign, check consent/DNC, then queue. A lead that fails any step is
 * persisted with the reason rather than dropped - PRD FR-012 requires the
 * reason be recorded, and an invisible rejection is impossible to debug when a
 * client asks why their lead was never called.
 */

export interface IntakeEvent {
  tenantId: string;
  campaignId: string | null;
  source: string;
  recordId: string | null;
  contact: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  /**
   * Consent as supplied by the client (PRD 26.1). The agency did not run the
   * client's opt-in funnel, so this is a claim to be recorded as evidence, not
   * a fact to be trusted.
   */
  consent?: {
    basis: "opt_in_form" | "existing_customer" | "service_call" | "ivr_confirmation" | "other";
    source: string;
    evidenceRef?: string | null;
    capturedAt?: string | null;
  } | null;
  correlationId?: string | null;
}

export type IntakeOutcome =
  | { status: "queued"; leadId: string; duplicate: boolean }
  | { status: "quarantined"; leadId: string; reason: string; detail: string }
  | { status: "suppressed"; leadId: string; reason: string; detail: string }
  | { status: "duplicate_ignored"; leadId: string };

export async function ingestLead(tx: PoolClient, event: IntakeEvent): Promise<IntakeOutcome> {
  const { tenantId } = event;

  const campaign = event.campaignId
    ? (
        await tx.query<{
          id: string;
          timezone: string;
          calling_config: { country?: string };
          consent_basis: string | null;
          consent_source: string | null;
          consent_evidence_ref: string | null;
          consent_mode: "require_record" | "inherit_from_source";
          consent_origin: string | null;
        }>(
          `select id, timezone, calling_config,
                  consent_basis, consent_source, consent_evidence_ref,
                  consent_mode, consent_origin
             from campaigns where id = $1`,
          [event.campaignId],
        )
      ).rows[0] ?? null
    : null;

  // The dialling region comes from campaign configuration, never from the
  // inbound payload.
  const defaultCountry = campaign?.calling_config?.country ?? DEFAULT_CALLING_COUNTRY;

  const phone = normalizePhone(event.contact.phone, defaultCountry);
  const email = normalizeEmail(event.contact.email);

  const phoneE164 = phone.ok ? phone.e164 : null;
  const phoneBidx = phoneE164 ? blindIndex(tenantId, phoneE164) : null;
  const emailBidx = email ? blindIndex(tenantId, email) : null;

  // FR-013: "Deduplicate by tenant + source record ID and secondary
  // phone/email rules."
  const existing = await findExisting(tx, {
    tenantId,
    recordId: event.recordId,
    phoneBidx,
    emailBidx,
  });

  const leadId = existing
    ? await updateLead(tx, existing.id, event, { phone, phoneBidx, email, emailBidx })
    : await insertLead(tx, event, { phone, phoneBidx, email, emailBidx, defaultCountry });

  // Consent is recorded, not demanded.
  //
  // In the real funnel it is collected at the landing page or Meta lead form
  // and the lead reaches HubSpot before this platform sees it, so there is
  // nothing here to ask a human for. Three sources, most specific first:
  //
  //   1. consent that arrived with the event (HubSpot properties, form fields)
  //   2. the basis the Campaign Manager recorded for this list
  //   3. inference from where the lead came from, on inherit_from_source
  //      campaigns
  //
  // The third is the common path now, and the row it writes says
  // `inherited_upstream` - an honest label. The agency did not run the opt-in
  // funnel and has not independently verified it, and a record that says so is
  // worth more than one that overstates.
  const { consent, capturedBy } = resolveConsent(event, campaign);
  if (consent) {
    await recordConsent(tx, tenantId, leadId, consent, capturedBy);
  }

  // FR-012: no callable number means quarantine, with the reason recorded and
  // no call placed.
  if (!phone.ok) {
    await tx.query(
      `update leads set status = 'quarantined', status_reason = $2, next_call_at = null
        where id = $1`,
      [leadId, `${phone.reason}: ${phone.detail}`],
    );
    await auditInTx(tx, {
      tenantId,
      actorType: "service",
      action: "lead.quarantined",
      entityType: "lead",
      entityId: leadId,
      metadata: { reason: phone.reason, detail: phone.detail },
    });
    return { status: "quarantined", leadId, reason: phone.reason, detail: phone.detail };
  }

  // A lead already in a terminal or in-flight state must not be re-queued by a
  // duplicate webhook (FR-013: "Duplicate event does not create duplicate call").
  if (existing && !isRequeueable(existing.status)) {
    return { status: "duplicate_ignored", leadId };
  }

  const eligibility = await checkEligibility(tx, {
    tenantId,
    leadId,
    campaignId: event.campaignId,
    phoneE164,
    leadDnc: existing?.dnc ?? false,
    callAttemptCount: existing?.call_attempt_count ?? 0,
  });

  if (!eligibility.eligible) {
    await tx.query(
      `update leads set status = 'suppressed', status_reason = $2, next_call_at = null
        where id = $1`,
      [leadId, `${eligibility.reason}: ${eligibility.detail}`],
    );
    await auditInTx(tx, {
      tenantId,
      actorType: "service",
      action: "lead.suppressed",
      entityType: "lead",
      entityId: leadId,
      metadata: { reason: eligibility.reason, detail: eligibility.detail },
    });
    return {
      status: "suppressed",
      leadId,
      reason: eligibility.reason,
      detail: eligibility.detail,
    };
  }

  // FR-020: eligible leads are queued. G2 targets p95 under 30 seconds from
  // CRM ingestion, so next_call_at is now and the calling window is applied by
  // the worker rather than deferring here.
  await tx.query(
    `update leads
        set status = 'queued',
            status_reason = null,
            queued_at = now(),
            next_call_at = coalesce(next_call_at, now()),
            correlation_id = coalesce($2, correlation_id)
      where id = $1`,
    [leadId, event.correlationId ?? null],
  );

  await auditInTx(tx, {
    tenantId,
    actorType: "service",
    action: "lead.queued",
    entityType: "lead",
    entityId: leadId,
    metadata: { duplicate: Boolean(existing), source: event.source },
  });

  return { status: "queued", leadId, duplicate: Boolean(existing) };
}

/** Statuses from which a fresh inbound event may legitimately re-queue a lead. */
function isRequeueable(status: string): boolean {
  return ["new", "quarantined", "failed", "closed"].includes(status);
}

interface NormalizedContact {
  phone: ReturnType<typeof normalizePhone>;
  phoneBidx: string | null;
  email: string | null;
  emailBidx: string | null;
  defaultCountry?: string;
}

async function findExisting(
  tx: PoolClient,
  args: { tenantId: string; recordId: string | null; phoneBidx: string | null; emailBidx: string | null },
): Promise<{ id: string; status: string; dnc: boolean; call_attempt_count: number } | null> {
  // Primary key for dedupe is the CRM record id; phone and email are the
  // secondary rules, in that order.
  const clauses: Array<{ sql: string; params: unknown[] }> = [];
  if (args.recordId) clauses.push({ sql: `hubspot_record_id = $1`, params: [args.recordId] });
  if (args.phoneBidx) clauses.push({ sql: `phone_bidx = $1`, params: [args.phoneBidx] });
  if (args.emailBidx) clauses.push({ sql: `email_bidx = $1`, params: [args.emailBidx] });

  for (const clause of clauses) {
    const r = await tx.query<{ id: string; status: string; dnc: boolean; call_attempt_count: number }>(
      `select id, status, dnc, call_attempt_count from leads where ${clause.sql} limit 1`,
      clause.params,
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function insertLead(
  tx: PoolClient,
  event: IntakeEvent,
  n: NormalizedContact,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into leads
       (tenant_id, campaign_id, hubspot_record_id, source,
        name_enc, phone_enc, email_enc, phone_bidx, email_bidx,
        phone_last4, phone_country, status, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'new', $12)
     returning id`,
    [
      event.tenantId,
      event.campaignId,
      event.recordId,
      event.source,
      encryptPiiOrNull(event.contact.name),
      encryptPiiOrNull(n.phone.ok ? n.phone.e164 : event.contact.phone),
      encryptPiiOrNull(n.email),
      n.phoneBidx,
      n.emailBidx,
      n.phone.ok ? n.phone.last4 : null,
      n.phone.ok ? n.phone.country ?? null : null,
      event.correlationId ?? null,
    ],
  );

  const row = r.rows[0];
  if (!row) throw new Error("Failed to insert lead");
  return row.id;
}

async function updateLead(
  tx: PoolClient,
  leadId: string,
  event: IntakeEvent,
  n: NormalizedContact,
): Promise<string> {
  // coalesce so a sparse re-delivery cannot blank out fields we already hold.
  await tx.query(
    `update leads set
        campaign_id       = coalesce($2, campaign_id),
        hubspot_record_id = coalesce($3, hubspot_record_id),
        name_enc          = coalesce($4, name_enc),
        phone_enc         = coalesce($5, phone_enc),
        email_enc         = coalesce($6, email_enc),
        phone_bidx        = coalesce($7, phone_bidx),
        email_bidx        = coalesce($8, email_bidx),
        phone_last4       = coalesce($9, phone_last4),
        phone_country     = coalesce($10, phone_country)
      where id = $1`,
    [
      leadId,
      event.campaignId,
      event.recordId,
      encryptPiiOrNull(event.contact.name),
      encryptPiiOrNull(n.phone.ok ? n.phone.e164 : null),
      encryptPiiOrNull(n.email),
      n.phoneBidx,
      n.emailBidx,
      n.phone.ok ? n.phone.last4 : null,
      n.phone.ok ? n.phone.country ?? null : null,
    ],
  );
  return leadId;
}

type ConsentProvenance = "client_supplied" | "campaign_declaration" | "inherited_upstream";

interface CampaignConsent {
  consent_basis: string | null;
  consent_source: string | null;
  consent_evidence_ref: string | null;
  consent_mode: "require_record" | "inherit_from_source";
  consent_origin: string | null;
}

function resolveConsent(
  event: IntakeEvent,
  campaign: CampaignConsent | null,
): { consent: NonNullable<IntakeEvent["consent"]> | null; capturedBy: ConsentProvenance } {
  if (event.consent) {
    return { consent: event.consent, capturedBy: "client_supplied" };
  }

  if (campaign?.consent_basis) {
    return {
      consent: {
        basis: campaign.consent_basis as NonNullable<IntakeEvent["consent"]>["basis"],
        source: campaign.consent_source ?? campaign.consent_origin ?? "campaign_declaration",
        evidenceRef: campaign.consent_evidence_ref ?? null,
        capturedAt: null,
      },
      capturedBy: "campaign_declaration",
    };
  }

  if (campaign?.consent_mode === "inherit_from_source") {
    // Nobody typed this in. It names the funnel the lead came through, which
    // is the most specific true thing available: "meta_lead_form",
    // "landing_page_form", or whatever the source field carried.
    return {
      consent: {
        basis: "opt_in_form",
        source: campaign.consent_origin ?? event.source ?? "upstream_form",
        evidenceRef: event.recordId ? `${event.source}:${event.recordId}` : null,
        capturedAt: null,
      },
      capturedBy: "inherited_upstream",
    };
  }

  return { consent: null, capturedBy: "campaign_declaration" };
}

async function recordConsent(
  tx: PoolClient,
  tenantId: string,
  leadId: string,
  consent: NonNullable<IntakeEvent["consent"]>,
  capturedBy: ConsentProvenance,
): Promise<void> {
  // PRD 26.1: the agency needs its own evidentiary trail rather than an
  // unverified assumption inherited from the client at intake.
  const existing = await tx.query(
    `select 1 from consents where lead_id = $1 and status = 'active' limit 1`,
    [leadId],
  );
  if (existing.rowCount) return;

  await tx.query(
    `insert into consents (tenant_id, lead_id, basis, source, evidence_ref, captured_at, captured_by)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7)`,
    [
      tenantId,
      leadId,
      consent.basis,
      consent.source,
      consent.evidenceRef ?? null,
      consent.capturedAt ?? null,
      capturedBy,
    ],
  );

  await auditInTx(tx, {
    tenantId,
    actorType: "service",
    action: "consent.recorded",
    entityType: "lead",
    entityId: leadId,
    metadata: {
      basis: consent.basis,
      source: consent.source,
      evidence_ref: consent.evidenceRef ?? null,
      captured_by: capturedBy,
    },
  });
}

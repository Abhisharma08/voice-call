import type { PoolClient } from "pg";
import { decryptPiiOrNull } from "@/lib/crypto/pii";
import { activeConsentFor, checkEligibility } from "@/lib/leads/eligibility";
import { isWithinWindow, windowFromConfig } from "@/lib/calling/windows";
import { auditInTx } from "@/lib/audit";

/**
 * The calling queue (n8n workflow W02, steps 1-4).
 *
 * PostgreSQL is the queue, per PRD 24's risk register: "Google Sheet used as
 * queue - Medium - PostgreSQL system of record" and "Workflow duplication in
 * n8n - Medium - Use DB state + idempotency keys". n8n schedules the worker;
 * it does not hold the state.
 *
 * Claiming uses `for update skip locked`, so several workers can pull from the
 * same campaign concurrently without handing two of them the same lead - which
 * would place two calls to one person.
 */

export interface ClaimedLead {
  leadId: string;
  tenantId: string;
  campaignId: string;
  phoneE164: string;
  attemptNo: number;
  consentId: string | null;
  consentBasis: string | null;
  campaignConfigVersion: number;
  provider: string;
  correlationId: string | null;
}

export type ClaimSkipReason =
  | "outside_calling_window"
  | "tenant_concurrency_reached"
  | "campaign_concurrency_reached"
  | "became_ineligible"
  | "no_phone";

export interface ClaimResult {
  claimed: ClaimedLead[];
  skipped: Array<{ leadId: string; reason: ClaimSkipReason; detail?: string }>;
}

const LOCK_TTL_MS = 5 * 60_000;

/**
 * Claim up to `limit` leads for one campaign.
 *
 * Every claimed lead is re-checked for eligibility at claim time, not just at
 * intake. A lead can sit in the queue for hours, and a DNC request or consent
 * withdrawal in that gap must stop the call (PRD 17.4: "Manual DNC must
 * immediately invalidate queued calls").
 */
export async function claimLeads(
  tx: PoolClient,
  args: { tenantId: string; campaignId: string; workerId: string; limit?: number; now?: Date },
): Promise<ClaimResult> {
  const now = args.now ?? new Date();
  const limit = Math.max(1, Math.min(args.limit ?? 10, 100));

  const campaign = await tx.query<{
    id: string;
    timezone: string;
    active: boolean;
    calling_config: Record<string, unknown>;
    concurrency_limit: number;
    voice_provider: string;
    config_version: number;
    compliance_approved_at: Date | null;
  }>(
    `select id, timezone, active, calling_config, concurrency_limit,
            voice_provider, config_version, compliance_approved_at
       from campaigns where id = $1`,
    [args.campaignId],
  );

  const c = campaign.rows[0];
  if (!c) throw new Error("Campaign not found in this tenant scope");

  // PRD 17.3 compliance gate, enforced at the last possible moment before a
  // call is placed rather than only at activation time.
  if (!c.active || !c.compliance_approved_at) {
    return { claimed: [], skipped: [] };
  }

  // FR-021: outside the window, nothing is claimed and the queue is deferred
  // to the next opening rather than being drained late at night.
  const decision = isWithinWindow(now, windowFromConfig(c.calling_config, c.timezone));
  if (!decision.allowed) {
    await tx.query(
      `update leads
          set next_call_at = greatest(coalesce(next_call_at, now()), $2)
        where campaign_id = $1 and status = 'queued'`,
      [args.campaignId, decision.nextOpenAt],
    );
    return {
      claimed: [],
      skipped: [{ leadId: "*", reason: "outside_calling_window", detail: decision.nextOpenAt.toISOString() }],
    };
  }

  // FR-022: concurrency caps at both tenant and campaign level. The tenant cap
  // is the outer bound, so one busy campaign cannot starve the others.
  const inFlight = await tx.query<{ tenant_calls: string; campaign_calls: string }>(
    `select
       (select count(*) from call_attempts
         where tenant_id = $1 and status in ('initiated','ringing','answered')) as tenant_calls,
       (select count(*) from call_attempts
         where campaign_id = $2 and status in ('initiated','ringing','answered')) as campaign_calls`,
    [args.tenantId, args.campaignId],
  );

  const tenantLimit = (
    await tx.query<{ concurrency_limit: number }>(
      `select concurrency_limit from tenants where id = $1`,
      [args.tenantId],
    )
  ).rows[0]?.concurrency_limit ?? 25;

  const tenantHeadroom = tenantLimit - Number(inFlight.rows[0]?.tenant_calls ?? 0);
  const campaignHeadroom = c.concurrency_limit - Number(inFlight.rows[0]?.campaign_calls ?? 0);
  const headroom = Math.min(tenantHeadroom, campaignHeadroom, limit);

  if (headroom <= 0) {
    return {
      claimed: [],
      skipped: [
        {
          leadId: "*",
          reason: tenantHeadroom <= 0 ? "tenant_concurrency_reached" : "campaign_concurrency_reached",
        },
      ],
    };
  }

  // Reclaim leads whose worker died mid-call before pulling new ones, so a
  // crashed worker does not permanently strand its leads.
  await tx.query(
    `update leads
        set status = 'queued', locked_by = null, locked_at = null, lock_expires_at = null
      where campaign_id = $1 and status = 'calling' and lock_expires_at < now()`,
    [args.campaignId],
  );

  const candidates = await tx.query<{
    id: string;
    phone_enc: Buffer | null;
    dnc: boolean;
    call_attempt_count: number;
    correlation_id: string | null;
  }>(
    `select id, phone_enc, dnc, call_attempt_count, correlation_id
       from leads
      where campaign_id = $1
        and status = 'queued'
        and (next_call_at is null or next_call_at <= $2)
      order by next_call_at nulls first, queued_at
      limit $3
      for update skip locked`,
    [args.campaignId, now, headroom],
  );

  const claimed: ClaimedLead[] = [];
  const skipped: ClaimResult["skipped"] = [];

  for (const row of candidates.rows) {
    const phone = decryptPiiOrNull(row.phone_enc);
    if (!phone) {
      await tx.query(
        `update leads set status = 'quarantined', status_reason = 'no_phone_at_claim' where id = $1`,
        [row.id],
      );
      skipped.push({ leadId: row.id, reason: "no_phone" });
      continue;
    }

    const eligibility = await checkEligibility(tx, {
      tenantId: args.tenantId,
      leadId: row.id,
      campaignId: args.campaignId,
      phoneE164: phone,
      leadDnc: row.dnc,
      callAttemptCount: row.call_attempt_count,
    });

    if (!eligibility.eligible) {
      await tx.query(
        `update leads
            set status = 'suppressed', status_reason = $2, next_call_at = null,
                locked_by = null, lock_expires_at = null
          where id = $1`,
        [row.id, `${eligibility.reason}: ${eligibility.detail}`],
      );
      skipped.push({ leadId: row.id, reason: "became_ineligible", detail: eligibility.reason });
      continue;
    }

    const consent = await activeConsentFor(tx, row.id);
    const attemptNo = row.call_attempt_count + 1;

    await tx.query(
      `update leads
          set status = 'calling',
              locked_by = $2,
              locked_at = now(),
              lock_expires_at = now() + make_interval(secs => $3)
        where id = $1`,
      [row.id, args.workerId, LOCK_TTL_MS / 1000],
    );

    claimed.push({
      leadId: row.id,
      tenantId: args.tenantId,
      campaignId: args.campaignId,
      phoneE164: phone,
      attemptNo,
      consentId: consent?.id ?? null,
      consentBasis: consent?.basis ?? null,
      campaignConfigVersion: c.config_version,
      provider: c.voice_provider,
      correlationId: row.correlation_id,
    });
  }

  if (claimed.length > 0) {
    await auditInTx(tx, {
      tenantId: args.tenantId,
      actorType: "service",
      actorLabel: args.workerId,
      action: "queue.claimed",
      entityType: "campaign",
      entityId: args.campaignId,
      metadata: { count: claimed.length, lead_ids: claimed.map((l) => l.leadId) },
    });
  }

  return { claimed, skipped };
}

/** Release a claim without consuming an attempt, e.g. the provider refused the call. */
export async function releaseClaim(
  tx: PoolClient,
  leadId: string,
  requeueAt: Date | null,
): Promise<void> {
  await tx.query(
    `update leads
        set status = (case when $2::timestamptz is null then 'failed' else 'queued' end)::lead_status,
            next_call_at = $2,
            locked_by = null, locked_at = null, lock_expires_at = null
      where id = $1`,
    [leadId, requeueAt],
  );
}

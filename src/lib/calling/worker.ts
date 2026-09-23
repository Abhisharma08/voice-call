import type { PoolClient } from "pg";
import { claimLeads, releaseClaim, type ClaimedLead } from "@/lib/calling/queue";
import { backoffDelayMs } from "@/lib/calling/retry";
import { resolveProvider } from "@/lib/providers/voice";
import { ProviderError } from "@/lib/providers/voice/types";
import { auditInTx } from "@/lib/audit";
import { fulfilCallbacksForLead } from "@/lib/calling/callbacks";

/**
 * The calling worker (n8n workflow W02, steps 4-6).
 *
 * n8n triggers this on a schedule; the durable state lives here in PostgreSQL,
 * per the PRD 9 engineering rule "Do not store call state only in n8n
 * execution history".
 *
 * The call_attempts row is written *before* the provider is asked to dial, so
 * a crash between the two leaves an auditable record of an attempt that may
 * have happened rather than a silent gap (G4: "every attempted call has a
 * durable call record").
 */

export interface DialResult {
  leadId: string;
  callId: string | null;
  providerCallId: string | null;
  status: "initiated" | "provider_failed" | "skipped";
  detail?: string;
}

export interface CallingTickResult {
  dialled: DialResult[];
  skipped: Awaited<ReturnType<typeof claimLeads>>["skipped"];
}

export async function runCallingTick(
  tx: PoolClient,
  args: {
    tenantId: string;
    campaignId: string;
    workerId: string;
    webhookBaseUrl: string;
    limit?: number;
    now?: Date;
  },
): Promise<CallingTickResult> {
  const claim = await claimLeads(tx, {
    tenantId: args.tenantId,
    campaignId: args.campaignId,
    workerId: args.workerId,
    limit: args.limit,
    now: args.now,
  });

  const script = await loadScript(tx, args.campaignId);
  const dialled: DialResult[] = [];

  for (const lead of claim.claimed) {
    dialled.push(await dialOne(tx, lead, script, args.webhookBaseUrl, args.workerId));
  }

  return { dialled, skipped: claim.skipped };
}

interface CampaignScript {
  clientName: string;
  campaignName: string;
  businessContext: string;
  opening: string;
  questions: Array<{ fieldName: string; question: string; required: boolean }>;
  workflowVersion: string;
}

export async function loadScript(tx: PoolClient, campaignId: string): Promise<CampaignScript> {
  const campaign = await tx.query<{
    name: string;
    business_context: string | null;
    script: string | null;
    config_version: number;
    tenant_name: string;
  }>(
    `select c.name, c.business_context, c.script, c.config_version, t.name as tenant_name
       from campaigns c join tenants t on t.id = c.tenant_id
      where c.id = $1`,
    [campaignId],
  );

  const c = campaign.rows[0];
  if (!c) throw new Error("Campaign not found");

  const rules = await tx.query<{ field_name: string; question: string; required: boolean }>(
    `select field_name, question, required from qualification_rules
      where campaign_id = $1 order by position, field_name`,
    [campaignId],
  );

  return {
    clientName: c.tenant_name,
    campaignName: c.name,
    businessContext: c.business_context ?? "",
    opening: c.script ?? "",
    questions: rules.rows.map((r) => ({
      fieldName: r.field_name,
      question: r.question,
      required: r.required,
    })),
    workflowVersion: `W02.v${c.config_version}`,
  };
}

async function dialOne(
  tx: PoolClient,
  lead: ClaimedLead,
  script: CampaignScript,
  webhookBaseUrl: string,
  workerId: string,
): Promise<DialResult> {
  // Durable record first (PRD G4), so a provider timeout cannot lose the fact
  // that we attempted this lead.
  const inserted = await tx.query<{ id: string }>(
    // queue_latency_sec is the PRD 21 lead-to-call metric, computed here
    // rather than by joining every first attempt back to its lead when the
    // analytics page is opened (migration 0013). The value is known now and
    // never changes, so it is written once and read cheaply forever.
    `insert into call_attempts
       (tenant_id, lead_id, campaign_id, attempt_no, provider, status,
        started_at, consent_id, consent_basis, campaign_config_version,
        workflow_version, correlation_id, queue_latency_sec)
     select $1, $2, $3, $4, $5, 'initiated', now(), $6, $7, $8, $9, $10,
            greatest(0, extract(epoch from now() - l.queued_at))::int
       from leads l where l.id = $2
     returning id`,
    [
      lead.tenantId,
      lead.leadId,
      lead.campaignId,
      lead.attemptNo,
      lead.provider,
      lead.consentId,
      lead.consentBasis,
      lead.campaignConfigVersion,
      script.workflowVersion,
      lead.correlationId,
    ],
  );

  const callId = inserted.rows[0]?.id;
  if (!callId) throw new Error("Failed to create call attempt");

  await tx.query(
    `update leads set call_attempt_count = $2, last_call_at = now() where id = $1`,
    [lead.leadId, lead.attemptNo],
  );

  // A callback the lead asked for is kept the moment the call goes out, not
  // when it connects. The promise was to call back; the retry ladder owns what
  // happens if nobody picks up.
  await fulfilCallbacksForLead(tx, {
    tenantId: lead.tenantId,
    leadId: lead.leadId,
    callId,
  });

  try {
    const provider = resolveProvider(lead.provider);
    const result = await provider.createCall({
      to: lead.phoneE164,
      callId,
      tenantId: lead.tenantId,
      campaignId: lead.campaignId,
      script: {
        opening: script.opening,
        questions: script.questions,
        businessContext: script.businessContext,
        clientName: script.clientName,
      },
      webhookUrl: `${webhookBaseUrl}/api/webhooks/voice/${lead.provider}`,
      correlationId: lead.correlationId,
    });

    await tx.query(
      `update call_attempts set provider_call_id = $2, status = $3 where id = $1`,
      [callId, result.providerCallId, result.status],
    );

    await auditInTx(tx, {
      tenantId: lead.tenantId,
      actorType: "service",
      actorLabel: workerId,
      action: "call.initiated",
      entityType: "call",
      entityId: callId,
      metadata: {
        lead_id: lead.leadId,
        attempt_no: lead.attemptNo,
        provider: lead.provider,
        consent_basis: lead.consentBasis,
      },
    });

    return { leadId: lead.leadId, callId, providerCallId: result.providerCallId, status: "initiated" };
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : true;
    const detail = err instanceof Error ? err.message : String(err);

    await tx.query(
      `update call_attempts
          set status = 'failed', failure_reason = $2, ended_at = now()
        where id = $1`,
      [callId, detail],
    );

    // PRD 18.2: transient provider failures go back on the queue with
    // exponential backoff; a permanent one drops the lead to failed.
    const requeueAt = retryable ? new Date(Date.now() + backoffDelayMs(lead.attemptNo)) : null;
    await releaseClaim(tx, lead.leadId, requeueAt);

    await auditInTx(tx, {
      tenantId: lead.tenantId,
      actorType: "service",
      actorLabel: workerId,
      action: "call.provider_failed",
      entityType: "call",
      entityId: callId,
      metadata: { lead_id: lead.leadId, retryable, detail },
    });

    return {
      leadId: lead.leadId,
      callId,
      providerCallId: null,
      status: "provider_failed",
      detail,
    };
  }
}

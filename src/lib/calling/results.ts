import type { PoolClient } from "pg";
import { encryptPii } from "@/lib/crypto/pii";
import { decideRetry, retryPolicyFromConfig, type CallOutcome } from "@/lib/calling/retry";
import { auditInTx } from "@/lib/audit";
import type { NormalizedWebhook } from "@/lib/providers/voice/types";

/**
 * Call result ingestion (W02 step 7, W04).
 *
 * PRD 18.1: "Call result idempotency key = provider + provider_call_id."
 * A provider that delivers the same terminal webhook twice - which they all
 * do eventually - must not produce two transcripts, two analyses, or two
 * decrements of the retry budget.
 */

export type ResultOutcome =
  | { status: "recorded"; callId: string; needsAnalysis: boolean }
  | { status: "duplicate"; callId: string }
  | { status: "unknown_call" };

export async function recordCallResult(
  tx: PoolClient,
  args: { tenantId: string; provider: string; webhook: NormalizedWebhook },
): Promise<ResultOutcome> {
  const { webhook } = args;

  const call = await tx.query<{
    id: string;
    lead_id: string;
    campaign_id: string | null;
    attempt_no: number;
    status: string;
  }>(
    `select id, lead_id, campaign_id, attempt_no, status
       from call_attempts
      where provider = $1 and provider_call_id = $2
      for update`,
    [args.provider, webhook.providerCallId],
  );

  const c = call.rows[0];
  if (!c) return { status: "unknown_call" };

  // Terminal states are final. A repeat delivery is acknowledged, not replayed.
  if (isTerminal(c.status)) return { status: "duplicate", callId: c.id };

  // Interim statuses (ringing, answered) just update the timeline (FR-023).
  if (!isTerminal(webhook.status)) {
    await tx.query(`update call_attempts set status = $2 where id = $1`, [c.id, webhook.status]);
    return { status: "recorded", callId: c.id, needsAnalysis: false };
  }

  await tx.query(
    `update call_attempts
        set status = $2, duration_sec = $3, ended_at = now(), failure_reason = $4
      where id = $1`,
    [c.id, webhook.status, webhook.durationSec ?? null, webhook.failureReason ?? null],
  );

  if (webhook.transcript) {
    // PRD 26.2: transcripts are high-sensitivity content, encrypted at the
    // application layer like the other PII columns.
    await tx.query(
      `insert into call_transcripts (tenant_id, call_id, transcript_enc, language)
       values ($1, $2, $3, $4)`,
      [args.tenantId, c.id, encryptPii(webhook.transcript.text), webhook.transcript.language ?? null],
    );
  }

  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "service",
    action: "call.completed",
    entityType: "call",
    entityId: c.id,
    metadata: {
      lead_id: c.lead_id,
      status: webhook.status,
      duration_sec: webhook.durationSec ?? null,
      has_transcript: Boolean(webhook.transcript),
    },
  });

  // A connected call goes to qualification; anything else goes straight to the
  // retry ladder, since there is no conversation to analyse.
  const connected = webhook.status === "completed" && Boolean(webhook.transcript);

  if (connected) {
    await tx.query(`update leads set status = 'awaiting_analysis' where id = $1`, [c.lead_id]);
    return { status: "recorded", callId: c.id, needsAnalysis: true };
  }

  await applyRetryDecision(tx, {
    tenantId: args.tenantId,
    leadId: c.lead_id,
    campaignId: c.campaign_id,
    outcome: webhook.status as CallOutcome,
    attemptsMade: c.attempt_no,
  });

  return { status: "recorded", callId: c.id, needsAnalysis: false };
}

function isTerminal(status: string): boolean {
  return ["completed", "no_answer", "busy", "failed", "canceled"].includes(status);
}

/**
 * Workflow W04. Applies the retry ladder, or stops the lead permanently.
 */
export async function applyRetryDecision(
  tx: PoolClient,
  args: {
    tenantId: string;
    leadId: string;
    campaignId: string | null;
    outcome: CallOutcome;
    attemptsMade: number;
    callbackAt?: Date | null;
  },
): Promise<void> {
  const config = args.campaignId
    ? (
        await tx.query<{ calling_config: Record<string, unknown> }>(
          `select calling_config from campaigns where id = $1`,
          [args.campaignId],
        )
      ).rows[0]?.calling_config ?? {}
    : {};

  const decision = decideRetry({
    outcome: args.outcome,
    attemptsMade: args.attemptsMade,
    policy: retryPolicyFromConfig(config),
    callbackAt: args.callbackAt ?? null,
  });

  switch (decision.action) {
    case "retry":
    case "callback":
      await tx.query(
        `update leads
            set status = 'queued', next_call_at = $2, status_reason = $3,
                locked_by = null, locked_at = null, lock_expires_at = null
          where id = $1`,
        [args.leadId, decision.nextCallAt, decision.reason],
      );
      break;

    case "stop":
      await tx.query(
        `update leads
            set status = (case when $2 = 'do_not_call' then 'suppressed' else 'closed' end)::lead_status,
                status_reason = $2,
                next_call_at = null,
                locked_by = null, locked_at = null, lock_expires_at = null
          where id = $1`,
        [args.leadId, decision.reason],
      );
      break;
  }

  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "service",
    action: `lead.${decision.action}`,
    entityType: "lead",
    entityId: args.leadId,
    metadata: {
      outcome: args.outcome,
      attempts_made: args.attemptsMade,
      reason: "reason" in decision ? decision.reason : null,
      next_call_at: "nextCallAt" in decision ? decision.nextCallAt.toISOString() : null,
    },
  });
}

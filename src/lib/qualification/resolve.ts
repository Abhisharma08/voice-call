import type { PoolClient } from "pg";
import { QualificationSchema, type QualificationResult } from "@/lib/qualification/schema";
import {
  decideRouting,
  qualificationLabel,
  rubricFromConfig,
  scoreResult,
  thresholdsFromConfig,
} from "@/lib/qualification/scoring";
import { commitAnalysis } from "@/lib/qualification/pipeline";
import { applyRetryDecision } from "@/lib/calling/results";
import { auditInTx } from "@/lib/audit";

/**
 * Resolving a held review.
 *
 * When an operator confirms or corrects, the final result is released to the
 * sheet, the CRM and routing, and the correction is logged to audit_events
 * with actor_type = human.
 *
 * A correction re-runs scoring and routing from the corrected fields rather
 * than letting the operator set a score directly. Otherwise two leads with
 * identical answers could carry different scores depending on who reviewed
 * them, and the scoring rubric would stop meaning anything.
 */

export type ResolutionAction = "confirm" | "correct" | "reject";

export interface ResolveResult {
  analysisId: string;
  reviewStatus: string;
  score: number;
  intent: string;
  routingAction: string;
}

export async function resolveReview(
  tx: PoolClient,
  args: {
    tenantId: string;
    analysisId: string;
    action: ResolutionAction;
    reviewerId: string;
    reviewerLabel: string;
    /** Only for "correct": the fields the operator changed. */
    corrections?: Partial<QualificationResult>;
    note?: string | null;
  },
): Promise<ResolveResult> {
  const row = await tx.query<{
    id: string;
    call_id: string;
    lead_id: string;
    campaign_id: string | null;
    attempt_no: number;
    review_status: string;
    structured_payload: Record<string, unknown>;
  }>(
    `select an.id, an.call_id, ca.lead_id, ca.campaign_id, ca.attempt_no,
            an.review_status, an.structured_payload
       from call_analyses an
       join call_attempts ca on ca.id = an.call_id
      where an.id = $1
      for update`,
    [args.analysisId],
  );

  const a = row.rows[0];
  if (!a) throw new Error("Analysis not found in this tenant scope");
  if (a.review_status !== "pending_review") {
    throw new Error(`Analysis is ${a.review_status}, not pending review`);
  }

  const original = parseStored(a.structured_payload);

  if (args.action === "reject") {
    // The result is wrong and not worth correcting - discard it and let the
    // retry ladder decide whether to call again. Nothing syncs downstream.
    await tx.query(
      `update call_analyses
          set review_status = 'rejected', reviewed_by = $2, reviewed_at = now(),
              review_reason = coalesce($3, review_reason)
        where id = $1`,
      [args.analysisId, args.reviewerId, args.note ?? null],
    );

    await applyRetryDecision(tx, {
      tenantId: args.tenantId,
      leadId: a.lead_id,
      campaignId: a.campaign_id,
      outcome: "no_answer",
      attemptsMade: a.attempt_no,
    });

    await auditInTx(tx, {
      tenantId: args.tenantId,
      actorType: "user",
      actorId: args.reviewerId,
      actorLabel: args.reviewerLabel,
      action: "review.rejected",
      entityType: "call_analysis",
      entityId: args.analysisId,
      metadata: { note: args.note ?? null },
    });

    return {
      analysisId: args.analysisId,
      reviewStatus: "rejected",
      score: 0,
      intent: original.intent,
      routingAction: "rejected",
    };
  }

  const corrected: QualificationResult =
    args.action === "correct" ? { ...original, ...args.corrections } : original;

  // Re-validate: an operator correction goes through the same schema the model
  // does, so the UI cannot write an intent the taxonomy does not contain.
  const validated = QualificationSchema.safeParse(corrected);
  if (!validated.success) {
    throw new Error(
      `Correction failed validation: ${validated.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }

  const campaign = await loadScoringConfig(tx, a.campaign_id);
  const { score, signals } = scoreResult(validated.data, campaign.rubric);
  const routing = decideRouting(validated.data, score, campaign.thresholds);

  const reviewStatus = args.action === "correct" ? "corrected" : "confirmed";

  await tx.query(
    `update call_analyses
        set review_status = $2,
            reviewed_by = $3,
            reviewed_at = now(),
            intent = $4,
            score = $5,
            qualification = $6,
            structured_payload = $7,
            callback_requested = $8,
            human_followup = $9,
            do_not_call = $10
      where id = $1`,
    [
      args.analysisId,
      reviewStatus,
      args.reviewerId,
      validated.data.intent,
      score,
      qualificationLabel(validated.data, score),
      JSON.stringify({
        ...validated.data,
        score_signals: signals,
        routing_action: routing.action,
        reviewed: true,
      }),
      validated.data.callback_requested,
      validated.data.human_followup,
      validated.data.do_not_call,
    ],
  );

  // "correction logged to audit_events with actor_type=human".
  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "user",
    actorId: args.reviewerId,
    actorLabel: args.reviewerLabel,
    action: args.action === "correct" ? "review.corrected" : "review.confirmed",
    entityType: "call_analysis",
    entityId: args.analysisId,
    metadata: {
      note: args.note ?? null,
      changed_fields: args.action === "correct" ? changedFields(original, validated.data) : [],
      original: args.action === "correct" ? redact(original) : undefined,
      final: redact(validated.data),
      score,
    },
  });

  // Released to Sheets/HubSpot/routing.
  await commitAnalysis(tx, {
    tenantId: args.tenantId,
    analysisId: args.analysisId,
    callId: a.call_id,
    leadId: a.lead_id,
    campaignId: a.campaign_id,
    attemptNo: a.attempt_no,
    result: validated.data,
    score,
    routingAction: routing.action,
  });

  return {
    analysisId: args.analysisId,
    reviewStatus,
    score,
    intent: validated.data.intent,
    routingAction: routing.action,
  };
}

function parseStored(payload: Record<string, unknown>): QualificationResult {
  // The stored payload carries derived extras (score_signals, routing_action)
  // alongside the model fields; strip them before re-validating.
  const { score_signals: _s, routing_action: _r, reviewed: _v, ...rest } = payload;
  const parsed = QualificationSchema.safeParse(rest);
  if (!parsed.success) {
    throw new Error("Stored analysis payload does not match the qualification schema");
  }
  return parsed.data;
}

function changedFields(before: QualificationResult, after: QualificationResult): string[] {
  return (Object.keys(after) as Array<keyof QualificationResult>).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

/** Keep free-text out of the audit metadata; it counts as sensitive. */
function redact(result: QualificationResult): Record<string, unknown> {
  const { summary: _summary, reason: _reason, ...rest } = result;
  return rest;
}

async function loadScoringConfig(tx: PoolClient, campaignId: string | null) {
  if (!campaignId) {
    return { rubric: rubricFromConfig({}), thresholds: thresholdsFromConfig({}) };
  }
  const r = await tx.query<{
    scoring_rubric: Record<string, unknown>;
    routing_config: Record<string, unknown>;
  }>(`select scoring_rubric, routing_config from campaigns where id = $1`, [campaignId]);

  const c = r.rows[0];
  return {
    rubric: rubricFromConfig(c?.scoring_rubric ?? {}),
    thresholds: thresholdsFromConfig(c?.routing_config ?? {}),
  };
}

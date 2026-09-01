import type { PoolClient } from "pg";
import { decryptPiiOrNull } from "@/lib/crypto/pii";
import { analyzeTranscript } from "@/lib/qualification/analyze";
import { resultForUnconnectedCall, type QualificationResult } from "@/lib/qualification/schema";
import {
  decideRouting,
  qualificationLabel,
  rubricFromConfig,
  scoreResult,
  thresholdsFromConfig,
} from "@/lib/qualification/scoring";
import { evaluateReviewGate, mayAutoSync } from "@/lib/qualification/review";
import { applyRetryDecision } from "@/lib/calling/results";
import { suppressLead } from "@/lib/leads/eligibility";
import { enqueueSync } from "@/lib/integrations/outbox";
import { auditInTx } from "@/lib/audit";

/**
 * Qualification (n8n workflow W03).
 *
 *   1 get transcript      5 persist analysis
 *   2 load campaign rules  6 calculate routing
 *   3 LLM analysis         7 Google Sheets append
 *   4 validate schema      8 HubSpot update
 *                          9 notify human
 *
 * Steps 7-9 do not call anything directly: they enqueue into sync_outbox, so a
 * HubSpot or Sheets outage becomes a retry rather than a lost result
 * (PRD 18.2). And nothing is enqueued at all when the review gate holds the
 * result (PRD 26.3).
 */

export interface QualifyOutcome {
  analysisId: string;
  intent: string;
  score: number;
  reviewStatus: string;
  routingAction: string;
  synced: boolean;
  degraded: boolean;
}

export async function qualifyCall(
  tx: PoolClient,
  args: { tenantId: string; callId: string },
): Promise<QualifyOutcome> {
  const call = await tx.query<{
    id: string;
    lead_id: string;
    campaign_id: string | null;
    attempt_no: number;
    status: string;
    duration_sec: number | null;
  }>(
    `select id, lead_id, campaign_id, attempt_no, status, duration_sec
       from call_attempts where id = $1`,
    [args.callId],
  );

  const c = call.rows[0];
  if (!c) throw new Error("Call not found in this tenant scope");

  // Idempotency: one analysis per call. A re-triggered W03 returns the
  // existing result instead of paying for a second model call.
  const existing = await tx.query<{
    id: string;
    intent: string;
    score: number | null;
    review_status: string;
  }>(`select id, intent, score, review_status from call_analyses where call_id = $1`, [args.callId]);

  if (existing.rows[0]) {
    const e = existing.rows[0];
    return {
      analysisId: e.id,
      intent: e.intent,
      score: e.score ?? 0,
      reviewStatus: e.review_status,
      routingAction: "already_analysed",
      synced: false,
      degraded: false,
    };
  }

  const campaign = await loadCampaignRules(tx, c.campaign_id);

  const transcriptRow = await tx.query<{ transcript_enc: Buffer | null }>(
    `select transcript_enc from call_transcripts where call_id = $1 order by created_at desc limit 1`,
    [args.callId],
  );
  const transcript = decryptPiiOrNull(transcriptRow.rows[0]?.transcript_enc ?? null);

  const unconnected = c.status !== "completed" || !transcript;

  let result: QualificationResult;
  let model = campaign.model;
  let promptVersion = campaign.promptVersion;
  let latencyMs: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let degraded = false;

  if (unconnected) {
    // No conversation - do not spend a model call inventing one.
    result = resultForUnconnectedCall(
      (["no_answer", "busy", "failed", "canceled"].includes(c.status) ? c.status : "failed") as
        | "no_answer"
        | "busy"
        | "failed"
        | "canceled",
    );
    model = "none";
  } else {
    const analysis = await analyzeTranscript({
      transcript,
      callDurationSec: c.duration_sec,
      campaign: {
        clientName: campaign.clientName,
        campaignName: campaign.campaignName,
        businessContext: campaign.businessContext,
        productService: campaign.productService,
        questions: campaign.questions,
        model: campaign.model,
        effort: campaign.effort,
        promptVersion: campaign.promptVersion,
      },
    });

    result = analysis.result;
    model = analysis.model;
    promptVersion = analysis.promptVersion;
    latencyMs = analysis.latencyMs;
    inputTokens = analysis.inputTokens;
    outputTokens = analysis.outputTokens;
    degraded = analysis.degraded;
  }

  const { score, signals } = scoreResult(result, campaign.rubric);
  const routing = decideRouting(result, score, campaign.thresholds);

  const gate = evaluateReviewGate({
    result,
    score,
    confidenceThreshold: campaign.reviewConfidenceThreshold,
    boundaryBand: campaign.reviewBoundaryBand,
    thresholds: campaign.thresholds,
    requiredFields: campaign.questions.filter((q) => q.required).map((q) => q.fieldName),
    unconnected,
  });

  const reviewStatus = gate.hold ? "pending_review" : "auto_approved";

  const inserted = await tx.query<{ id: string }>(
    `insert into call_analyses
       (tenant_id, call_id, intent, score, qualification, structured_payload, confidence,
        model, prompt_version, review_status, review_reason,
        callback_requested, human_followup, do_not_call,
        input_tokens, output_tokens, latency_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning id`,
    [
      args.tenantId,
      args.callId,
      result.intent,
      score,
      qualificationLabel(result, score),
      JSON.stringify({ ...result, score_signals: signals, routing_action: routing.action }),
      result.confidence,
      model,
      promptVersion,
      reviewStatus,
      gate.hold ? gate.reason : null,
      result.callback_requested,
      result.human_followup,
      result.do_not_call,
      inputTokens,
      outputTokens,
      latencyMs,
    ],
  );

  const analysisId = inserted.rows[0]?.id;
  if (!analysisId) throw new Error("Failed to persist analysis");

  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "service",
    action: "analysis.completed",
    entityType: "call",
    entityId: args.callId,
    metadata: {
      intent: result.intent,
      score,
      confidence: result.confidence,
      review_status: reviewStatus,
      triggers: gate.hold ? gate.triggers : [],
      degraded,
      model,
    },
  });

  if (gate.hold) {
    // PRD 26.3: held results are excluded from Sheets append and HubSpot
    // update until an operator resolves them. Nothing downstream happens here.
    await tx.query(
      `update leads set status = 'pending_review', status_reason = $2 where id = $1`,
      [c.lead_id, gate.reason],
    );

    return {
      analysisId,
      intent: result.intent,
      score,
      reviewStatus,
      routingAction: "held_for_review",
      synced: false,
      degraded,
    };
  }

  await commitAnalysis(tx, {
    tenantId: args.tenantId,
    analysisId,
    callId: args.callId,
    leadId: c.lead_id,
    campaignId: c.campaign_id,
    attemptNo: c.attempt_no,
    result,
    score,
    routingAction: routing.action,
  });

  return {
    analysisId,
    intent: result.intent,
    score,
    reviewStatus,
    routingAction: routing.action,
    synced: true,
    degraded,
  };
}

/**
 * Everything that happens once a result is trusted: routing, suppression,
 * callbacks, and the downstream syncs. Called either straight from the
 * pipeline (auto-approved) or from the review queue when an operator confirms.
 */
export async function commitAnalysis(
  tx: PoolClient,
  args: {
    tenantId: string;
    analysisId: string;
    callId: string;
    leadId: string;
    campaignId: string | null;
    attemptNo: number;
    result: QualificationResult;
    score: number;
    routingAction: string;
  },
): Promise<void> {
  const { result } = args;

  const phone = decryptPiiOrNull(
    (
      await tx.query<{ phone_enc: Buffer | null }>(`select phone_enc from leads where id = $1`, [
        args.leadId,
      ])
    ).rows[0]?.phone_enc ?? null,
  );

  // FR-033 / PRD 7.4: a DNC detected in conversation suppresses permanently
  // and stops all retries.
  if (result.do_not_call) {
    await suppressLead(tx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      phoneE164: phone,
      reason: "voice_detected_dnc",
      source: "voice_detected",
    });
  } else if (result.callback_requested) {
    const scheduledFor = result.callback_time_iso ? new Date(result.callback_time_iso) : null;
    const valid = scheduledFor && !Number.isNaN(scheduledFor.getTime()) && scheduledFor > new Date();

    // FR-043: a callback carries the call context.
    await tx.query(
      `insert into callbacks (tenant_id, lead_id, call_id, scheduled_for)
       values ($1, $2, $3, $4)`,
      [
        args.tenantId,
        args.leadId,
        args.callId,
        valid ? scheduledFor : new Date(Date.now() + 24 * 3600 * 1000),
      ],
    );

    await applyRetryDecision(tx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      campaignId: args.campaignId,
      outcome: "completed",
      attemptsMade: args.attemptNo,
      callbackAt: valid ? scheduledFor : null,
    });
  } else if (args.routingAction !== "retry") {
    await tx.query(
      `update leads set status = 'qualified', status_reason = $2, next_call_at = null,
              locked_by = null, lock_expires_at = null
        where id = $1`,
      [args.leadId, args.routingAction],
    );
  }
  // routingAction === "retry" means no conversation took place (no_answer,
  // busy). recordCallResult has already run the retry ladder and put the lead
  // back in the queue with a next_call_at; overwriting it here would mark an
  // unanswered call "qualified" and strand the lead.

  // FR-034 / PRD 16: hot leads and explicit human requests create a routing
  // event for the sales recipient.
  if (args.routingAction === "hot_sales_routing" || result.human_followup) {
    await tx.query(
      `insert into routing_events (tenant_id, lead_id, call_id, action, status)
       values ($1, $2, $3, $4, 'pending')`,
      [args.tenantId, args.leadId, args.callId, args.routingAction],
    );

    await enqueueSync(tx, {
      tenantId: args.tenantId,
      target: "notification",
      dedupeKey: `notify:${args.callId}`,
      payload: {
        call_id: args.callId,
        lead_id: args.leadId,
        analysis_id: args.analysisId,
        intent: result.intent,
        score: args.score,
      },
    });
  }

  // FR-041, FR-042. PRD 18.1: sheet write dedupe key = call_id; the CRM update
  // is safe to retry because it sets current-state properties.
  await enqueueSync(tx, {
    tenantId: args.tenantId,
    target: "google_sheets",
    dedupeKey: args.callId,
    payload: { call_id: args.callId, analysis_id: args.analysisId },
  });

  await enqueueSync(tx, {
    tenantId: args.tenantId,
    target: "hubspot",
    dedupeKey: args.callId,
    payload: { call_id: args.callId, analysis_id: args.analysisId, lead_id: args.leadId },
  });
}

interface CampaignRules {
  clientName: string;
  campaignName: string;
  businessContext: string;
  productService: string | null;
  questions: Array<{ fieldName: string; question: string; required: boolean }>;
  rubric: ReturnType<typeof rubricFromConfig>;
  thresholds: ReturnType<typeof thresholdsFromConfig>;
  model: string;
  effort: string;
  promptVersion: string;
  reviewConfidenceThreshold: number;
  reviewBoundaryBand: number;
}

async function loadCampaignRules(tx: PoolClient, campaignId: string | null): Promise<CampaignRules> {
  if (!campaignId) {
    return {
      clientName: "",
      campaignName: "",
      businessContext: "",
      productService: null,
      questions: [],
      rubric: rubricFromConfig({}),
      thresholds: thresholdsFromConfig({}),
      model: "claude-opus-5",
      effort: "medium",
      promptVersion: "v1",
      reviewConfidenceThreshold: 0.75,
      reviewBoundaryBand: 5,
    };
  }

  const r = await tx.query<{
    name: string;
    business_context: string | null;
    domain: string | null;
    scoring_rubric: Record<string, unknown>;
    routing_config: Record<string, unknown>;
    analysis_model: string;
    analysis_effort: string;
    prompt_version: string;
    review_confidence_threshold: string;
    review_boundary_band: number;
    tenant_name: string;
  }>(
    `select c.name, c.business_context, c.domain, c.scoring_rubric, c.routing_config,
            c.analysis_model, c.analysis_effort, c.prompt_version,
            c.review_confidence_threshold, c.review_boundary_band, t.name as tenant_name
       from campaigns c join tenants t on t.id = c.tenant_id
      where c.id = $1`,
    [campaignId],
  );

  const c = r.rows[0];
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
    productService: c.domain,
    questions: rules.rows.map((x) => ({
      fieldName: x.field_name,
      question: x.question,
      required: x.required,
    })),
    rubric: rubricFromConfig(c.scoring_rubric),
    thresholds: thresholdsFromConfig(c.routing_config),
    model: c.analysis_model,
    effort: c.analysis_effort,
    promptVersion: c.prompt_version,
    reviewConfidenceThreshold: Number(c.review_confidence_threshold),
    reviewBoundaryBand: c.review_boundary_band,
  };
}

export { mayAutoSync };

import { z } from "zod";
import type { PoolClient } from "pg";

/**
 * Campaign configuration (PRD 22 Phase 2: "Per-campaign prompts/questions/
 * scoring").
 *
 * The design principle from the PRD's first page governs this file:
 * "client-specific behavior comes from configuration and tenant-scoped data,
 * not duplicated workflows." Everything a client can differ on lives here as
 * validated data.
 *
 * Every save bumps `config_version` and snapshots the whole configuration into
 * campaign_versions. PRD 9 requires the version be recorded with each call;
 * that number is only useful if the configuration it names can still be read
 * back months later, when someone asks which script produced a given result.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const CallingConfigSchema = z.object({
  window_start: z.string().regex(HHMM, "Use HH:MM, 24-hour"),
  window_end: z.string().regex(HHMM, "Use HH:MM, 24-hour"),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  max_attempts: z.number().int().min(1).max(10),
  retry_minutes: z.array(z.number().int().positive()).min(1).max(10),
  busy_retry_minutes: z.number().int().positive().optional(),
  country: z.string().length(2).toUpperCase(),
});

export const RoutingConfigSchema = z.object({
  hot_threshold: z.number().int().min(-100).max(100),
  interested_threshold: z.number().int().min(-100).max(100),
  notify_channel: z.string().max(120).optional(),
});

export const ScoringRubricSchema = z.object({
  current_need_confirmed: z.number().int(),
  short_timeline: z.number().int(),
  budget_known: z.number().int(),
  specific_product: z.number().int(),
  accepts_human_followup: z.number().int(),
  vague_curiosity: z.number().int(),
  long_term_no_plan: z.number().int(),
  explicit_rejection: z.number().int(),
});

export const QuestionSchema = z.object({
  fieldName: z
    .string()
    .min(1)
    .max(60)
    // The field name is the key the model must return, and the review gate
    // looks required fields up by it - so it has to be a plain identifier.
    .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, digits and underscores; must start with a letter"),
  question: z.string().min(1).max(500),
  required: z.boolean(),
  position: z.number().int().min(0).max(100),
});

export const CampaignConfigSchema = z
  .object({
    name: z.string().min(1).max(120),
    domain: z.string().max(120).nullable(),
    businessContext: z.string().max(4000),
    script: z.string().max(4000),
    timezone: z.string().min(1).max(64),
    voiceProvider: z.string().min(1).max(60),
    analysisModel: z.string().min(1).max(60),
    analysisEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    concurrencyLimit: z.number().int().min(1).max(100),
    reviewConfidenceThreshold: z.number().min(0).max(1),
    reviewBoundaryBand: z.number().int().min(0).max(50),
    googleSheetId: z.string().max(200).nullable(),
    googleSheetTab: z.string().max(200).nullable(),
    hubspotIntegrationId: z.string().uuid().nullable(),
    callingConfig: CallingConfigSchema,
    routingConfig: RoutingConfigSchema,
    scoringRubric: ScoringRubricSchema,
    questions: z.array(QuestionSchema).max(25),
  })
  .refine((c) => c.routingConfig.hot_threshold > c.routingConfig.interested_threshold, {
    message: "The hot threshold must be above the interested threshold",
    path: ["routingConfig", "hot_threshold"],
  })
  .refine((c) => c.callingConfig.window_end > c.callingConfig.window_start, {
    message: "The calling window must end after it starts",
    path: ["callingConfig", "window_end"],
  })
  .refine((c) => new Set(c.questions.map((q) => q.fieldName)).size === c.questions.length, {
    message: "Question field names must be unique",
    path: ["questions"],
  })
  .refine(
    (c) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: c.timezone });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Not a recognised IANA timezone", path: ["timezone"] },
  );

export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;

export const ConsentDeclarationSchema = z.object({
  basis: z.enum(["opt_in_form", "existing_customer", "service_call", "ivr_confirmation", "other"]),
  source: z.string().min(1).max(200),
  evidenceRef: z.string().max(300).nullable(),
});

export type ConsentDeclaration = z.infer<typeof ConsentDeclarationSchema>;

export const DEFAULT_CAMPAIGN_CONFIG: Omit<CampaignConfig, "name"> = {
  domain: null,
  businessContext: "",
  script: "",
  timezone: "Asia/Kolkata",
  voiceProvider: "mock",
  analysisModel: "claude-opus-5",
  analysisEffort: "medium",
  concurrencyLimit: 5,
  reviewConfidenceThreshold: 0.75,
  reviewBoundaryBand: 5,
  googleSheetId: null,
  googleSheetTab: "Call Log!A:V",
  hubspotIntegrationId: null,
  callingConfig: {
    window_start: "09:30",
    window_end: "18:30",
    max_attempts: 3,
    retry_minutes: [15, 120, 1440],
    country: "IN",
  },
  routingConfig: { hot_threshold: 75, interested_threshold: 50 },
  scoringRubric: {
    current_need_confirmed: 25,
    short_timeline: 25,
    budget_known: 15,
    specific_product: 10,
    accepts_human_followup: 15,
    vague_curiosity: 5,
    long_term_no_plan: 0,
    explicit_rejection: -100,
  },
  questions: [],
};

export async function loadCampaignConfig(
  tx: PoolClient,
  campaignId: string,
): Promise<(CampaignConfig & { id: string; configVersion: number; active: boolean }) | null> {
  const r = await tx.query<Record<string, unknown>>(
    `select id, name, domain, business_context, script, timezone, voice_provider,
            analysis_model, analysis_effort, concurrency_limit,
            review_confidence_threshold, review_boundary_band,
            google_sheet_id, google_sheet_tab, hubspot_integration_id,
            calling_config, routing_config, scoring_rubric, config_version, active
       from campaigns where id = $1`,
    [campaignId],
  );

  const c = r.rows[0];
  if (!c) return null;

  const rules = await tx.query<{
    field_name: string;
    question: string;
    required: boolean;
    position: number;
  }>(
    `select field_name, question, required, position from qualification_rules
      where campaign_id = $1 order by position, field_name`,
    [campaignId],
  );

  return {
    id: String(c.id),
    configVersion: Number(c.config_version),
    active: Boolean(c.active),
    name: String(c.name),
    domain: (c.domain as string | null) ?? null,
    businessContext: (c.business_context as string | null) ?? "",
    script: (c.script as string | null) ?? "",
    timezone: String(c.timezone),
    voiceProvider: String(c.voice_provider),
    analysisModel: String(c.analysis_model),
    analysisEffort: String(c.analysis_effort) as CampaignConfig["analysisEffort"],
    concurrencyLimit: Number(c.concurrency_limit),
    reviewConfidenceThreshold: Number(c.review_confidence_threshold),
    reviewBoundaryBand: Number(c.review_boundary_band),
    googleSheetId: (c.google_sheet_id as string | null) ?? null,
    googleSheetTab: (c.google_sheet_tab as string | null) ?? null,
    hubspotIntegrationId: (c.hubspot_integration_id as string | null) ?? null,
    callingConfig: { ...DEFAULT_CAMPAIGN_CONFIG.callingConfig, ...(c.calling_config as object) },
    routingConfig: { ...DEFAULT_CAMPAIGN_CONFIG.routingConfig, ...(c.routing_config as object) },
    scoringRubric: { ...DEFAULT_CAMPAIGN_CONFIG.scoringRubric, ...(c.scoring_rubric as object) },
    questions: rules.rows.map((q) => ({
      fieldName: q.field_name,
      question: q.question,
      required: q.required,
      position: q.position,
    })),
  };
}

/**
 * Persist a configuration change, bump the version, and snapshot it.
 *
 * Editing configuration deliberately does *not* activate a campaign or touch
 * its compliance approval - those are separate, separately-permissioned
 * actions. Otherwise a routine script edit could silently re-enable dialling.
 */
export async function saveCampaignConfig(
  tx: PoolClient,
  args: {
    tenantId: string;
    campaignId: string;
    config: CampaignConfig;
    userId: string;
    changeNote?: string | null;
  },
): Promise<number> {
  const { config } = args;

  const updated = await tx.query<{ config_version: number }>(
    `update campaigns set
        name = $3, domain = $4, business_context = $5, script = $6, timezone = $7,
        voice_provider = $8, analysis_model = $9, analysis_effort = $10,
        concurrency_limit = $11, review_confidence_threshold = $12, review_boundary_band = $13,
        google_sheet_id = $14, google_sheet_tab = $15, hubspot_integration_id = $16,
        calling_config = $17::jsonb, routing_config = $18::jsonb, scoring_rubric = $19::jsonb,
        config_version = config_version + 1,
        updated_by = $20
      where id = $1 and tenant_id = $2
      returning config_version`,
    [
      args.campaignId,
      args.tenantId,
      config.name,
      config.domain,
      config.businessContext,
      config.script,
      config.timezone,
      config.voiceProvider,
      config.analysisModel,
      config.analysisEffort,
      config.concurrencyLimit,
      config.reviewConfidenceThreshold,
      config.reviewBoundaryBand,
      config.googleSheetId,
      config.googleSheetTab,
      config.hubspotIntegrationId,
      JSON.stringify(config.callingConfig),
      JSON.stringify(config.routingConfig),
      JSON.stringify(config.scoringRubric),
      args.userId,
    ],
  );

  const version = updated.rows[0]?.config_version;
  if (version === undefined) throw new Error("Campaign not found in this tenant scope");

  // Replace the question set wholesale. Diffing it would let a removed
  // question linger as a required field the model is no longer asked about,
  // which would hold every subsequent result for review.
  await tx.query(`delete from qualification_rules where campaign_id = $1`, [args.campaignId]);
  for (const q of config.questions) {
    await tx.query(
      `insert into qualification_rules
         (tenant_id, campaign_id, field_name, question, required, position)
       values ($1, $2, $3, $4, $5, $6)`,
      [args.tenantId, args.campaignId, q.fieldName, q.question, q.required, q.position],
    );
  }

  await tx.query(
    `insert into campaign_versions (tenant_id, campaign_id, version, snapshot, changed_by, change_note)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      args.tenantId,
      args.campaignId,
      version,
      JSON.stringify(config),
      args.userId,
      args.changeNote ?? null,
    ],
  );

  return version;
}

/**
 * Why a campaign cannot be activated yet. Empty means it can.
 * PRD 14.3's wizard ends with "Run a test call" then "Activate campaign"; this
 * is the checklist standing between those two steps.
 */
export function activationBlockers(campaign: {
  complianceApprovedAt: Date | string | null;
  consentBasis: string | null;
  consentMode?: "require_record" | "inherit_from_source";
  script: string | null;
  questions: number;
  googleSheetId: string | null;
  hubspotIntegrationId: string | null;
}): string[] {
  const blockers: string[] = [];

  // Only a require_record campaign needs a declared basis before it can run.
  // An inherit_from_source campaign takes consent from the funnel the lead
  // came through, so there is nothing for a human to type here.
  if (campaign.consentMode === "require_record" && !campaign.consentBasis) {
    blockers.push(
      "This campaign requires an explicit consent record per lead, and no basis is declared for the list",
    );
  }
  if (!campaign.complianceApprovedAt) {
    blockers.push("Compliance review has not signed off on outbound calling (PRD 17.3)");
  }
  if (!campaign.script || campaign.script.trim() === "") {
    blockers.push("No opening script configured (FR-030)");
  }
  if (campaign.questions === 0) {
    blockers.push("No qualification questions configured (FR-030)");
  }
  if (!campaign.googleSheetId) {
    blockers.push("No Google Sheet destination configured (FR-004, FR-041)");
  }
  if (!campaign.hubspotIntegrationId) {
    blockers.push("No HubSpot integration selected (FR-003, FR-042)");
  }

  return blockers;
}

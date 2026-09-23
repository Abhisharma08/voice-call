import { relations, sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Typed mirror of db/migrations. The SQL files are authoritative - RLS
 * policies, partial indexes and check constraints have no faithful
 * representation here - so this file is kept in sync by hand and verified by
 * `drizzle-kit check`. Do not generate DDL from it.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const inet = customType<{ data: string; driverData: string }>({
  dataType: () => "inet",
});

// ── Enums ────────────────────────────────────────────────────────────────────
export const tenantStatus = pgEnum("tenant_status", ["active", "inactive", "suspended"]);
export const userRole = pgEnum("user_role", [
  "agency_admin",
  "campaign_manager",
  "operations_manager",
  "analyst",
  "service",
]);
export const userStatus = pgEnum("user_status", ["active", "disabled", "invited"]);
export const actorType = pgEnum("actor_type", ["user", "service", "system"]);
export const integrationType = pgEnum("integration_type", [
  "hubspot",
  "google_sheets",
  "voice_provider",
  "notification",
]);
export const integrationStatus = pgEnum("integration_status", ["active", "disabled", "error"]);
export const leadStatus = pgEnum("lead_status", [
  "new",
  "quarantined",
  "suppressed",
  "queued",
  "calling",
  "awaiting_analysis",
  "pending_review",
  "qualified",
  "closed",
  "failed",
]);
export const consentBasis = pgEnum("consent_basis", [
  "opt_in_form",
  "existing_customer",
  "service_call",
  "ivr_confirmation",
  "other",
]);
export const consentStatus = pgEnum("consent_status", ["active", "withdrawn", "expired"]);
export const callStatus = pgEnum("call_status", [
  "initiated",
  "ringing",
  "answered",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
]);
export const callIntent = pgEnum("call_intent", [
  "hot",
  "interested",
  "warm",
  "follow_up",
  "not_interested",
  "wrong_number",
  "no_answer",
  "busy",
  "do_not_call",
  "unknown",
]);
export const reviewStatus = pgEnum("review_status", [
  "auto_approved",
  "pending_review",
  "confirmed",
  "corrected",
  "rejected",
]);
export const callbackStatus = pgEnum("callback_status", [
  "scheduled",
  "completed",
  "missed",
  "canceled",
]);
export const dncScope = pgEnum("dnc_scope", ["tenant", "campaign"]);
export const syncTarget = pgEnum("sync_target", ["hubspot", "google_sheets", "notification"]);
export const syncStatus = pgEnum("sync_status", [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "dead_letter",
]);

const now = sql`now()`;

// ── Tenancy and identity ─────────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain"),
  status: tenantStatus("status").notNull().default("active"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** null = agency-global staff. Clients never log in (PRD 14.3). */
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: userRole("role").notNull(),
  status: userStatus("status").notNull().default("active"),
  passwordHash: text("password_hash"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
});

export const userTenantAssignments = pgTable(
  "user_tenant_assignments",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    createdBy: uuid("created_by").references((): any => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    index("user_tenant_assignments_tenant_idx").on(t.tenantId),
  ],
);

/** PRD 8.2: access outside an assignment requires explicit, logged elevation. */
export const accessElevations = pgTable("access_elevations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  grantedBy: uuid("granted_by").references(() => users.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().default(now),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  activeTenantId: uuid("active_tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(now),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ── Secrets and integrations ─────────────────────────────────────────────────
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  keyId: text("key_id").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  iv: bytea("iv").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
});

export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  type: integrationType("type").notNull(),
  name: text("name").notNull(),
  credentialRef: uuid("credential_ref").references(() => secrets.id, { onDelete: "restrict" }),
  config: jsonb("config").notNull().default({}),
  status: integrationStatus("status").notNull().default("active"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
});

// ── Campaigns ────────────────────────────────────────────────────────────────
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    domain: text("domain"),
    businessContext: text("business_context"),
    script: text("script"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    active: boolean("active").notNull().default(false),
    configVersion: integer("config_version").notNull().default(1),
    callingConfig: jsonb("calling_config").notNull().default({}),
    routingConfig: jsonb("routing_config").notNull().default({}),
    scoringRubric: jsonb("scoring_rubric").notNull().default({}),
    serviceCallCampaign: boolean("service_call_campaign").notNull().default(false),
    complianceApprovedAt: timestamp("compliance_approved_at", { withTimezone: true }),
    complianceApprovedBy: uuid("compliance_approved_by").references(() => users.id),
    googleSheetId: text("google_sheet_id"),
    googleSheetTab: text("google_sheet_tab"),
    hubspotIntegrationId: uuid("hubspot_integration_id").references(() => integrations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex("campaigns_tenant_name_uniq").on(t.tenantId, t.name)],
);

export const qualificationRules = pgTable(
  "qualification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    fieldName: text("field_name").notNull(),
    question: text("question").notNull(),
    required: boolean("required").notNull().default(false),
    allowedValues: text("allowed_values").array(),
    rubric: jsonb("rubric").notNull().default({}),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex("qualification_rules_campaign_field_uniq").on(t.campaignId, t.fieldName)],
);

// ── Leads and consent ────────────────────────────────────────────────────────
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    hubspotRecordId: text("hubspot_record_id"),
    source: text("source"),
    /** PRD 26.2: direct identifiers are AES-256-GCM ciphertext at rest. */
    nameEnc: bytea("name_enc"),
    phoneEnc: bytea("phone_enc"),
    emailEnc: bytea("email_enc"),
    /** Tenant-salted HMAC, for dedupe (FR-013) and DNC lookup (PRD 17.4). */
    phoneBidx: text("phone_bidx"),
    emailBidx: text("email_bidx"),
    phoneLast4: text("phone_last4"),
    phoneCountry: text("phone_country"),
    status: leadStatus("status").notNull().default("new"),
    statusReason: text("status_reason"),
    dnc: boolean("dnc").notNull().default(false),
    callAttemptCount: integer("call_attempt_count").notNull().default(0),
    nextCallAt: timestamp("next_call_at", { withTimezone: true }),
    lastCallAt: timestamp("last_call_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index("leads_tenant_status_idx").on(t.tenantId, t.status),
    index("leads_tenant_phone_bidx").on(t.tenantId, t.phoneBidx),
    index("leads_queue_idx").on(t.campaignId, t.status, t.nextCallAt),
  ],
);

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  basis: consentBasis("basis").notNull(),
  source: text("source").notNull(),
  evidenceRef: text("evidence_ref"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  capturedBy: text("captured_by"),
  status: consentStatus("status").notNull().default("active"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const dncEntries = pgTable("dnc_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  scope: dncScope("scope").notNull().default("tenant"),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  phoneBidx: text("phone_bidx").notNull(),
  reason: text("reason"),
  source: text("source").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

// ── Calls ────────────────────────────────────────────────────────────────────
export const callAttempts = pgTable(
  "call_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    attemptNo: integer("attempt_no").notNull(),
    provider: text("provider").notNull(),
    providerCallId: text("provider_call_id"),
    status: callStatus("status").notNull().default("initiated"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSec: integer("duration_sec"),
    /** PRD 21 lead-to-call latency, stamped at dial time (migration 0013). */
    queueLatencySec: integer("queue_latency_sec"),
    recordingRef: text("recording_ref"),
    failureReason: text("failure_reason"),
    /** PRD 26.1: consent basis stamped at call time, so each call is justifiable. */
    consentId: uuid("consent_id").references(() => consents.id, { onDelete: "set null" }),
    consentBasis: consentBasis("consent_basis"),
    campaignConfigVersion: integer("campaign_config_version"),
    workflowVersion: text("workflow_version"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    uniqueIndex("call_attempts_lead_attempt_uniq").on(t.leadId, t.attemptNo),
    index("call_attempts_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const callTranscripts = pgTable("call_transcripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  callId: uuid("call_id")
    .notNull()
    .references(() => callAttempts.id, { onDelete: "cascade" }),
  transcriptRef: text("transcript_ref"),
  transcriptEnc: bytea("transcript_enc"),
  language: text("language"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const callAnalyses = pgTable("call_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  callId: uuid("call_id")
    .notNull()
    .references(() => callAttempts.id, { onDelete: "cascade" }),
  intent: callIntent("intent").notNull().default("unknown"),
  score: integer("score"),
  qualification: text("qualification"),
  structuredPayload: jsonb("structured_payload").notNull().default({}),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  model: text("model"),
  promptVersion: text("prompt_version"),
  /** FR-035 / PRD 26.3: default is held for review, not auto-committed. */
  reviewStatus: reviewStatus("review_status").notNull().default("pending_review"),
  reviewReason: text("review_reason"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  callbackRequested: boolean("callback_requested").notNull().default(false),
  humanFollowup: boolean("human_followup").notNull().default(false),
  doNotCall: boolean("do_not_call").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const callbacks = pgTable("callbacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  callId: uuid("call_id").references(() => callAttempts.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().default(now),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: callbackStatus("status").notNull().default("scheduled"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  fulfilledCallId: uuid("fulfilled_call_id").references(() => callAttempts.id, {
    onDelete: "set null",
  }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const routingEvents = pgTable("routing_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  callId: uuid("call_id").references(() => callAttempts.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  assignee: text("assignee"),
  status: text("status").notNull().default("pending"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
});

export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    target: syncTarget("target").notNull(),
    /** PRD 18.1 idempotency: sheet write dedupe key = call_id. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: syncStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(now),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sync_outbox_dedupe_uniq").on(t.tenantId, t.target, t.dedupeKey),
    index("sync_outbox_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index("audit_events_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
  ],
);

// ── Relations ────────────────────────────────────────────────────────────────
export const tenantRelations = relations(tenants, ({ many }) => ({
  campaigns: many(campaigns),
  leads: many(leads),
  integrations: many(integrations),
}));

export const leadRelations = relations(leads, ({ one, many }) => ({
  tenant: one(tenants, { fields: [leads.tenantId], references: [tenants.id] }),
  campaign: one(campaigns, { fields: [leads.campaignId], references: [campaigns.id] }),
  consents: many(consents),
  callAttempts: many(callAttempts),
}));

export const callAttemptRelations = relations(callAttempts, ({ one, many }) => ({
  lead: one(leads, { fields: [callAttempts.leadId], references: [leads.id] }),
  transcripts: many(callTranscripts),
  analyses: many(callAnalyses),
}));

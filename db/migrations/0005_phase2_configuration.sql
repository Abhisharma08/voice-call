-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Phase 2: configuration-driven multi-tenancy.
--
-- PRD 22 Phase 2 is tenant-scoped config, per-tenant credentials, multiple
-- campaigns, per-campaign prompts/questions/scoring, tenant dashboards and
-- audit logs. Most of that needs no new schema - Phase 0 already made these
-- tables tenant-scoped. What is missing is the record of *who configured
-- what*, and the client-list consent declaration that PRD 14.3 step 10
-- requires before any calling.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Configuration provenance (PRD 17.1: audit configuration changes) ──────
alter table campaigns
  add column created_by uuid references users(id),
  add column updated_by uuid references users(id),
  -- PRD 14.3 step 10: "Record the consent basis for this client's lead list
  -- (Section 26.1) before any test or live calling."
  --
  -- This is the agency's own record of what the client asserted about their
  -- list, and it is a precondition for compliance approval. It does not
  -- replace the per-lead consents row - intake mints one from this
  -- declaration, so every call still cites a specific, dated consent record
  -- rather than a blanket claim (PRD 26.1).
  add column consent_basis        consent_basis,
  add column consent_source       text,
  add column consent_evidence_ref text,
  add column consent_declared_by  uuid references users(id),
  add column consent_declared_at  timestamptz;

alter table tenants
  add column created_by uuid references users(id),
  add column notes text;

alter table integrations
  add column created_by uuid references users(id),
  add column last_verified_at timestamptz;

-- Any campaign approved before this migration was approved without a recorded
-- consent basis, which is exactly the gap PRD 14.3 step 10 closes. Revoke
-- those approvals rather than backfilling a basis nobody actually declared -
-- inventing consent evidence to satisfy a constraint would defeat the point
-- of the constraint. They must be re-approved through the wizard.
update campaigns
   set compliance_approved_at = null,
       compliance_approved_by = null,
       active = false
 where compliance_approved_at is not null
   and consent_basis is null;

-- A campaign cannot claim a compliance sign-off without a recorded consent
-- basis for the list it will dial. Enforced here rather than only in the UI:
-- PRD 17.3 makes this the gate before live outbound calling.
alter table campaigns
  add constraint campaigns_compliance_needs_consent_ck
  check (compliance_approved_at is null or consent_basis is not null);

-- ── Campaign configuration history ────────────────────────────────────────
-- PRD 9: "Record workflow version/config version with each call for
-- auditability." call_attempts already stores campaign_config_version; this
-- is the table that makes that number mean something afterwards, by keeping
-- the configuration each version actually referred to.
create table campaign_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  version       integer not null,
  snapshot      jsonb not null,
  changed_by    uuid references users(id),
  change_note   text,
  created_at    timestamptz not null default now(),
  unique (campaign_id, version)
);
create index campaign_versions_campaign_idx on campaign_versions (campaign_id, version desc);

alter table campaign_versions enable row level security;
alter table campaign_versions force row level security;
create policy tenant_isolation on campaign_versions
  using (app.tenant_visible(tenant_id))
  with check (app.tenant_visible(tenant_id));

grant select, insert on campaign_versions to app_user, app_service;

-- ── Analytics support (PRD 21) ────────────────────────────────────────────
-- Lead-to-call latency needs the queued and first-call instants side by side.
create index call_attempts_first_attempt_idx
  on call_attempts (lead_id, started_at) where attempt_no = 1;

create index leads_tenant_queued_idx on leads (tenant_id, queued_at)
  where queued_at is not null;

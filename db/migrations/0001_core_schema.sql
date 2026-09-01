-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Core schema (PRD 12 Data Model, 26.1 Consent, 26.2 PII, 26.3 Review).
--
-- Deviation from PRD 12, deliberate: `users` has a NULLABLE tenant_id. Every
-- persona in PRD 4 is agency staff — clients never log in (PRD 14.3) — so a
-- user belongs to the agency, and per-client scope is granted through
-- user_tenant_assignments. PRD 8.2 requires staff be scoped to assigned
-- tenants by default with explicit, logged elevation; access_elevations is
-- that log.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Enums ──────────────────────────────────────────────────────────────────
create type tenant_status   as enum ('active', 'inactive', 'suspended');
create type user_role       as enum ('agency_admin', 'campaign_manager', 'operations_manager', 'analyst', 'service');
create type user_status     as enum ('active', 'disabled', 'invited');
create type actor_type      as enum ('user', 'service', 'system');
create type integration_type as enum ('hubspot', 'google_sheets', 'voice_provider', 'notification');
create type integration_status as enum ('active', 'disabled', 'error');

create type lead_status     as enum (
  'new', 'quarantined', 'suppressed', 'queued', 'calling',
  'awaiting_analysis', 'pending_review', 'qualified', 'closed', 'failed');

create type consent_basis   as enum ('opt_in_form', 'existing_customer', 'service_call', 'ivr_confirmation', 'other');
create type consent_status  as enum ('active', 'withdrawn', 'expired');

create type call_status     as enum (
  'initiated', 'ringing', 'answered', 'completed',
  'no_answer', 'busy', 'failed', 'canceled');

create type call_intent     as enum (
  'hot', 'interested', 'warm', 'follow_up', 'not_interested',
  'wrong_number', 'no_answer', 'busy', 'do_not_call', 'unknown');

create type review_status   as enum ('auto_approved', 'pending_review', 'confirmed', 'corrected', 'rejected');
create type callback_status as enum ('scheduled', 'completed', 'missed', 'canceled');
create type dnc_scope       as enum ('tenant', 'campaign');
create type sync_target     as enum ('hubspot', 'google_sheets', 'notification');
create type sync_status     as enum ('pending', 'in_flight', 'succeeded', 'failed', 'dead_letter');

-- ── Tenancy & identity ─────────────────────────────────────────────────────
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  domain      text,
  status      tenant_status not null default 'active',
  timezone    text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id) on delete set null, -- null = agency-global staff
  email          text not null unique,
  name           text not null,
  role           user_role not null,
  status         user_status not null default 'active',
  password_hash  text,                       -- scrypt; null for service identities
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index users_role_idx on users (role) where status = 'active';

-- PRD 8.2: default scope is the assignment set, not "everything".
create table user_tenant_assignments (
  user_id     uuid not null references users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        user_role not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  primary key (user_id, tenant_id)
);
create index user_tenant_assignments_tenant_idx on user_tenant_assignments (tenant_id);

-- PRD 8.2: "access to a client outside that assignment requires an explicit,
-- logged elevation rather than being available by default".
create table access_elevations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  reason      text not null,
  granted_by  uuid references users(id),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index access_elevations_active_idx
  on access_elevations (user_id, tenant_id, expires_at)
  where revoked_at is null;

create table sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  token_hash      text not null unique,       -- sha256 of the opaque cookie value
  active_tenant_id uuid references tenants(id) on delete set null,
  ip              inet,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;
create index sessions_expiry_idx on sessions (expires_at) where revoked_at is null;

-- ── Secrets vault (PRD 17.1: store only secret references in the app DB) ────
create table secrets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade, -- null = platform-level
  purpose       text not null,
  key_id        text not null,                -- which master key wrapped the DEK
  wrapped_dek   bytea not null,
  iv            bytea not null,
  ciphertext    bytea not null,
  auth_tag      bytea not null,
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz,
  created_by    uuid references users(id)
);
create index secrets_tenant_idx on secrets (tenant_id, purpose);

create table integrations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  type            integration_type not null,
  name            text not null,
  credential_ref  uuid references secrets(id) on delete restrict,
  config          jsonb not null default '{}'::jsonb,
  status          integration_status not null default 'active',
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index integrations_tenant_type_idx on integrations (tenant_id, type) where status = 'active';

-- ── Campaigns ──────────────────────────────────────────────────────────────
create table campaigns (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  name              text not null,
  domain            text,
  business_context  text,
  script            text,
  timezone          text not null default 'Asia/Kolkata',
  active            boolean not null default false,
  config_version    integer not null default 1,
  -- calling windows, retries, thresholds (PRD Appendix B)
  calling_config    jsonb not null default '{}'::jsonb,
  routing_config    jsonb not null default '{}'::jsonb,
  scoring_rubric    jsonb not null default '{}'::jsonb,
  -- PRD 26.1: campaign may be flagged service-call/existing-relationship
  service_call_campaign boolean not null default false,
  -- PRD 17.3: no India outbound until compliance review signs off
  compliance_approved_at timestamptz,
  compliance_approved_by uuid references users(id),
  google_sheet_id   text,
  google_sheet_tab  text,
  hubspot_integration_id uuid references integrations(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, name)
);
create index campaigns_tenant_active_idx on campaigns (tenant_id, active);

create table qualification_rules (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  campaign_id  uuid not null references campaigns(id) on delete cascade,
  field_name   text not null,
  question     text not null,
  required     boolean not null default false,
  allowed_values text[],
  rubric       jsonb not null default '{}'::jsonb,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (campaign_id, field_name)
);
create index qualification_rules_campaign_idx on qualification_rules (campaign_id, position);

-- ── Leads (PRD 26.2: direct identifiers are encrypted at column level) ──────
-- *_enc  : AES-256-GCM ciphertext, decrypted only in the app layer
-- *_bidx : HMAC-SHA256 blind index, enables equality lookup without decrypting
create table leads (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  campaign_id        uuid references campaigns(id) on delete set null,
  hubspot_record_id  text,
  source             text,
  name_enc           bytea,
  phone_enc          bytea,
  email_enc          bytea,
  phone_bidx         text,
  email_bidx         text,
  phone_last4        text,          -- safe to render in list views unmasked
  phone_country      text,
  status             lead_status not null default 'new',
  status_reason      text,
  dnc                boolean not null default false,
  call_attempt_count integer not null default 0,
  next_call_at       timestamptz,
  last_call_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- PRD 12 Indexes
create unique index leads_tenant_hubspot_uniq
  on leads (tenant_id, hubspot_record_id) where hubspot_record_id is not null;
create index leads_tenant_status_idx on leads (tenant_id, status);
create index leads_tenant_phone_bidx on leads (tenant_id, phone_bidx);
create index leads_queue_idx on leads (campaign_id, status, next_call_at);

-- ── Consent (PRD 26.1) ─────────────────────────────────────────────────────
create table consents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  basis         consent_basis not null,
  source        text not null,
  evidence_ref  text,
  captured_at   timestamptz not null,
  captured_by   text,
  status        consent_status not null default 'active',
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index consents_lead_active_idx on consents (lead_id) where status = 'active';
create index consents_tenant_idx on consents (tenant_id, status);

-- ── DNC / suppression (PRD 17.4) ───────────────────────────────────────────
create table dnc_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  scope        dnc_scope not null default 'tenant',
  campaign_id  uuid references campaigns(id) on delete cascade,
  phone_bidx   text not null,
  reason       text,
  source       text not null,          -- 'voice_detected' | 'manual' | 'import'
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  constraint dnc_campaign_scope_ck
    check ((scope = 'campaign') = (campaign_id is not null))
);
create unique index dnc_tenant_phone_uniq
  on dnc_entries (tenant_id, phone_bidx) where scope = 'tenant';
create index dnc_campaign_idx on dnc_entries (campaign_id, phone_bidx);

-- ── Calls ──────────────────────────────────────────────────────────────────
create table call_attempts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  lead_id           uuid not null references leads(id) on delete cascade,
  campaign_id       uuid references campaigns(id) on delete set null,
  attempt_no        integer not null,
  provider          text not null,
  provider_call_id  text,
  status            call_status not null default 'initiated',
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_sec      integer,
  recording_ref     text,
  failure_reason    text,
  -- PRD 26.1: consent basis is stamped at call time so each call is
  -- individually justifiable later, even if the consent record changes.
  consent_id        uuid references consents(id) on delete set null,
  consent_basis     consent_basis,
  -- PRD 9: record workflow/config version with each call for auditability
  campaign_config_version integer,
  workflow_version  text,
  correlation_id    text,
  created_at        timestamptz not null default now()
);
-- PRD 18.1: call result idempotency key = provider + provider_call_id
create unique index call_attempts_provider_call_uniq
  on call_attempts (provider, provider_call_id) where provider_call_id is not null;
create unique index call_attempts_lead_attempt_uniq on call_attempts (lead_id, attempt_no);
create index call_attempts_tenant_status_idx on call_attempts (tenant_id, status);
create index call_attempts_tenant_created_idx on call_attempts (tenant_id, created_at desc);

create table call_transcripts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  call_id        uuid not null references call_attempts(id) on delete cascade,
  transcript_ref text,
  transcript_enc bytea,               -- PRD 26.2: high-sensitivity, encrypted
  language       text,
  created_at     timestamptz not null default now()
);
create index call_transcripts_call_idx on call_transcripts (call_id);

create table call_analyses (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  call_id            uuid not null references call_attempts(id) on delete cascade,
  intent             call_intent not null default 'unknown',
  score              integer,
  qualification      text,
  structured_payload jsonb not null default '{}'::jsonb,
  confidence         numeric(4,3),
  model              text,
  prompt_version     text,
  -- PRD 26.3 / FR-035: nothing below threshold auto-commits downstream
  review_status      review_status not null default 'pending_review',
  review_reason      text,
  reviewed_by        uuid references users(id),
  reviewed_at        timestamptz,
  callback_requested boolean not null default false,
  human_followup     boolean not null default false,
  do_not_call        boolean not null default false,
  created_at         timestamptz not null default now()
);
create index call_analyses_call_idx on call_analyses (call_id);
create index call_analyses_review_queue_idx
  on call_analyses (tenant_id, created_at)
  where review_status = 'pending_review';

create table callbacks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  call_id       uuid references call_attempts(id) on delete set null,
  requested_at  timestamptz not null default now(),
  scheduled_for timestamptz not null,
  status        callback_status not null default 'scheduled',
  created_at    timestamptz not null default now()
);
create index callbacks_due_idx on callbacks (tenant_id, scheduled_for) where status = 'scheduled';

create table routing_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  call_id     uuid references call_attempts(id) on delete set null,
  action      text not null,
  assignee    text,
  status      text not null default 'pending',
  acknowledged_at timestamptz,
  created_at  timestamptz not null default now()
);
create index routing_events_tenant_created_idx on routing_events (tenant_id, created_at desc);

-- ── Outbound sync outbox (PRD 18.2: pending sync survives outages) ─────────
create table sync_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  target          sync_target not null,
  dedupe_key      text not null,     -- PRD 18.1: sheet write dedupe key = call_id
  payload         jsonb not null,
  status          sync_status not null default 'pending',
  attempts        integer not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create unique index sync_outbox_dedupe_uniq on sync_outbox (tenant_id, target, dedupe_key);
create index sync_outbox_due_idx on sync_outbox (status, next_attempt_at);

-- ── Audit (PRD 17.1, 26.2: every PII/media read is logged) ─────────────────
create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete set null,
  actor_type    actor_type not null,
  actor_id      uuid,
  actor_label   text,
  action        text not null,
  entity_type   text,
  entity_id     text,
  metadata      jsonb not null default '{}'::jsonb,
  ip            inet,
  created_at    timestamptz not null default now()
);
create index audit_events_tenant_created_idx on audit_events (tenant_id, created_at desc);
create index audit_events_entity_idx on audit_events (entity_type, entity_id);

-- ── updated_at maintenance ─────────────────────────────────────────────────
create or replace function app.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['tenants','users','integrations','campaigns','leads']
  loop
    execute format(
      'create trigger %I_touch_updated_at before update on %I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;
end
$$;

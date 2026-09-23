-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Phase 1: intake, queue, calling, qualification.
--
-- Adds what the vertical slice needs on top of the Phase 0 schema:
--   * service identities for n8n
--   * webhook idempotency
--   * queue claim/lock columns and concurrency caps
--   * per-campaign provider + model configuration
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Service identities for n8n workers ────────────────────────────────────
-- A token is stored only as a SHA-256 hash. Each token is bound to one tenant,
-- so a leaked worker credential cannot reach another client's data even before
-- RLS is considered.
create table service_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  scopes        text[] not null default '{}',
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);
create index service_tokens_tenant_idx on service_tokens (tenant_id) where revoked_at is null;

-- ── Webhook idempotency ───────────────────────────────────────────────────
-- The idempotency key is tenant_id + source event or record id + event type.
-- Storing the raw event alongside gives us replay for the dead-letter path.
create table webhook_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  source         text not null,
  event_type     text not null,
  idempotency_key text not null,
  payload        jsonb not null,
  result         jsonb,
  status         text not null default 'received',
  correlation_id text,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz
);
create unique index webhook_events_idem_uniq on webhook_events (tenant_id, idempotency_key);
create index webhook_events_tenant_received_idx on webhook_events (tenant_id, received_at desc);

-- ── Queue claim / locking ─────────────────────────────────────────────────
-- A worker claims a lead by taking a time-boxed lock. If the worker dies, the
-- lock expires and the lead becomes claimable again rather than being stranded
-- in `calling` forever.
alter table leads
  add column locked_by       text,
  add column locked_at       timestamptz,
  add column lock_expires_at timestamptz,
  add column queued_at       timestamptz,
  add column correlation_id  text;

create index leads_claimable_idx
  on leads (campaign_id, next_call_at)
  where status = 'queued';

create index leads_stale_lock_idx
  on leads (lock_expires_at)
  where status = 'calling';

-- "Limit concurrent calls per tenant/campaign/provider."
alter table campaigns
  add column concurrency_limit integer not null default 5,
  add column voice_provider    text not null default 'mock',
  add column analysis_model    text not null default 'claude-opus-5',
  add column analysis_effort   text not null default 'medium',
  -- The confidence floor below which a result is held for review,
  -- and the band around the hot/interested boundary that also triggers review.
  add column review_confidence_threshold numeric(4,3) not null default 0.750,
  add column review_boundary_band        integer      not null default 5,
  add column prompt_version   text not null default 'v1';

alter table tenants
  add column concurrency_limit integer not null default 25;

-- ── Analysis provenance ───────────────────────────────────────────────────
alter table call_analyses
  add column input_tokens   integer,
  add column output_tokens  integer,
  add column latency_ms     integer,
  add column raw_response   jsonb;

-- ── RLS for the new tenant-scoped tables ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['service_tokens', 'webhook_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (app.tenant_visible(tenant_id))
         with check (app.tenant_visible(tenant_id))', t);
  end loop;
end
$$;

grant select, insert, update, delete on webhook_events to app_user, app_service;
grant select, insert, update, delete on service_tokens to app_user;
-- A worker may verify and stamp its own token, never mint or delete one.
grant select, update on service_tokens to app_service;

-- ── Service-token authentication ──────────────────────────────────────────
-- Same pattern as the human auth path in 0003: the lookup has to happen before
-- any tenant scope exists, so it runs through a narrow SECURITY DEFINER
-- function rather than by loosening the policy.
create or replace function app.service_token_lookup(p_token_hash text)
returns table (
  token_id  uuid,
  tenant_id uuid,
  name      text,
  scopes    text[]
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select t.id, t.tenant_id, t.name, t.scopes
    from service_tokens t
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
   limit 1
$$;

create or replace function app.service_token_touch(p_token_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update service_tokens set last_used_at = now() where id = p_token_id
$$;

revoke all on function app.service_token_lookup(text), app.service_token_touch(uuid)
  from public;
grant execute on function app.service_token_lookup(text), app.service_token_touch(uuid)
  to app_user, app_service;

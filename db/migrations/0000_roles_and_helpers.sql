-- ═══════════════════════════════════════════════════════════════════════════
-- 0000 — Extensions, least-privilege roles, and tenant-scope helper functions.
--
-- Cross-tenant queries are structurally prevented rather than merely filtered
-- in the UI, using PostgreSQL Row-Level Security.
-- The application NEVER connects as the table owner; it connects as app_user
-- (human sessions) or app_service (n8n workers), both of which are subject to
-- RLS. Tenant scope is carried in transaction-local GUCs set by the app's
-- tenant middleware, never read from a user-supplied request field.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── Roles ──────────────────────────────────────────────────────────────────
-- Dev/CI passwords only. In staging/production these roles are provisioned by
-- infrastructure with managed credentials (separate prod/staging
-- credentials, least-privilege service accounts) and this block is a no-op.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login password 'app_user_dev_pw';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then
    create role app_service login password 'app_service_dev_pw';
  end if;
end
$$;

-- Neither runtime role may create objects or bypass RLS.
revoke all on schema public from app_user, app_service;
grant usage on schema public to app_user, app_service;

create schema if not exists app;
grant usage on schema app to app_user, app_service;

-- ── Tenant-scope helpers ───────────────────────────────────────────────────
-- app.tenant_id      the single tenant this transaction may touch
-- app.global_scope   'on' only for an authenticated Agency Admin
-- app.actor_id       user id or service identity, for audit attribution
-- app.actor_type     'user' | 'service' | 'system'

create or replace function app.current_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function app.has_global_scope() returns boolean
  language sql stable
  as $$ select coalesce(current_setting('app.global_scope', true), 'off') = 'on' $$;

create or replace function app.current_actor_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.actor_id', true), '')::uuid $$;

create or replace function app.current_actor_type() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('app.actor_type', true), ''), 'system') $$;

-- The single predicate every tenant-scoped RLS policy uses.
-- A NULL tenant_id is never visible: fail closed if scope was not established.
create or replace function app.tenant_visible(row_tenant uuid) returns boolean
  language sql stable
  as $$
    select case
      when row_tenant is null then false
      when app.has_global_scope() then true
      else row_tenant = app.current_tenant_id()
    end
  $$;

grant execute on all functions in schema app to app_user, app_service;

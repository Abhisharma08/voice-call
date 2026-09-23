-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Row-Level Security. Cross-tenant URL manipulation must yield a
-- 403 or 404 and disclose no data.
--
-- Every tenant-scoped table gets the same policy: a row is visible only when
-- app.tenant_visible(tenant_id) is true, which requires either an exact match
-- on the transaction's app.tenant_id GUC or an explicit global scope that only
-- an authenticated Agency Admin session may set. FORCE ROW LEVEL SECURITY
-- means even the table owner is subject to the policy, so a migration bug or
-- an accidental owner-credentialed connection cannot silently read across
-- tenants either.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
  tenant_scoped text[] := array[
    'integrations', 'campaigns', 'qualification_rules', 'leads', 'consents',
    'dnc_entries', 'call_attempts', 'call_transcripts', 'call_analyses',
    'callbacks', 'routing_events', 'sync_outbox', 'secrets', 'audit_events'
  ];
begin
  foreach t in array tenant_scoped loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (app.tenant_visible(tenant_id))
         with check (app.tenant_visible(tenant_id))', t);
  end loop;
end
$$;

-- `secrets` and `audit_events` allow a NULL tenant_id (platform-level secrets,
-- platform-level audit). Those rows are reachable only under global scope.
drop policy tenant_isolation on secrets;
create policy tenant_isolation on secrets
  using (case when tenant_id is null then app.has_global_scope()
              else app.tenant_visible(tenant_id) end)
  with check (case when tenant_id is null then app.has_global_scope()
                   else app.tenant_visible(tenant_id) end);

drop policy tenant_isolation on audit_events;
create policy tenant_isolation on audit_events
  using (case when tenant_id is null then app.has_global_scope()
              else app.tenant_visible(tenant_id) end)
  with check (case when tenant_id is null then app.has_global_scope()
                   else app.tenant_visible(tenant_id) end);

-- Audit is append-only for runtime roles: no UPDATE/DELETE grant below.

-- ── tenants: the row IS the tenant, so scope on id rather than tenant_id ───
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_isolation on tenants
  using (app.has_global_scope() or id = app.current_tenant_id())
  with check (app.has_global_scope());   -- only a global-scope actor creates tenants

-- ── Identity tables are agency-level, not tenant-scoped ───────────────────
-- A user is agency staff. Restrict by role in the app layer;
-- RLS here only prevents a tenant-scoped session from enumerating staff of
-- other assignments.
alter table users enable row level security;
alter table users force row level security;
create policy users_scope on users
  using (
    app.has_global_scope()
    or id = app.current_actor_id()
    or exists (
      select 1 from user_tenant_assignments a
      where a.user_id = users.id and a.tenant_id = app.current_tenant_id()
    )
  )
  with check (app.has_global_scope());

alter table user_tenant_assignments enable row level security;
alter table user_tenant_assignments force row level security;
create policy assignments_scope on user_tenant_assignments
  using (app.has_global_scope()
         or user_id = app.current_actor_id()
         or tenant_id = app.current_tenant_id())
  with check (app.has_global_scope());

alter table access_elevations enable row level security;
alter table access_elevations force row level security;
create policy elevations_scope on access_elevations
  using (app.has_global_scope()
         or user_id = app.current_actor_id()
         or tenant_id = app.current_tenant_id())
  with check (app.has_global_scope());

-- Sessions are looked up before tenant scope exists, so they are guarded by
-- grant + opaque token hash rather than by tenant RLS.
alter table sessions enable row level security;
alter table sessions force row level security;
create policy sessions_scope on sessions using (true) with check (true);

-- ── Grants: least privilege, no DDL, append-only audit ────────────────────
grant select, insert, update, delete on
  tenants, users, user_tenant_assignments, access_elevations, sessions,
  secrets, integrations, campaigns, qualification_rules, leads, consents,
  dnc_entries, call_attempts, call_transcripts, call_analyses, callbacks,
  routing_events, sync_outbox
to app_user, app_service;

grant select, insert on audit_events to app_user, app_service;

-- The n8n/service identity has no business touching staff accounts or sessions.
revoke insert, update, delete on users, user_tenant_assignments, access_elevations, sessions
  from app_service;

-- Neither runtime role may create objects.
revoke create on schema public from app_user, app_service;

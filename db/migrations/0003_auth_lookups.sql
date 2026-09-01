-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — Authentication lookups, and tenant visibility for assigned staff.
--
-- Two gaps that only show up once a request actually runs:
--
-- 1. Login and session resolution have to read `users` *before* any actor or
--    tenant is known, but 0002 locked that table down. Rather than loosening
--    the policy, authentication goes through narrow SECURITY DEFINER
--    functions: each returns exactly the columns that step needs and nothing
--    more, so the table stays closed and there is one auditable entry point.
--
-- 2. The tenant switcher lists the clients a user is assigned to, which it
--    does with an actor scope and no tenant pinned yet. Under the 0002 policy
--    `tenants` was invisible in that state, so the list came back empty. A
--    user may now see a tenant row they hold an assignment for - the name they
--    already know they work on - while every business table stays gated on the
--    tenant scope itself.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tenant rows visible to assigned staff ──────────────────────────────
drop policy tenant_isolation on tenants;
create policy tenant_isolation on tenants
  using (
    app.has_global_scope()
    or id = app.current_tenant_id()
    or exists (
      select 1 from user_tenant_assignments a
       where a.tenant_id = tenants.id
         and a.user_id = app.current_actor_id()
    )
  )
  with check (app.has_global_scope());

-- ── 2. Authentication entry points ────────────────────────────────────────
-- SECURITY DEFINER runs as the function owner, so `search_path` is pinned to
-- stop a caller-controlled schema from shadowing the tables referenced here.

create or replace function app.login_lookup(p_email text)
returns table (
  id            uuid,
  email         text,
  name          text,
  role          user_role,
  status        user_status,
  password_hash text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select u.id, u.email, u.name, u.role, u.status, u.password_hash
    from users u
   where lower(u.email) = lower(p_email)
   limit 1
$$;

create or replace function app.mark_login(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update users set last_login_at = now() where id = p_user_id
$$;

create or replace function app.session_lookup(p_token_hash text)
returns table (
  session_id       uuid,
  active_tenant_id uuid,
  user_id          uuid,
  email            text,
  name             text,
  role             user_role,
  status           user_status
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select s.id, s.active_tenant_id, u.id, u.email, u.name, u.role, u.status
    from sessions s
    join users u on u.id = s.user_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1
$$;

create or replace function app.session_touch(p_session_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update sessions set last_seen_at = now() where id = p_session_id
$$;

-- Only the human-facing role authenticates. Service identities never log in
-- (PRD 4: "Service identity only"), so they get no access to these at all.
revoke all on function
  app.login_lookup(text), app.mark_login(uuid),
  app.session_lookup(text), app.session_touch(uuid)
from public, app_service;

grant execute on function
  app.login_lookup(text), app.mark_login(uuid),
  app.session_lookup(text), app.session_touch(uuid)
to app_user;

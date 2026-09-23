-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 — Intake from a free HubSpot portal.
--
-- Free HubSpot has no workflows, so the "Send a webhook" action this platform
-- was built around does not exist for most of our clients. What every tier
-- does have is a private app, and a private app can subscribe to webhooks.
--
-- Those webhooks are a different shape in three ways, and all three are why
-- this migration exists:
--
--   1. They carry no contact properties - only `objectId` and `portalId`. The
--      name, phone and enquiry have to be fetched back over the CRM API, so
--      intake now needs the client's access token, not just the write-back
--      path. It already has it; what it lacked was a way to find it.
--
--   2. They cannot carry an Authorization header. They authenticate with
--      X-HubSpot-Signature-v3, keyed by the private app's client secret. So
--      the tenant cannot come from a service credential (the usual
--      rule); it has to be resolved from `portalId` in the payload, and the
--      signature verified before that resolution is trusted for anything.
--
--   3. One private app means one webhook URL, so the campaign cannot be a
--      query parameter chosen per workflow any more. It is routed from a
--      contact property instead.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Portal → tenant ────────────────────────────────────────────────────────
-- The portal id is HubSpot's own account number, learned from
-- /account-info/v3/details when the credential is verified rather than typed
-- in by hand. Unique because two tenants claiming one portal would make the
-- lookup below ambiguous, and resolving a lead to the wrong client is the
-- worst failure this system has.
alter table integrations add column hubspot_portal_id bigint;

create unique index integrations_hubspot_portal_uniq
  on integrations (hubspot_portal_id)
  where hubspot_portal_id is not null;

comment on column integrations.hubspot_portal_id is
  'HubSpot account id, from /account-info/v3/details. Resolves an inbound webhook to this tenant.';

-- ── Campaign routing from a contact property ───────────────────────────────
-- `intake_property` is the HubSpot property to read (the same value on every
-- campaign of a tenant, in practice - it is the client''s form or routing
-- field), and `intake_values` are the values that select this campaign.
--
-- `intake_default` catches everything unmatched. Partial-unique so a tenant
-- cannot have two defaults: with two, which campaign a lead landed in would
-- depend on row order.
alter table campaigns
  add column intake_property text,
  add column intake_values   text[] not null default '{}',
  add column intake_default   boolean not null default false;

create unique index campaigns_single_intake_default_uniq
  on campaigns (tenant_id)
  where intake_default;

comment on column campaigns.intake_values is
  'Values of intake_property that route a lead to this campaign. Compared case-insensitively, trimmed.';

-- ── The pre-scope lookup ───────────────────────────────────────────────────
-- A HubSpot webhook arrives with no session, no service token and no tenant.
-- The only identifier it carries is portalId, and reading the mapping requires
-- crossing tenants - which RLS forbids, correctly.
--
-- Rather than loosening the policy on `integrations` and `secrets`, this
-- exposes exactly the columns the signature check needs, the way
-- app.login_lookup does for the one read that must happen before a user is
-- known (migration 0003). The table stays closed and there is a single
-- auditable path to a client secret.
--
-- It returns sealed material, never plaintext: unsealing happens in the
-- application, where the KMS key lives.
create or replace function app.hubspot_portal_lookup(p_portal_id bigint)
returns table (
  tenant_id      uuid,
  integration_id uuid,
  status         text,
  key_id         text,
  wrapped_dek    bytea,
  iv             bytea,
  ciphertext     bytea,
  auth_tag       bytea
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select i.tenant_id, i.id, i.status,
         s.key_id, s.wrapped_dek, s.iv, s.ciphertext, s.auth_tag
    from integrations i
    join secrets s on s.id = i.credential_ref
    join tenants t on t.id = i.tenant_id
   where i.hubspot_portal_id = p_portal_id
     and i.type = 'hubspot'
     -- A suspended client stops being dialled at the source: no lead is
     -- ingested for them at all, rather than ingested and then suppressed.
     and t.status = 'active'
   limit 1
$$;

revoke all on function app.hubspot_portal_lookup(bigint) from public;
-- Service identity only. A staff request never needs this: it reaches
-- integrations through its own tenant scope.
grant execute on function app.hubspot_portal_lookup(bigint) to app_service;

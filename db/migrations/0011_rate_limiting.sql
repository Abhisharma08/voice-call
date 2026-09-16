-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — Rate limiting for the pre-authentication surface.
--
-- Three endpoints do real work before they know who is calling, and none of
-- them had a ceiling:
--
--   /api/auth/login          verifies a password with scrypt at N = 2^16.
--                            That is ~300ms of CPU and ~64MB of memory per
--                            attempt, by design - it is what makes a stolen
--                            hash expensive to crack. Unmetered, it is also a
--                            remote attacker's cheapest way to exhaust the
--                            instance, and their unlimited way to guess a
--                            password.
--
--   /api/webhooks/hubspot/…  resolves a portal and unseals that client's
--                            credential *before* the signature can be checked,
--                            because the signature is verified with the
--                            client's own secret. An unsigned flood therefore
--                            costs a lookup and an AES unwrap each.
--
--   /api/webhooks/voice/…    the same shape for provider callbacks.
--
-- The counter lives in PostgreSQL rather than in the process, because on a
-- serverless platform the process is the wrong place: every warm instance
-- holds its own memory, so an in-process limit of 10 becomes 10 x however many
-- instances the platform decided to run - a number the application neither
-- chooses nor observes. A shared counter is the only one that means anything.
--
-- Fixed windows, not a token bucket. A fixed window admits at most one burst
-- across a boundary, which for these limits is a rounding error, and it costs
-- one upsert rather than the read-modify-write a bucket needs.
-- ═══════════════════════════════════════════════════════════════════════════

create table rate_limit_counters (
  bucket_key   text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket_key, window_start)
);

comment on table rate_limit_counters is
  'Fixed-window request counters for the pre-auth surface. Not tenant-scoped: '
  'the whole point is that it is consulted before a tenant is known, so it is '
  'keyed by IP, email or portal id and reached only through '
  'app.rate_limit_consume().';

-- Sweeping expired windows needs to find them without scanning the live ones.
create index rate_limit_counters_window_idx on rate_limit_counters (window_start);

-- ── The atomic consume ────────────────────────────────────────────────────
-- SECURITY DEFINER for the same reason as the auth lookups in 0003: this runs
-- before any tenant scope exists, so rather than loosening a policy or leaving
-- a table open to the runtime roles, exactly one narrow entry point is
-- exposed. The table itself stays closed.
--
-- The `where count < p_limit` on the conflict branch is what makes this atomic
-- and self-limiting at once: when the window is already full the update
-- matches no row, nothing is incremented, and the absence of a RETURNING row
-- *is* the denial. Two concurrent requests cannot both read 9 and both write
-- 10, and a sustained flood cannot inflate the counter unboundedly past the
-- limit.
create or replace function app.rate_limit_consume(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer,
  p_cost           integer default 1
)
returns table (
  allowed             boolean,
  remaining           integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'rate_limit_consume: limit and window must be positive';
  end if;

  -- Align every caller in the same window to the same boundary, so the
  -- counter is shared rather than per-request.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into rate_limit_counters as c (bucket_key, window_start, count)
       values (p_key, v_window_start, p_cost)
  on conflict (bucket_key, window_start) do update
          set count = c.count + p_cost
        where c.count + p_cost <= p_limit
    returning c.count into v_count;

  if v_count is null then
    -- Either the window is full, or this insert lost a race with one that
    -- filled it. Both are a denial.
    return query select
      false,
      0,
      greatest(1, ceil(extract(epoch from
        (v_window_start + make_interval(secs => p_window_seconds)) - now()
      ))::integer);
    return;
  end if;

  return query select true, greatest(0, p_limit - v_count), 0;
end
$$;

revoke all on function app.rate_limit_consume(text, integer, integer, integer) from public;
grant execute on function app.rate_limit_consume(text, integer, integer, integer)
  to app_user, app_service;

-- ── Housekeeping ──────────────────────────────────────────────────────────
-- Windows are write-once and never read again after they roll over, so the
-- table would otherwise grow with every distinct client IP forever. The
-- scheduled sweep calls this; it is deliberately cheap and bounded rather than
-- exact, and deleting a still-live window would only reset a counter early.
create or replace function app.rate_limit_gc(p_older_than interval default interval '1 hour')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from rate_limit_counters
   where window_start < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

revoke all on function app.rate_limit_gc(interval) from public;
grant execute on function app.rate_limit_gc(interval) to app_service;

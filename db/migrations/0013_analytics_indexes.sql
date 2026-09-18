-- Make the analytics page cheap enough to open on a busy tenant.
--
-- The page used to run seventeen independent subqueries, each a sequential
-- scan of a whole table: call_analyses seven times, call_attempts four. The
-- query is now one pass per table with FILTER aggregates and an explicit
-- tenant predicate, but a pass still has to find the tenant's rows. Only
-- call_attempts had an index that could do that; the rest were scanned in full
-- regardless of how small the client was.
--
-- The date column is in each index because the page now reports a window
-- rather than all of history, and a tenant-only index would still read every
-- row a client had ever produced to answer a question about last month.

create index if not exists leads_tenant_created_idx
  on leads (tenant_id, created_at);

create index if not exists call_analyses_tenant_created_idx
  on call_analyses (tenant_id, created_at);

create index if not exists callbacks_tenant_created_idx
  on callbacks (tenant_id, created_at);

create index if not exists sync_outbox_tenant_status_idx
  on sync_outbox (tenant_id, status);

-- Lead-to-call latency (PRD 21), precomputed at dial time.
--
-- The p95 was the single most expensive thing on the page: it joined every
-- first attempt back to its lead to subtract two timestamps, which is a hash
-- join over both tables to produce one number. The subtraction is known the
-- moment the call is placed and never changes afterwards, so it is stored on
-- the attempt and the join disappears.
alter table call_attempts
  add column if not exists queue_latency_sec integer;

comment on column call_attempts.queue_latency_sec is
  'Seconds from leads.queued_at to this attempt''s started_at, recorded at dial '
  'time for the PRD 21 lead-to-call metric. Null for attempts placed before '
  'migration 0013, and for a lead that was never queued.';

-- Backfill, so the metric does not read as a regression the day this deploys.
update call_attempts ca
   set queue_latency_sec = greatest(0, extract(epoch from ca.started_at - l.queued_at))::int
  from leads l
 where l.id = ca.lead_id
   and ca.queue_latency_sec is null
   and ca.started_at is not null
   and l.queued_at is not null;

create index if not exists call_attempts_latency_idx
  on call_attempts (tenant_id, created_at)
  where attempt_no = 1 and queue_latency_sec is not null;

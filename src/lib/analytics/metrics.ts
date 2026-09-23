import type { PoolClient } from "pg";

/**
 * The analytics page's numbers, in one pass per table.
 *
 * This replaced seventeen independent subqueries, each of which was a full
 * sequential scan: call_analyses was scanned seven times to count seven
 * subsets of the same rows, call_attempts four times. Two things made those
 * scans unavoidable, and both are fixed here.
 *
 * The first is that a bare `count(*) from call_analyses` gives the planner no
 * tenant predicate to push into an index - the RLS policy is a CASE over
 * `current_setting`, which it cannot use for an index scan. Naming
 * `tenant_id = $1` explicitly lets migration 0013's indexes do the finding.
 * RLS still enforces the boundary; this is for the planner, not for safety,
 * and a tenant id that disagreed with the scope would simply return nothing.
 *
 * The second is that every figure was all-time, so the page got monotonically
 * slower for as long as a client used the platform. It reports a window now,
 * and the window is part of the index.
 */

/** Null means all of history. */
export type MetricsWindow = string | null;

export interface Metrics {
  leads: string;
  attempts: string;
  connected: string;
  avg_duration: string | null;
  p95_latency_sec: string | null;
  analyses: string;
  hot: string;
  pending_review: string;
  reviewed: string;
  corrected: string;
  input_tokens: string;
  output_tokens: string;
  avg_score: string | null;
  callbacks: string;
  callbacks_done: string;
  sync_ok: string;
  sync_bad: string;
}

export async function loadMetrics(
  tx: PoolClient,
  tenantId: string,
  window: MetricsWindow,
): Promise<Metrics> {
  const r = await tx.query<Metrics>(
    `with
       bounds as (
         -- A nullable "$2::interval is null or created_at >= ..." predicate
         -- would not be indexable. The sentinel keeps one indexed shape for
         -- both the windowed and the all-time case.
         select case when $2::text is null then '-infinity'::timestamptz
                     else now() - $2::interval end as since
       ),
       l as (
         select count(*) as leads
           from leads, bounds
          where tenant_id = $1 and created_at >= bounds.since
       ),
       a as (
         select count(*)                                                     as attempts,
                count(*) filter (where status = 'completed')                 as connected,
                round(avg(duration_sec) filter (where status = 'completed')) as avg_duration,
                -- Lead-to-call latency is first_call_started minus
                -- lead_created, measured from queued_at - the moment the
                -- platform accepted responsibility, which is what the 30s
                -- target is about. Stamped at dial time (migration 0013), so
                -- this no longer hash-joins every attempt back to its lead.
                round(percentile_cont(0.95) within group (order by queue_latency_sec)
                      filter (where attempt_no = 1 and queue_latency_sec is not null))
                                                                             as p95_latency_sec
           from call_attempts, bounds
          where tenant_id = $1 and created_at >= bounds.since
       ),
       an as (
         select count(*)                                                     as analyses,
                count(*) filter (where intent = 'hot')                       as hot,
                count(*) filter (where review_status = 'pending_review')     as pending_review,
                count(*) filter (where review_status in ('confirmed','corrected')) as reviewed,
                count(*) filter (where review_status = 'corrected')          as corrected,
                coalesce(sum(input_tokens), 0)                               as input_tokens,
                coalesce(sum(output_tokens), 0)                              as output_tokens,
                round(avg(score))                                            as avg_score
           from call_analyses, bounds
          where tenant_id = $1 and created_at >= bounds.since
       ),
       cb as (
         select count(*)                                     as callbacks,
                count(*) filter (where status = 'completed') as callbacks_done
           from callbacks, bounds
          where tenant_id = $1 and created_at >= bounds.since
       ),
       so as (
         select count(*) filter (where status = 'succeeded')               as sync_ok,
                count(*) filter (where status in ('failed','dead_letter')) as sync_bad
           from sync_outbox, bounds
          where tenant_id = $1 and created_at >= bounds.since
       )
     select * from l, a, an, cb, so`,
    [tenantId, window],
  );

  return r.rows[0]!;
}

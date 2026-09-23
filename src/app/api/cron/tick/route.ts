import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { withScope, withoutScope } from "@/db/client";
import { dispatchDial } from "@/lib/calling/dispatch";
import { drainSyncOutbox } from "@/lib/integrations/sync-worker";
import { markMissedCallbacks } from "@/lib/calling/callbacks";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The scheduled sweep. One endpoint, every tenant, every campaign.
 *
 * `scripts/worker.ts` did this as a long-lived loop against one named
 * campaign. That process cannot exist on a serverless platform, and it was
 * never the right shape anyway: a second client meant a second process, and
 * the campaign name was a command-line argument.
 *
 * What it covers, none of which intake's own dial can:
 *
 *   - retries on the backoff ladder, which come due minutes or hours later
 *
 *   - leads queued outside the calling window, released when it opens
 *   - callbacks a lead asked for at a specific time, and marking the ones
 *     nobody kept
 *   - leads stranded by an invocation that died mid-call, reclaimed on lock
 *     expiry
 *   - the sync outbox, so a HubSpot or Sheets outage clears itself once the
 *     provider recovers
 *
 * It is also the safety net under `after()`: if a webhook's post-response work
 * is dropped, the lead is still queued and this pass places the call. Nothing
 * here is the only path to anything.
 *
 * Authentication is a shared secret, not a service token: service tokens are
 * per tenant and this crosses all of them by design. That is the one
 * privilege boundary this endpoint widens, so it reads only what it needs to
 * enumerate work, then does the work itself inside per-tenant scopes.
 *
 *   Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically.
 */

/** Per campaign per pass. The next pass takes whatever did not fit. */
const DIAL_LIMIT = 10;
const OUTBOX_LIMIT = 25;

/**
 * 60 rather than higher because it is the ceiling every Vercel plan allows: a
 * value above the plan's limit fails the deployment, which is a bad way to
 * find out which plan you are on.
 *
 * Raise it on Pro if a sweep ever needs longer. It should not: the pass is
 * incremental, every claim is committed as it happens, and being cut short
 * loses no work - the next pass takes what did not fit.
 */
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handle(request);
}

/** Vercel Cron issues GET; an external scheduler may be configured for POST. */
export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  // No secret configured means the endpoint is unauthenticated, which would
  // let anyone on the internet drive every tenant's dialler. Refuse to serve
  // rather than defaulting to open.
  if (!secret) {
    logger.error("CRON_SECRET is not set; the scheduled sweep is disabled");
    return NextResponse.json({ error: "Scheduler is not configured" }, { status: 503 });
  }

  if (!authorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();

  try {
    const work = await pendingWork();

    const dialled: Array<{ tenantId: string; campaignId: string; dialled: number; failed: number }> =
      [];

    for (const [tenantId, campaignIds] of work.dialByTenant) {
      const results = await dispatchDial({
        tenantId,
        campaignIds,
        workerId: "cron",
        limit: DIAL_LIMIT,
      });
      for (const r of results) {
        dialled.push({ tenantId, campaignId: r.campaignId, dialled: r.dialled, failed: r.failed });
      }
    }

    const synced: Array<{ tenantId: string; processed: number; succeeded: number; failed: number }> =
      [];

    for (const tenantId of work.outboxTenants) {
      synced.push({ tenantId, ...(await drainForTenant(tenantId)) });
    }

    // Expired rate-limit windows are write-once and never read again, so the
    // table would otherwise accumulate a row per distinct client address
    // forever. Last in the pass and deliberately best-effort: a failed sweep
    // of a housekeeping table must not fail a pass that already placed calls.
    // A callback whose time came and went without a call is the operator's to
    // chase, and they can only chase what the platform admits to. Before the
    // housekeeping, because it is real work rather than tidying.
    const callbacksMissed = await sweepMissedCallbacks();

    const rateLimitRowsCleared = await gcRateLimits();

    const summary = {
      status: "ok" as const,
      campaigns: dialled.length,
      calls_placed: dialled.reduce((n, d) => n + d.dialled, 0),
      calls_failed: dialled.reduce((n, d) => n + d.failed, 0),
      outbox_processed: synced.reduce((n, s) => n + s.processed, 0),
      outbox_failed: synced.reduce((n, s) => n + s.failed, 0),
      callbacks_missed: callbacksMissed,
      rate_limit_rows_cleared: rateLimitRowsCleared,
      duration_ms: Date.now() - started,
    };

    // One line per pass, and only when it did something. A cron running every
    // minute writes 1,440 lines a day; making the quiet ones silent is what
    // keeps the log worth reading.
    if (
      summary.calls_placed ||
      summary.calls_failed ||
      summary.outbox_processed ||
      summary.callbacks_missed
    ) {
      logger.info("cron sweep", {
        ...summary,
      });
    }

    return NextResponse.json(summary);
  } catch (err) {
    logger.error("cron sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

/**
 * Mark callbacks whose requested time has passed with no call behind it.
 *
 * One global-scope pass rather than a loop per tenant: the predicate is the
 * same everywhere, the rows name their own tenant, and a client with no
 * callbacks costs a row count of zero rather than a round trip.
 *
 * Swallows its own errors for the same reason `gcRateLimits` does - a sweep
 * that has already placed calls must not report failure because a bookkeeping
 * update could not take a lock.
 */
async function sweepMissedCallbacks(): Promise<number> {
  try {
    return await withScope(
      { tenantId: null, globalScope: true, actorId: null, actorType: "service" },
      async (tx) => (await markMissedCallbacks(tx)).length,
      "service",
    );
  } catch (err) {
    logger.error("missed-callback sweep failed; sweep otherwise succeeded", {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Drop rate-limit windows that have long since rolled over (migration 0011).
 *
 * Swallows its own errors on purpose. This is housekeeping on a table nothing
 * reads once a window has passed; letting it throw would turn a locked table
 * or a statement timeout into a 500 for a sweep whose real work - dialling and
 * draining the outbox - has already succeeded and committed.
 */
async function gcRateLimits(): Promise<number> {
  try {
    return await withoutScope(async (tx) => {
      const r = await tx.query<{ rate_limit_gc: number }>(
        `select app.rate_limit_gc(interval '1 hour')`,
      );
      return r.rows[0]?.rate_limit_gc ?? 0;
    }, "service");
  } catch (err) {
    logger.error("rate limit gc failed; sweep otherwise succeeded", {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

function authorized(request: NextRequest, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  const given = Buffer.from(header);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Which campaigns have a lead due, and which tenants have a sync waiting.
 *
 * Enumerating in one global-scope read rather than looping every campaign
 * keeps a pass proportional to the work outstanding instead of to the number
 * of clients onboarded - an idle client costs nothing.
 *
 * The predicates deliberately mirror what `claimLeads` and `claimDueSyncs`
 * will actually pick up. A campaign named here may still claim nothing (a
 * closed calling window, a concurrency cap), which is fine; the reverse - work
 * that exists but is never enumerated - would be a lead that never gets
 * called.
 */
async function pendingWork(): Promise<{
  dialByTenant: Map<string, string[]>;
  outboxTenants: string[];
}> {
  return withScope(
    { tenantId: null, globalScope: true, actorId: null, actorType: "service" },
    async (tx) => {
      const due = await tx.query<{ tenant_id: string; campaign_id: string }>(
        `select distinct c.tenant_id, c.id as campaign_id
           from campaigns c
           join tenants t on t.id = c.tenant_id
          where t.status = 'active'
            and c.active
            and exists (
              select 1 from leads l
               where l.campaign_id = c.id
                 and (
                   (l.status = 'queued'
                     and (l.next_call_at is null or l.next_call_at <= now()))
                   -- Stranded by an invocation that died mid-call. claimLeads
                   -- reclaims these, but only for a campaign it is asked about.
                   or (l.status = 'calling' and l.lock_expires_at < now())
                 )
            )
          order by c.tenant_id`,
      );

      const dialByTenant = new Map<string, string[]>();
      for (const row of due.rows) {
        const list = dialByTenant.get(row.tenant_id);
        if (list) list.push(row.campaign_id);
        else dialByTenant.set(row.tenant_id, [row.campaign_id]);
      }

      // Not gated on tenant status: a client suspended mid-flight still needs
      // the results of calls already placed delivered to their CRM.
      const outbox = await tx.query<{ tenant_id: string }>(
        `select distinct tenant_id from sync_outbox
          where status in ('pending', 'failed') and next_attempt_at <= now()`,
      );

      return { dialByTenant, outboxTenants: outbox.rows.map((r) => r.tenant_id) };
    },
    "service",
  );
}

async function drainForTenant(
  tenantId: string,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  try {
    const result = await withScope(
      { tenantId, globalScope: false, actorId: null, actorType: "service" },
      (tx) => drainSyncOutbox(tx, {}, OUTBOX_LIMIT),
      "service",
    );
    return { processed: result.processed, succeeded: result.succeeded, failed: result.failed };
  } catch (err) {
    // One tenant's sealed credential failing to unwrap must not stop the rest.
    logger.error("outbox drain failed for tenant", {
      tenant_id: tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { processed: 0, succeeded: 0, failed: 0 };
  }
}

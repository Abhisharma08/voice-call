import { withScope } from "@/db/client";
import { runCallingTick } from "@/lib/calling/worker";
import { env } from "@/lib/env";
import { log, logger } from "@/lib/observability/log";

/**
 * Dial the leads a request just queued, without making the caller wait.
 *
 * The target is p95 under 30 seconds from CRM ingestion to dial. The queue
 * has always been able to deliver that - `next_call_at` is `now()` the moment
 * intake commits - but nothing asked it to. Something had to tick, and the
 * only thing that did was a scheduler running once a minute, which spends most
 * of that budget waiting.
 *
 * So intake triggers its own tick. The webhook responds first and this runs
 * after (`after()` in the route, `waitUntil` underneath on Vercel), so a
 * HubSpot delivery is acknowledged in milliseconds and the call is placed on
 * the same invocation a moment later.
 *
 * This is an *optimisation on top of* the scheduled sweep in
 * `/api/cron/tick`, never a replacement for it. Everything durable still lives
 * in PostgreSQL: retries, backoff, calling windows and lock expiry are rows.
 * If this never ran - a crashed invocation, a platform that drops post-response
 * work - the sweep picks the same leads up on its next pass. That is the
 * property that lets this fail silently and safely, and it is why nothing here
 * throws.
 */

export interface DispatchResult {
  campaignId: string;
  dialled: number;
  failed: number;
  skipped: string[];
  error?: string;
}

/**
 * Run a calling tick for each campaign named, each in its own transaction.
 *
 * Separate transactions on purpose: one campaign whose provider is
 * misconfigured must not roll back the calls another campaign just placed.
 */
export async function dispatchDial(args: {
  tenantId: string;
  campaignIds: Iterable<string>;
  workerId: string;
  /** Cap per campaign. Intake dials a small burst; the sweep drains the rest. */
  limit?: number;
}): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];

  for (const campaignId of new Set(args.campaignIds)) {
    results.push(await dialOneCampaign(args.tenantId, campaignId, args.workerId, args.limit));
  }

  return results;
}

async function dialOneCampaign(
  tenantId: string,
  campaignId: string,
  workerId: string,
  limit?: number,
): Promise<DispatchResult> {
  try {
    const tick = await withScope(
      { tenantId, globalScope: false, actorId: null, actorType: "service" },
      (tx) =>
        runCallingTick(tx, {
          tenantId,
          campaignId,
          workerId,
          webhookBaseUrl: env().APP_URL,
          limit,
        }),
      "service",
    );

    const result: DispatchResult = {
      campaignId,
      dialled: tick.dialled.filter((d) => d.status === "initiated").length,
      failed: tick.dialled.filter((d) => d.status === "provider_failed").length,
      // Deduplicated: "outside_calling_window" arrives once per tick, but a
      // concurrency cap arrives once per lead, and a log line repeating the
      // same reason twenty times hides the one that differs.
      skipped: [...new Set(tick.skipped.map((s) => s.reason))],
    };

    // Quiet when there was nothing to do. A dial that failed at the provider
    // is not quiet: the call record says `provider_failed` and the reason is
    // worth having in the log next to the lead that caused it.
    if (result.dialled || result.failed || result.skipped.length) {
      log(result.failed ? "warn" : "info", "dial tick", {
        worker_id: workerId,
        tenant_id: tenantId,
        campaign_id: campaignId,
        dialled: result.dialled,
        failed: result.failed,
        skipped: result.skipped,
        details: tick.dialled.filter((d) => d.detail).map((d) => d.detail),
      });
    }

    return result;
  } catch (err) {
    // A campaign that cannot dial must not stop the response, or the next
    // campaign. The lead stays queued and the sweep retries it.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("dial tick failed; leads stay queued for the scheduled sweep", {
      worker_id: workerId,
      tenant_id: tenantId,
      campaign_id: campaignId,
      err: detail,
    });
    return { campaignId, dialled: 0, failed: 0, skipped: [], error: detail };
  }
}

/**
 * The campaigns worth dialling after an intake call, given what it did.
 *
 * Only a lead that actually reached `queued` justifies a tick. A quarantined,
 * suppressed or duplicate-ignored event has nothing to dial, and a replayed
 * delivery least of all - HubSpot retries, and a retry that re-triggered
 * dialling would spend the concurrency cap re-checking leads already in
 * flight.
 */
export function campaignsToDial(
  outcomes: Array<{ queued: boolean; campaignId: string | null }>,
): string[] {
  return [
    ...new Set(
      outcomes
        .filter((o) => o.queued && o.campaignId)
        .map((o) => o.campaignId as string),
    ),
  ];
}

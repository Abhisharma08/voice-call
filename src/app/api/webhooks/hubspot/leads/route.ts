import { NextResponse, after, type NextRequest } from "next/server";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { ingestLead } from "@/lib/leads/intake";
import { HubSpotWebhook, eventsFrom, mapHubSpotEvent } from "@/lib/leads/hubspot-event";
import { campaignsToDial, dispatchDial } from "@/lib/calling/dispatch";
import {
  RateLimits,
  clientAddress,
  consumeRateLimit,
  retryAfterHeaders,
} from "@/lib/ratelimit";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

/**
 * The response returns as soon as intake commits; the call is placed after it,
 * on this same invocation. Long enough for a batched delivery to dial several
 * leads in turn, and well inside HubSpot's own retry behaviour.
 */
export const maxDuration = 60;

/**
 * HubSpot posts here directly (workflow W01, without the workflow).
 *
 * `/api/webhooks/leads` takes this platform's own event shape and is the right
 * endpoint for anything we control. This one takes HubSpot's shape, so a
 * HubSpot workflow's webhook action can call it with no translation layer in
 * between - one less moving part than routing it through n8n to be reshaped.
 *
 * Everything that makes intake safe is unchanged, because this is a mapping in
 * front of the same function: the tenant comes from the service credential
 *, the idempotency key is tenant + source event id, and
 * `ingestLead` still owns dedupe, phone normalisation, consent and the DNC
 * gate.
 *
 * Which campaign the lead belongs to is a query parameter rather than a body
 * field: HubSpot's payload cannot carry it, and a token is per tenant, not per
 * campaign.
 *
 *   POST /api/webhooks/hubspot/leads?campaign=<uuid>
 *   Authorization: Bearer svc_...
 */
export async function POST(request: NextRequest) {
  /**
   * Ahead of the token lookup, so an unauthenticated flood cannot spend a
   * database round trip and a hash comparison per request. Keyed by source
   * address, which is all that is known before the token is verified.
   */
  const limit = await consumeRateLimit(
    RateLimits.leadWebhook,
    clientAddress(request.headers),
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: retryAfterHeaders(limit) },
    );
  }

  const identity = await authenticateService(request, "leads:ingest");
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const campaignId = new URL(request.url).searchParams.get("campaign");
  if (!campaignId || !/^[0-9a-f-]{36}$/i.test(campaignId)) {
    return NextResponse.json(
      { error: "Add ?campaign=<uuid> naming the campaign these leads belong to" },
      { status: 400 },
    );
  }

  const parsed = HubSpotWebhook.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unrecognised HubSpot payload", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const events = eventsFrom(parsed.data);

  try {
    const results = await withServiceScope(identity, async (tx) => {
      const out: Array<{ eventId: string; replay: boolean; result: unknown }> = [];

      // HubSpot batches object-change events, so one delivery can carry
      // several contacts. They share a transaction: either the whole delivery
      // is recorded or none of it is, so a retry cannot half-apply.
      for (const raw of events) {
        const lead = mapHubSpotEvent(raw);
        const idempotencyKey = `hubspot:lead_created:${lead.eventId}`;

        const claim = await tx.query<{ id: string }>(
          `insert into webhook_events
             (tenant_id, source, event_type, idempotency_key, payload)
           values ($1, 'hubspot', 'lead_created', $2, $3)
           on conflict (tenant_id, idempotency_key) do nothing
           returning id`,
          [identity.tenantId, idempotencyKey, JSON.stringify(raw)],
        );

        if (claim.rowCount === 0) {
          const prior = await tx.query<{ result: unknown }>(
            `select result from webhook_events where tenant_id = $1 and idempotency_key = $2`,
            [identity.tenantId, idempotencyKey],
          );
          out.push({
            eventId: lead.eventId,
            replay: true,
            result: prior.rows[0]?.result ?? { status: "accepted" },
          });
          continue;
        }

        const result = await ingestLead(tx, {
          tenantId: identity.tenantId,
          campaignId,
          source: "hubspot",
          recordId: lead.recordId,
          contact: lead.contact,
          consent: lead.consent,
          correlationId: lead.eventId,
        });

        await tx.query(
          `update webhook_events set status = 'processed', processed_at = now(), result = $2
            where id = $1`,
          [claim.rows[0]!.id, JSON.stringify(result)],
        );

        out.push({ eventId: lead.eventId, replay: false, result });
      }

      return out;
    });

    // Dial what was just queued, after the response goes back (target:
    // p95 under 30 seconds from ingestion). A replay dials nothing - HubSpot
    // retries, and the leads it names are already in flight.
    const toDial = campaignsToDial(
      results.map((r) => ({
        queued: !r.replay && (r.result as { status?: string } | null)?.status === "queued",
        campaignId,
      })),
    );

    if (toDial.length > 0) {
      after(() =>
        dispatchDial({
          tenantId: identity.tenantId,
          campaignIds: toDial,
          workerId: "intake-hubspot",
        }),
      );
    }

    // 202: accepted and recorded. A lead can be quarantined or suppressed and
    // that is still a successful delivery - HubSpot must not retry because we
    // declined to call someone.
    return NextResponse.json({ accepted: results.length, results }, { status: 202 });
  } catch (err) {
    logger.error("hubspot intake failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Intake failed" }, { status: 500 });
  }
}

import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { ingestLead } from "@/lib/leads/intake";
import { dispatchDial } from "@/lib/calling/dispatch";
import {
  RateLimits,
  clientAddress,
  consumeRateLimit,
  retryAfterHeaders,
} from "@/lib/ratelimit";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

/** The response returns on commit; the call is placed after it. See dispatch.ts. */
export const maxDuration = 60;

/**
 * Lead intake ingress (workflow W01).
 *
 * the lead intake event, with two changes the contract there implies but
 * does not spell out: the tenant comes from the service credential rather than
 * `tenant_ref` in the body, and every event is recorded for
 * idempotency before it is processed.
 */

const Body = z.object({
  event_id: z.string().min(1),
  source: z.string().min(1).default("hubspot"),
  record_id: z.string().min(1).nullable().default(null),
  campaign_ref: z.string().uuid(),
  contact: z.object({
    name: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    // What the lead typed into the form. Capped rather than unbounded: it is
    // spoken back to them, and a form field pasted full of prose is a bug
    // upstream, not something to read down a phone line.
    requirement: z.string().max(2000).nullable().optional(),
  }),
  consent: z
    .object({
      basis: z.enum(["opt_in_form", "existing_customer", "service_call", "ivr_confirmation", "other"]),
      source: z.string().min(1),
      evidence_ref: z.string().nullable().optional(),
      captured_at: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  correlation_id: z.string().nullable().optional(),
});

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

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid event", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const event = parsed.data;
  // Tenant + source event id + event type.
  const idempotencyKey = `${event.source}:lead_created:${event.event_id}`;

  try {
    const outcome = await withServiceScope(identity, async (tx) => {
      const claim = await tx.query<{ id: string; result: unknown }>(
        `insert into webhook_events
           (tenant_id, source, event_type, idempotency_key, payload, correlation_id)
         values ($1, $2, 'lead_created', $3, $4, $5)
         on conflict (tenant_id, idempotency_key) do nothing
         returning id, result`,
        [
          identity.tenantId,
          event.source,
          idempotencyKey,
          JSON.stringify(event),
          event.correlation_id ?? null,
        ],
      );

      if (claim.rowCount === 0) {
        // Already seen. Return the stored outcome so a retrying caller gets
        // the same answer instead of a second lead.
        const prior = await tx.query<{ result: unknown }>(
          `select result from webhook_events where tenant_id = $1 and idempotency_key = $2`,
          [identity.tenantId, idempotencyKey],
        );
        return { replay: true, result: prior.rows[0]?.result ?? { status: "accepted" } };
      }

      const result = await ingestLead(tx, {
        tenantId: identity.tenantId,
        campaignId: event.campaign_ref,
        source: event.source,
        recordId: event.record_id,
        contact: event.contact,
        consent: event.consent
          ? {
              basis: event.consent.basis,
              source: event.consent.source,
              evidenceRef: event.consent.evidence_ref ?? null,
              capturedAt: event.consent.captured_at ?? null,
            }
          : null,
        correlationId: event.correlation_id ?? null,
      });

      await tx.query(
        `update webhook_events set status = 'processed', processed_at = now(), result = $2
          where id = $1`,
        [claim.rows[0]!.id, JSON.stringify(result)],
      );

      return { replay: false, result };
    });

    // Dial immediately rather than waiting for the scheduled sweep. A
    // replay dials nothing: the lead it names is already in flight.
    if (!outcome.replay && (outcome.result as { status?: string } | null)?.status === "queued") {
      after(() =>
        dispatchDial({
          tenantId: identity.tenantId,
          campaignIds: [event.campaign_ref],
          workerId: "intake-api",
        }),
      );
    }

    return NextResponse.json(outcome, { status: outcome.replay ? 200 : 202 });
  } catch (err) {
    logger.error("lead intake failed", {
      tenant_id: identity.tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Intake failed" }, { status: 500 });
  }
}

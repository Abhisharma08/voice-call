import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { ingestLead } from "@/lib/leads/intake";

export const runtime = "nodejs";

/**
 * Lead intake ingress (FR-010, workflow W01).
 *
 * PRD 20's lead intake event, with two changes the contract there implies but
 * does not spell out: the tenant comes from the service credential rather than
 * `tenant_ref` in the body (PRD 8.2), and every event is recorded for
 * idempotency before it is processed (PRD 18.1).
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
  // PRD 18.1: tenant + source event id + event type.
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

    return NextResponse.json(outcome, { status: outcome.replay ? 200 : 202 });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "lead intake failed",
        tenant_id: identity.tenantId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "Intake failed" }, { status: 500 });
  }
}

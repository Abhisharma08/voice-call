import { NextResponse, type NextRequest } from "next/server";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { resolveProvider } from "@/lib/providers/voice";
import { ProviderError } from "@/lib/providers/voice/types";
import { recordCallResult } from "@/lib/calling/results";
import { recordUnscopedAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Voice provider callbacks (W02 step 6, FR-023).
 *
 * The provider adapter verifies the signature and normalises the payload, so
 * nothing vendor-specific reaches the platform. PRD 18.2: "Webhook signature
 * invalid - No - Reject + security log."
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: providerName } = await context.params;

  const identity = await authenticateService(request, "calls:result");
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  let provider;
  try {
    provider = resolveProvider(providerName);
  } catch {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  let webhook;
  try {
    webhook = provider.handleWebhook(rawBody, headers);
  } catch (err) {
    await recordUnscopedAudit({
      tenantId: identity.tenantId,
      actorType: "system",
      action: "webhook.signature_rejected",
      entityType: "provider",
      entityId: providerName,
      metadata: { detail: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const outcome = await withServiceScope(identity, async (tx) => {
      // PRD 18.1: call result idempotency key = provider + provider_call_id.
      const idempotencyKey = `voice:${providerName}:${webhook.providerCallId}:${webhook.status}`;

      const claim = await tx.query<{ id: string }>(
        `insert into webhook_events
           (tenant_id, source, event_type, idempotency_key, payload)
         values ($1, $2, 'call_status', $3, $4)
         on conflict (tenant_id, idempotency_key) do nothing
         returning id`,
        [identity.tenantId, providerName, idempotencyKey, JSON.stringify(webhook)],
      );

      if (claim.rowCount === 0) return { status: "duplicate" as const, callId: null, needsAnalysis: false };

      const result = await recordCallResult(tx, {
        tenantId: identity.tenantId,
        provider: providerName,
        webhook,
      });

      await tx.query(
        `update webhook_events set status = 'processed', processed_at = now(), result = $2
          where id = $1`,
        [claim.rows[0]!.id, JSON.stringify(result)],
      );

      return result;
    });

    if (outcome.status === "unknown_call") {
      // Acknowledge rather than 404: a provider that gets an error will retry
      // forever for a call we genuinely do not have.
      return NextResponse.json({ status: "ignored" }, { status: 202 });
    }

    return NextResponse.json(outcome, { status: 202 });
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(
      JSON.stringify({
        level: "error",
        msg: "voice webhook failed",
        provider: providerName,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

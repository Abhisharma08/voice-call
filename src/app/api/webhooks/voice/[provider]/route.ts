import { NextResponse, after, type NextRequest } from "next/server";
import { withScope } from "@/db/client";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { resolveProvider } from "@/lib/providers/voice";
import { ProviderError, type NormalizedWebhook } from "@/lib/providers/voice/types";
import { publicRequestUrl } from "@/lib/providers/voice/public-url";
import { recordCallResult } from "@/lib/calling/results";
import { qualifyCall } from "@/lib/qualification/pipeline";
import { flushTenantOutbox } from "@/lib/integrations/sync-worker";
import { recordUnscopedAudit } from "@/lib/audit";
import {
  RateLimits,
  clientAddress,
  consumeRateLimit,
  retryAfterHeaders,
} from "@/lib/ratelimit";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

/**
 * Voice provider callbacks (W02 step 6, FR-023).
 *
 * Two authentication paths, because carriers and API providers differ:
 *
 *   A provider that signs its callbacks (Twilio) authenticates itself. It
 *   cannot attach a bearer token - Twilio posts a status callback, it does not
 *   hold our credentials - so the signature is the credential, and the tenant
 *   is resolved from the call record the SID names.
 *
 *   A provider that does not sign (Sarvam) must also present a service token,
 *   which is where its tenant comes from.
 *
 * Either way the adapter verifies first and normalises second, so nothing
 * vendor-specific reaches the platform. PRD 18.2: "Webhook signature invalid -
 * No - Reject + security log."
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: providerName } = await context.params;

  let provider;
  try {
    provider = resolveProvider(providerName);
  } catch {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  /**
   * Ahead of signature verification, which is where the real work starts:
   * normalising a payload and, for an unsigned provider, a token lookup. An
   * unauthenticated caller reaches both, so the ceiling has to come first.
   *
   * Sized well above a busy campaign's callback rate - a call produces a
   * handful of status updates, not hundreds - so this bounds a flood without
   * being reachable by legitimate provider traffic.
   */
  const limit = await consumeRateLimit(
    RateLimits.voiceWebhook,
    `${providerName}:${clientAddress(request.headers)}`,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: retryAfterHeaders(limit) },
    );
  }

  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  let webhook: NormalizedWebhook;
  try {
    // Not request.url: a provider signs the public URL it called, which is not
    // the internal one this process sees behind a tunnel or load balancer.
    webhook = provider.handleWebhook(rawBody, headers, publicRequestUrl(request.url));
  } catch (err) {
    await recordUnscopedAudit({
      tenantId: null,
      actorType: "system",
      action: "webhook.signature_rejected",
      entityType: "provider",
      entityId: providerName,
      metadata: { detail: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const identity = await authenticateService(request, "calls:result");
  const selfAuthenticating = provider.metadata().verifiesWebhookSignature === true;

  if (!identity && !selfAuthenticating) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // For a self-authenticating provider the call record is what ties this
  // callback to a tenant. A SID we have no record of is acknowledged, not
  // trusted.
  const tenantId =
    identity?.tenantId ??
    (await tenantForCall(providerName, webhook.providerCallId));

  if (!tenantId) {
    return NextResponse.json({ status: "ignored" }, { status: 202 });
  }

  try {
    const outcome = await process(providerName, tenantId, webhook);

    if (outcome.status === "unknown_call") {
      // Acknowledge rather than 404: a provider that gets an error will retry
      // forever for a call we genuinely do not have.
      return NextResponse.json({ status: "ignored" }, { status: 202 });
    }

    // A completed call with a transcript is ready to qualify, and this is the
    // moment we know it. Workflow W03 existed only to notice `needsAnalysis`
    // and call /api/internal/analyze back; doing it here removes that round
    // trip and the scheduler that made it.
    //
    // Deliberately after the result is committed and in its own transaction:
    // the call record is the durable fact, and analysis is a derived one. If
    // the model is rate limited or the key is wrong, the provider still gets
    // its 202 and the call is not lost - `/api/internal/analyze` remains
    // callable to pick it up, and qualifyCall is idempotent per call.
    const analysis =
      outcome.status === "recorded" && outcome.needsAnalysis && outcome.callId
        ? await qualify(tenantId, outcome.callId)
        : null;

    // Qualification enqueues the Sheets append, the HubSpot update and the hot
    // lead notification into sync_outbox. Draining it here rather than leaving
    // it to the next cron pass is the difference between a result landing in
    // the client's sheet now and up to a minute from now - which, for a caller
    // watching the sheet after a call, is the whole of what "slow" means.
    //
    // After the response, because the provider does not need to wait for a
    // Google Sheets round trip to learn we accepted its callback, and only
    // when something was actually enqueued.
    if (analysis && "synced" in analysis && analysis.synced) {
      after(() => flushTenantOutbox(tenantId));
    }

    return NextResponse.json({ ...outcome, analysis }, { status: 202 });
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error("voice webhook failed", {
      provider: providerName,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

/**
 * Resolve the owning tenant from the call the provider's id names.
 *
 * This has to cross tenants: the callback arrives with no session and no
 * service token, so the provider's call id is the only thing tying it to one,
 * and which tenant that is cannot be known before the lookup. `withoutScope`
 * is the wrong tool - it leaves RLS enforced with no tenant set, so this table
 * is invisible and every callback resolves to null and is quietly ignored.
 *
 * Global scope is narrow here by construction: both arguments come from a
 * payload whose signature has already been verified, and the only column read
 * is the tenant id.
 */
async function tenantForCall(provider: string, providerCallId: string): Promise<string | null> {
  return withScope(
    { tenantId: null, globalScope: true, actorId: null, actorType: "service" },
    async (tx) => {
      const r = await tx.query<{ tenant_id: string }>(
        `select tenant_id from call_attempts where provider = $1 and provider_call_id = $2`,
        [provider, providerCallId],
      );
      return r.rows[0]?.tenant_id ?? null;
    },
  );
}

/**
 * Qualify a completed call, without letting a model failure fail the callback.
 *
 * The provider is telling us what happened to a phone call. That fact is
 * already stored; whether the LLM answered is a separate concern, and turning
 * a rate limit into a 500 would make the provider retry a callback we have
 * already handled.
 */
async function qualify(tenantId: string, callId: string) {
  const scope = {
    tenantId,
    globalScope: false,
    actorId: null,
    actorType: "service" as const,
  };

  try {
    return await withScope(scope, (tx) => qualifyCall(tx, { tenantId, callId }), "service");
  } catch (err) {
    logger.error("inline qualification failed; call is recorded and can be re-analysed", {
      callId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { error: "qualification_deferred" };
  }
}

async function process(providerName: string, tenantId: string, webhook: NormalizedWebhook) {
  const scope = {
    tenantId,
    globalScope: false,
    actorId: null,
    actorType: "service" as const,
  };

  const run = async (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => {
    // PRD 18.1: call result idempotency key = provider + provider_call_id.
    // The status is part of the key because a provider reports several
    // interim events per call, and each is a distinct fact.
    const idempotencyKey = `voice:${providerName}:${webhook.providerCallId}:${webhook.status}`;

    const claim = await tx.query<{ id: string }>(
      `insert into webhook_events (tenant_id, source, event_type, idempotency_key, payload)
       values ($1, $2, 'call_status', $3, $4)
       on conflict (tenant_id, idempotency_key) do nothing
       returning id`,
      [tenantId, providerName, idempotencyKey, JSON.stringify(webhook)],
    );

    if (claim.rowCount === 0) {
      return { status: "duplicate" as const, callId: null, needsAnalysis: false };
    }

    const result = await recordCallResult(tx, {
      tenantId,
      provider: providerName,
      webhook,
    });

    await tx.query(
      `update webhook_events set status = 'processed', processed_at = now(), result = $2
        where id = $1`,
      [claim.rows[0]!.id, JSON.stringify(result)],
    );

    return result;
  };

  return withScope(scope, run, "service");
}

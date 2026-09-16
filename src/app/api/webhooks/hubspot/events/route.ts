import { NextResponse, after, type NextRequest } from "next/server";
import { withScope, withoutScope } from "@/db/client";
import { openSecret } from "@/lib/crypto/kms";
import type { HubSpotCredentials } from "@/lib/integrations/hubspot";
import { HubSpotClient, IntegrationError } from "@/lib/integrations/hubspot";
import { verifyHubSpotSignature } from "@/lib/integrations/hubspot-signature";
import {
  HubSpotSubscriptionDelivery,
  eventTypeOf,
  type HubSpotSubscriptionEvent,
} from "@/lib/leads/hubspot-event";
import {
  ingestSubscriptionEvents,
  type SubscriptionIntakeResult,
} from "@/lib/leads/hubspot-app-intake";
import { publicRequestUrl } from "@/lib/providers/voice/public-url";
import { campaignsToDial, dispatchDial } from "@/lib/calling/dispatch";
import { recordUnscopedAudit } from "@/lib/audit";
import {
  RateLimits,
  clientAddress,
  consumeRateLimit,
  retryAfterHeaders,
} from "@/lib/ratelimit";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lead intake from a HubSpot **private app** subscription - the path that
 * works on a free portal.
 *
 * Free HubSpot has no workflows, so the "Send a webhook" action that
 * `/api/webhooks/hubspot/leads` is built for does not exist for most clients.
 * Every tier can create a private app, and a private app can subscribe to
 * `contact.creation`. That subscription differs in three ways, and this file
 * is those three differences:
 *
 *   1. **No properties.** The event names an object and an account. The
 *      contact is fetched back over the CRM API with the client's own access
 *      token before there is anything to call anyone about.
 *
 *   2. **No Authorization header.** HubSpot signs with
 *      `X-HubSpot-Signature-v3` instead, so the signature is the credential
 *      and `portalId` is the only tenant hint - which means the signature has
 *      to be verified *before* the portal id is trusted for anything at all.
 *
 *   3. **One URL per portal.** The campaign cannot be a query parameter, so it
 *      is routed from a contact property.
 *
 * Everything downstream is unchanged, because this is a different front door
 * onto the same `ingestLead`: dedupe, phone normalisation, consent and the DNC
 * gate are untouched, the idempotency key is still tenant + source event id
 * (PRD 18.1), and a queued lead still dials on this invocation.
 *
 *   POST /api/webhooks/hubspot/events
 */

/**
 * Each event costs one CRM fetch, and HubSpot batches a delivery. Work is done
 * inline rather than after the response on purpose: a non-2xx makes HubSpot
 * retry for up to 24 hours, which is the only redelivery mechanism there is
 * here. Acknowledging first and failing later would lose the lead silently.
 */
export const maxDuration = 60;

/**
 * A cap on one delivery, so a bulk import cannot hold the invocation open past
 * its limit. HubSpot redelivers what is not acknowledged, and the sweep is not
 * a fallback for intake - so this returns 429 rather than dropping the tail.
 */
const MAX_EVENTS_PER_DELIVERY = 40;

export async function POST(request: NextRequest) {
  /**
   * Before anything else, because of the order this endpoint is forced into.
   *
   * HubSpot signs with the client's own secret, so verifying a signature means
   * first resolving the portal and unsealing that client's credential - a
   * lookup and an AES unwrap that an unsigned request has already cost us by
   * the time it is rejected. The limiter is the only ceiling that applies
   * before that work, so it runs before the body is even read.
   *
   * Keyed by source address rather than portal id: the portal id in an
   * unverified payload is a claim, and bucketing by it would let an attacker
   * exhaust a real client's budget by naming them.
   */
  const limit = await consumeRateLimit(
    RateLimits.hubspotWebhook,
    clientAddress(request.headers),
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: retryAfterHeaders(limit) },
    );
  }

  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const parsed = HubSpotSubscriptionDelivery.safeParse(safeJson(rawBody));
  if (!parsed.success) {
    // Unsigned and unparseable: nothing here identifies a client, so there is
    // no tenant to attribute this to.
    return NextResponse.json({ error: "Unrecognised HubSpot delivery" }, { status: 400 });
  }

  const events = parsed.data;

  // One private app serves one portal, so a delivery mixing portals is not
  // something HubSpot does - it is someone stitching payloads together, and
  // verifying against the first portal's secret would then apply that
  // client's trust to another's events.
  const portals = new Set(events.map((e) => String(e.portalId)));
  if (portals.size !== 1) {
    await reject("mixed_portal_ids", { portals: [...portals] });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const portalId = Number([...portals][0]);
  if (!Number.isSafeInteger(portalId) || portalId <= 0) {
    return NextResponse.json({ error: "Unrecognised HubSpot delivery" }, { status: 400 });
  }

  const integration = await integrationForPortal(portalId);

  // An unknown portal gets the same answer as a bad signature (PRD 23.3): a
  // caller must not be able to enumerate which portals this platform serves.
  if (!integration?.credentials.clientSecret) {
    await reject(integration ? "no_client_secret_stored" : "unknown_portal", { portalId });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const verdict = verifyHubSpotSignature({
    clientSecret: integration.credentials.clientSecret,
    method: "POST",
    // Not request.url: HubSpot signs the public URL it called, which behind a
    // proxy or tunnel is not the address this process received.
    url: publicRequestUrl(request.url),
    rawBody,
    headers,
  });

  if (!verdict.valid) {
    await reject(verdict.reason, { portalId, tenant_id: integration.tenantId });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Signature verified. From here the portal id is trusted, and everything
  // runs inside that one tenant's scope.
  const creations = events.filter((e) => eventTypeOf(e) === "contact.creation");

  if (creations.length === 0) {
    // A subscription we do not act on. Acknowledged, so HubSpot stops.
    return NextResponse.json({ accepted: 0, ignored: events.length }, { status: 200 });
  }

  if (creations.length > MAX_EVENTS_PER_DELIVERY) {
    return NextResponse.json(
      { error: "Too many events in one delivery", limit: MAX_EVENTS_PER_DELIVERY },
      { status: 429 },
    );
  }

  try {
    const results = await handle(integration, creations);

    const toDial = campaignsToDial(results);
    if (toDial.length > 0) {
      after(() =>
        dispatchDial({
          tenantId: integration.tenantId,
          campaignIds: toDial,
          workerId: "intake-hubspot-app",
        }),
      );
    }

    return NextResponse.json(
      { accepted: results.length, results: results.map(publicResult) },
      { status: 200 },
    );
  } catch (err) {
    // A 5xx is how HubSpot is told to redeliver. An expired token or a CRM
    // outage must land here rather than being swallowed into a 200, or the
    // lead is lost with no record that it existed.
    const retryable = err instanceof IntegrationError ? err.retryable : true;
    logger.error("hubspot private-app intake failed", {
      tenant_id: integration.tenantId,
      portal_id: portalId,
      retryable,
      err: err instanceof Error ? err.message : String(err),
    });

    return NextResponse.json(
      { error: "Intake failed" },
      // A permanent failure still returns 5xx: HubSpot's retries are the only
      // redelivery there is, and a wrong token is usually fixed within them.
      { status: 500 },
    );
  }
}

/** The tenant-scoped half: fetch each contact, route it, ingest it. */
async function handle(
  integration: PortalIntegration,
  events: HubSpotSubscriptionEvent[],
): Promise<SubscriptionIntakeResult[]> {
  const client = new HubSpotClient(integration.credentials);

  return withScope(
    { tenantId: integration.tenantId, globalScope: false, actorId: null, actorType: "service" },
    (tx) =>
      ingestSubscriptionEvents(tx, {
        tenantId: integration.tenantId,
        contacts: client,
        events,
      }),
    "service",
  );
}

/**
 * What goes back to HubSpot. No phone number, no name, no reason text: the
 * response body is written to HubSpot's own delivery log, which is not a place
 * to put a lead's details or an internal message (PRD 26.2).
 */
function publicResult(result: SubscriptionIntakeResult): { eventId: string; status: string } {
  return { eventId: result.eventId, status: result.status };
}

interface PortalIntegration {
  tenantId: string;
  integrationId: string;
  status: string;
  credentials: HubSpotCredentials;
}

/**
 * Resolve a portal to the client that owns it, and unseal its credential.
 *
 * `withoutScope` is correct here and `withScope` is not: no tenant is known
 * yet, and this reads through `app.hubspot_portal_lookup`, a SECURITY DEFINER
 * function that exposes exactly the columns the signature check needs - the
 * same pattern login uses for the one read that precedes knowing the user
 * (migration 0003). `integrations` and `secrets` stay closed to the runtime
 * roles.
 */
async function integrationForPortal(portalId: number): Promise<PortalIntegration | null> {
  const row = await withoutScope(async (tx) => {
    const r = await tx.query<{
      tenant_id: string;
      integration_id: string;
      status: string;
      key_id: string;
      wrapped_dek: Buffer;
      iv: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(`select * from app.hubspot_portal_lookup($1)`, [portalId]);
    return r.rows[0] ?? null;
  }, "service");

  if (!row) return null;

  try {
    const raw = openSecret(
      {
        keyId: row.key_id,
        wrappedDek: row.wrapped_dek,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      },
      "hubspot",
    );

    return {
      tenantId: row.tenant_id,
      integrationId: row.integration_id,
      status: row.status,
      credentials: JSON.parse(raw) as HubSpotCredentials,
    };
  } catch (err) {
    // A credential sealed under a key this deployment no longer holds. Worth a
    // loud log: it presents as every one of this client's leads being rejected
    // as an invalid signature.
    logger.error("could not unseal HubSpot credential for portal", {
      portal_id: portalId,
      tenant_id: row.tenant_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function reject(reason: string, metadata: Record<string, unknown>): Promise<void> {
  // PRD 18.2: "Webhook signature invalid - No - Reject + security log."
  await recordUnscopedAudit({
    tenantId: null,
    actorType: "system",
    action: "webhook.signature_rejected",
    entityType: "provider",
    entityId: "hubspot",
    metadata: { reason, ...metadata },
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

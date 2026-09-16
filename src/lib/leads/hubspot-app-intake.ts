import type { PoolClient } from "pg";
import {
  contactPropertiesToFetch,
  eventFromContact,
  mapHubSpotEvent,
  type HubSpotSubscriptionEvent,
} from "@/lib/leads/hubspot-event";
import { resolveCampaignForContact, routingProperties } from "@/lib/leads/campaign-routing";
import { ingestLead } from "@/lib/leads/intake";
import { logger } from "@/lib/observability/log";

/**
 * Turn HubSpot private-app subscription events into leads.
 *
 * Separate from the route because this is the part with the interesting
 * behaviour - fetch, route, dedupe, ingest - and a route handler is an awkward
 * place to test it from. The signature check and the portal lookup stay in the
 * route, where the raw request lives.
 *
 * The CRM read is an injected dependency for the same reason: the happy path
 * of "a contact became a queued lead" is the thing most worth having a test
 * for, and it should not require a live HubSpot account to exercise.
 */

/** Just enough of HubSpotClient to fetch a contact. */
export interface ContactSource {
  getContact(contactId: string, properties: string[]): Promise<Record<string, unknown> | null>;
}

export interface SubscriptionIntakeResult {
  eventId: string;
  contactId: string;
  queued: boolean;
  campaignId: string | null;
  status: "queued" | "quarantined" | "suppressed" | "duplicate_ignored" | "replay" | "contact_gone" | "unrouted";
  detail?: string;
}

export async function ingestSubscriptionEvents(
  tx: PoolClient,
  args: {
    tenantId: string;
    contacts: ContactSource;
    events: HubSpotSubscriptionEvent[];
  },
): Promise<SubscriptionIntakeResult[]> {
  // Asked once per delivery rather than per event: the property list is a
  // property of the tenant's configuration, not of the contact.
  const wanted = contactPropertiesToFetch(await routingProperties(tx, args.tenantId));
  const out: SubscriptionIntakeResult[] = [];

  for (const event of args.events) {
    const eventId = String(event.eventId);
    const contactId = String(event.objectId);

    // PRD 18.1: tenant + source event id + event type. HubSpot retries a
    // delivery it did not see acknowledged, and the whole point of the key is
    // that a retry costs a lookup rather than a second call to a person.
    const idempotencyKey = `hubspot:app:contact.creation:${eventId}`;

    const claim = await tx.query<{ id: string }>(
      `insert into webhook_events
         (tenant_id, source, event_type, idempotency_key, payload)
       values ($1, 'hubspot', 'lead_created', $2, $3)
       on conflict (tenant_id, idempotency_key) do nothing
       returning id`,
      [args.tenantId, idempotencyKey, JSON.stringify(event)],
    );

    if (claim.rowCount === 0) {
      out.push({ eventId, contactId, queued: false, campaignId: null, status: "replay" });
      continue;
    }

    const claimId = claim.rows[0]!.id;
    const finish = (result: unknown) =>
      tx.query(
        `update webhook_events set status = 'processed', processed_at = now(), result = $2
          where id = $1`,
        [claimId, JSON.stringify(result)],
      );

    // The properties the webhook did not carry.
    const properties = await args.contacts.getContact(contactId, wanted);

    if (!properties) {
      // Created and deleted before we fetched it. A real race, not a fault:
      // recorded as handled so HubSpot stops retrying it.
      await finish({ status: "contact_gone" });
      out.push({ eventId, contactId, queued: false, campaignId: null, status: "contact_gone" });
      continue;
    }

    const routing = await resolveCampaignForContact(tx, {
      tenantId: args.tenantId,
      properties,
    });

    if (!routing.routed) {
      // Deliberately not ingested against a guessed campaign: the script, the
      // questions and the consent basis all come from the campaign, so the
      // wrong one is worse than none. Recorded so it is a visible problem
      // rather than a lead that vanished.
      await finish({ status: "unrouted", reason: routing.reason });
      logger.error("hubspot lead could not be routed to a campaign", {
        tenant_id: args.tenantId,
        contact_id: contactId,
        reason: routing.reason,
      });
      out.push({
        eventId,
        contactId,
        queued: false,
        campaignId: null,
        status: "unrouted",
        detail: routing.reason,
      });
      continue;
    }

    const lead = mapHubSpotEvent(eventFromContact({ eventId, contactId, properties }));

    const outcome = await ingestLead(tx, {
      tenantId: args.tenantId,
      campaignId: routing.route.campaignId,
      source: "hubspot",
      recordId: lead.recordId ?? contactId,
      contact: lead.contact,
      consent: lead.consent,
      correlationId: eventId,
    });

    await finish({ ...outcome, routed: routing.route });

    out.push({
      eventId,
      contactId,
      queued: outcome.status === "queued",
      campaignId: routing.route.campaignId,
      status: outcome.status,
    });
  }

  return out;
}

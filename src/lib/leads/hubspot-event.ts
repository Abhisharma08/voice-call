import { z } from "zod";

/**
 * HubSpot's own webhook shape, mapped to this platform's intake event.
 *
 * This mapping used to live in an n8n Code node. It is here instead because it
 * is the part most likely to be wrong: property names differ per portal, forms
 * get renamed, and "which field held the requirement?" is a question worth
 * answering in something that typechecks and has tests, rather than in a JSON
 * blob inside a workflow export.
 *
 * HubSpot posts an array of events for object changes, and a single object for
 * a workflow webhook action. Both are accepted.
 *
 * What is deliberately NOT taken from the payload: the tenant - the
 * platform derives it from the service credential, never from the caller. A
 * second client means a second token, not an extra field.
 */

/**
 * Contact properties, as HubSpot sends them. Everything is optional because a
 * portal only sends what it has, and every unknown key is ignored rather than
 * rejected - a new field on the client's form must not start failing intake.
 */
const Properties = z
  .object({
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
    phone: z.string().nullish(),
    mobilephone: z.string().nullish(),
    email: z.string().nullish(),

    // The enquiry itself. `requirement` first because that is what we ask a
    // client to name their field; the rest are HubSpot's usual suspects for a
    // free-text "what do you need" box.
    requirement: z.string().nullish(),
    product_interest: z.string().nullish(),
    what_are_you_looking_for: z.string().nullish(),
    message: z.string().nullish(),

    // Consent, as collected upstream by the form (migration 0008: recorded
    // here, never demanded).
    consent_basis: z.string().nullish(),
    consent_source: z.string().nullish(),
    consent_evidence_ref: z.string().nullish(),
    consent_captured_at: z.string().nullish(),
    hs_legal_basis: z.string().nullish(),
    hs_marketable_status: z.union([z.string(), z.boolean()]).nullish(),

    hs_analytics_source: z.string().nullish(),
    hs_latest_source: z.string().nullish(),
    hs_object_id: z.union([z.string(), z.number()]).nullish(),
    createdate: z.string().nullish(),
  })
  .passthrough();

const Event = z.object({
  eventId: z.union([z.string(), z.number()]).nullish(),
  objectId: z.union([z.string(), z.number()]).nullish(),
  subscriptionType: z.string().nullish(),
  properties: Properties.optional().default({}),
});

/** A single event object, or the array HubSpot sends for object changes. */
export const HubSpotWebhook = z.union([Event, z.array(Event).min(1)]);

export type HubSpotEvent = z.infer<typeof Event>;

const CONSENT_BASES = [
  "opt_in_form",
  "existing_customer",
  "service_call",
  "ivr_confirmation",
  "other",
] as const;

export interface MappedLead {
  eventId: string;
  recordId: string | null;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    requirement: string | null;
  };
  consent: {
    basis: (typeof CONSENT_BASES)[number];
    source: string;
    evidenceRef: string | null;
    capturedAt: string | null;
  } | null;
}

function first(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * A basis this platform recognises, or null.
 *
 * An unrecognised string becomes `other` rather than being dropped: the fact
 * that the form recorded *something* is itself worth keeping, and losing it
 * would silently weaken the evidence trail. Nothing at all stays null, and
 * intake then falls back to the campaign's declared origin.
 */
function consentBasis(props: HubSpotEvent["properties"]): MappedLead["consent"] | null {
  const declared = first(props.consent_basis);
  const marketable =
    props.hs_marketable_status === true || props.hs_marketable_status === "true";
  const implied = Boolean(first(props.hs_legal_basis)) || marketable;

  if (!declared && !implied) return null;

  const basis = CONSENT_BASES.find((b) => b === declared) ?? (declared ? "other" : "opt_in_form");

  return {
    basis,
    source:
      first(
        props.consent_source,
        props.hs_analytics_source,
        props.hs_latest_source === "PAID_SOCIAL" ? "meta_lead_form" : null,
      ) ?? "hubspot",
    evidenceRef: first(props.consent_evidence_ref, str(props.hs_object_id)),
    capturedAt: first(props.consent_captured_at, props.createdate),
  };
}

function str(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function mapHubSpotEvent(event: HubSpotEvent): MappedLead {
  const props = event.properties;
  const recordId = first(str(event.objectId), str(props.hs_object_id));

  return {
    // The event id is the idempotency key upstream. HubSpot retries a failed
    // webhook, so falling back to the object id keeps a retry from creating a
    // second lead - the same contact resolves to the same key.
    eventId: first(str(event.eventId), recordId) ?? `hubspot:${Date.now()}`,
    recordId,
    contact: {
      name: first([props.firstname, props.lastname].filter(Boolean).join(" ")),
      phone: first(props.phone, props.mobilephone),
      email: first(props.email),
      requirement: first(
        props.requirement,
        props.product_interest,
        props.what_are_you_looking_for,
        props.message,
      ),
    },
    consent: consentBasis(props),
  };
}

/** Normalise either accepted body shape into a list of events. */
export function eventsFrom(body: z.infer<typeof HubSpotWebhook>): HubSpotEvent[] {
  return Array.isArray(body) ? body : [body];
}

// ─────────────────────────────────────────────────────────────────────────────
// Private-app webhooks (free tier)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a HubSpot private-app webhook actually delivers.
 *
 * Note what is *not* here: the contact. A subscription event names an object
 * and an account and nothing else, so the properties above have to be fetched
 * back over the CRM API before there is anything to call anyone about. That is
 * the single biggest difference from the workflow-action payload, and the
 * reason intake needs the client's access token rather than only the
 * write-back path needing it.
 *
 * `subscriptionType` is the documented field; `eventType` appears in some of
 * HubSpot's own examples for the same value, so both are accepted rather than
 * making the choice of example the thing that breaks intake.
 */
export const HubSpotSubscriptionEvent = z
  .object({
    eventId: z.union([z.string(), z.number()]),
    subscriptionId: z.union([z.string(), z.number()]).nullish(),
    portalId: z.union([z.string(), z.number()]),
    appId: z.union([z.string(), z.number()]).nullish(),
    occurredAt: z.union([z.string(), z.number()]).nullish(),
    subscriptionType: z.string().nullish(),
    eventType: z.string().nullish(),
    attemptNumber: z.number().nullish(),
    objectId: z.union([z.string(), z.number()]),
    changeSource: z.string().nullish(),
    // Present on propertyChange events only.
    propertyName: z.string().nullish(),
    propertyValue: z.string().nullish(),
  })
  .passthrough();

/** HubSpot always posts an array here, even for a single event. */
export const HubSpotSubscriptionDelivery = z.array(HubSpotSubscriptionEvent).min(1);

export type HubSpotSubscriptionEvent = z.infer<typeof HubSpotSubscriptionEvent>;

export function eventTypeOf(event: HubSpotSubscriptionEvent): string {
  return (event.subscriptionType ?? event.eventType ?? "").trim();
}

/**
 * The properties to ask HubSpot for when fetching a contact.
 *
 * Derived from the mapping schema rather than restated, because a property
 * added to the mapper but missing here would silently always be null - the
 * CRM API returns only the properties you name, so the mapper would be
 * reading fields that were never requested. Two lists that must agree are one
 * list.
 */
export function contactPropertiesToFetch(extra: Iterable<string> = []): string[] {
  const known = Object.keys(Properties.shape);
  const wanted = new Set([...known, ...extra].map((p) => p.trim()).filter(Boolean));
  return [...wanted];
}

/**
 * A contact as the CRM API returns it, reshaped into the event the mapper
 * already understands.
 *
 * The `eventId` is HubSpot's, so a redelivery of the same subscription event
 * resolves to the same idempotency key. The object id is carried in
 * `objectId` exactly as the workflow-shaped payload carries it, which is what
 * lets both paths share `mapHubSpotEvent` and its tests.
 */
export function eventFromContact(args: {
  eventId: string;
  contactId: string;
  properties: Record<string, unknown>;
}): HubSpotEvent {
  return {
    eventId: args.eventId,
    objectId: args.contactId,
    subscriptionType: "contact.creation",
    properties: Properties.parse(args.properties),
  };
}

import { openSecret, type SealedSecret } from "@/lib/crypto/kms";

/**
 * HubSpot CRM integration (PRD 13.1, FR-042).
 *
 * "Current HubSpot CRM contact APIs support updating individual contacts or
 * batches, including using record IDs or unique properties." [Ref. 2]
 *
 * The update is a PATCH of current-state properties, which is what makes
 * PRD 18.1's claim true - "CRM update can be retried safely by setting the
 * same current-state properties" - so the outbox can retry without a
 * conditional check.
 */

const API_BASE = "https://api.hubapi.com";

export interface HubSpotCredentials {
  accessToken: string;
  /**
   * The private app's client secret, which signs its webhooks.
   *
   * Optional because a portal that pushes leads some other way - a paid
   * account's workflow action, or a relay we control - never needs it. Where
   * intake comes from a private-app subscription it is required, and it is the
   * only thing standing between that endpoint and anyone who knows a portal
   * id.
   */
  clientSecret?: string;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** PRD 13.1's custom property map, plus the AI outcome fields. */
export interface ContactUpdate {
  lastCallStatus: string;
  lastCallAt: string;
  intent: string;
  score: number;
  qualification: string;
  summary: string;
  callbackRequested: boolean;
  nextCallAt: string | null;
  humanFollowup: boolean;
  dnc: boolean;
}

export function contactProperties(update: ContactUpdate): Record<string, string> {
  // HubSpot properties are strings over the wire; booleans use "true"/"false".
  return {
    ai_last_call_status: update.lastCallStatus,
    ai_last_call_at: update.lastCallAt,
    ai_intent: update.intent,
    ai_score: String(update.score),
    ai_qualification: update.qualification,
    ai_call_summary: update.summary.slice(0, 65_000),
    ai_callback_requested: String(update.callbackRequested),
    ai_next_call_at: update.nextCallAt ?? "",
    ai_human_followup: String(update.humanFollowup),
    ai_do_not_call: String(update.dnc),
  };
}

export class HubSpotClient {
  constructor(
    private readonly credentials: HubSpotCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromSealedSecret(sealed: SealedSecret, fetchImpl?: typeof fetch): HubSpotClient {
    const raw = openSecret(sealed, "hubspot");
    return new HubSpotClient(JSON.parse(raw) as HubSpotCredentials, fetchImpl);
  }

  async updateContact(recordId: string, update: ContactUpdate): Promise<void> {
    await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(recordId)}`, "PATCH", {
      properties: contactProperties(update),
    });
  }

  /**
   * Read a contact's properties.
   *
   * Intake needs this because a private-app webhook carries no properties -
   * only the object id - so on a free HubSpot portal this call is the only way
   * to learn the lead's name, phone and enquiry.
   *
   * The property list is explicit because the CRM API returns *only* what is
   * named: omitting it yields HubSpot's small default set, and the phone and
   * the enquiry would silently be missing. A property that does not exist in
   * the portal is not an error - it comes back absent, which the mapper reads
   * as null, so a client whose form lacks a field still ingests.
   */
  async getContact(
    contactId: string,
    properties: string[],
  ): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams({ properties: properties.join(",") });

    try {
      const body = (await this.request(
        `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?${query}`,
        "GET",
        undefined,
      )) as { properties?: Record<string, unknown> } | null;

      return body?.properties ?? null;
    } catch (err) {
      // A contact created and deleted before we fetched it is a real race, not
      // a fault. Null lets intake record the event as handled rather than
      // failing the delivery and having HubSpot retry it for 24 hours.
      if (err instanceof IntegrationError && err.status === 404) return null;
      throw err;
    }
  }

  /** FR-043: create the follow-up task that carries the call context. */
  async createTask(args: {
    contactId: string;
    subject: string;
    body: string;
    dueAt: Date;
    ownerId?: string | null;
  }): Promise<void> {
    await this.request(`/crm/v3/objects/tasks`, "POST", {
      properties: {
        hs_task_subject: args.subject,
        hs_task_body: args.body,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "HIGH",
        hs_timestamp: args.dueAt.toISOString(),
        ...(args.ownerId ? { hubspot_owner_id: args.ownerId } : {}),
      },
      associations: [
        {
          to: { id: args.contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
        },
      ],
    });
  }

  /**
   * Cheap authenticated call, to tell a working token from a bad one before a
   * campaign goes live rather than during its first sync.
   */
  async verifyConnection(): Promise<{ portalId: number; timeZone: string }> {
    const info = (await this.request("/account-info/v3/details", "GET", undefined)) as {
      portalId: number;
      timeZone: string;
    };
    return { portalId: info.portalId, timeZone: info.timeZone };
  }

  /**
   * Create the custom contact properties this platform writes (PRD 13.1
   * "Custom properties: dnc, last_call, next_call, AI outcome").
   *
   * HubSpot rejects a PATCH naming a property that does not exist, so without
   * this every CRM sync for a fresh portal fails with a 400 that reads like a
   * bug in our code. Idempotent: an existing property is left alone.
   */
  async ensureProperties(): Promise<{ created: string[]; existing: string[] }> {
    await this.ensurePropertyGroup();

    const created: string[] = [];
    const existing: string[] = [];

    for (const property of AI_PROPERTIES) {
      try {
        await this.request("/crm/v3/properties/contacts", "POST", {
          name: property.name,
          label: property.label,
          type: property.type,
          fieldType: property.fieldType,
          groupName: PROPERTY_GROUP,
          description: property.description,
          ...(property.options ? { options: property.options } : {}),
        });
        created.push(property.name);
      } catch (err) {
        // 409 means it is already there, which is success for our purposes.
        if (err instanceof IntegrationError && err.status === 409) {
          existing.push(property.name);
          continue;
        }
        throw err;
      }
    }

    return { created, existing };
  }

  private async ensurePropertyGroup(): Promise<void> {
    try {
      await this.request("/crm/v3/properties/contacts/groups", "POST", {
        name: PROPERTY_GROUP,
        label: "AI Lead Qualification",
        displayOrder: -1,
      });
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 409) return;
      throw err;
    }
  }

  private async request(path: string, method: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.credentials.accessToken}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // Network failures are transient by definition.
      throw new IntegrationError(
        `HubSpot request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    if (response.ok) {
      return response.status === 204 ? null : await response.json().catch(() => null);
    }

    const detail = await response.text().catch(() => "");

    // PRD 18.2's failure classes: auth failures are not retried and should
    // disable the integration; 429 and 5xx are.
    if (response.status === 401 || response.status === 403) {
      throw new IntegrationError(`HubSpot auth failure: ${detail.slice(0, 200)}`, false, response.status);
    }
    if (response.status === 404) {
      throw new IntegrationError(`HubSpot record not found: ${detail.slice(0, 200)}`, false, 404);
    }
    if (response.status === 409) {
      // Already exists. Callers that bootstrap properties treat this as success.
      throw new IntegrationError(`HubSpot conflict: ${detail.slice(0, 200)}`, false, 409);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new IntegrationError(`HubSpot transient error ${response.status}`, true, response.status);
    }

    throw new IntegrationError(
      `HubSpot error ${response.status}: ${detail.slice(0, 200)}`,
      false,
      response.status,
    );
  }
}

const PROPERTY_GROUP = "ai_lead_qualification";

/**
 * The contact properties written by `contactProperties()`. Names must match
 * that function exactly - they are the wire contract with HubSpot.
 */
const AI_PROPERTIES: Array<{
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description: string;
  options?: Array<{ label: string; value: string; displayOrder: number }>;
}> = [
  {
    name: "ai_last_call_status",
    label: "AI last call status",
    type: "string",
    fieldType: "text",
    description: "Outcome of the most recent automated call attempt.",
  },
  {
    name: "ai_last_call_at",
    label: "AI last call at",
    type: "datetime",
    fieldType: "date",
    description: "When the most recent automated call ended.",
  },
  {
    name: "ai_intent",
    label: "AI intent",
    type: "string",
    fieldType: "text",
    description: "Intent classified from the call transcript.",
  },
  {
    name: "ai_score",
    label: "AI score",
    type: "number",
    fieldType: "number",
    description: "Qualification score from the campaign rubric.",
  },
  {
    name: "ai_qualification",
    label: "AI qualification",
    type: "string",
    fieldType: "text",
    description: "Qualified, partially qualified, or unqualified.",
  },
  {
    name: "ai_call_summary",
    label: "AI call summary",
    type: "string",
    fieldType: "textarea",
    description: "Neutral summary of what the lead said.",
  },
  {
    name: "ai_callback_requested",
    label: "AI callback requested",
    type: "bool",
    fieldType: "booleancheckbox",
    description: "The lead asked to be called back later.",
    options: [
      { label: "Yes", value: "true", displayOrder: 0 },
      { label: "No", value: "false", displayOrder: 1 },
    ],
  },
  {
    name: "ai_next_call_at",
    label: "AI next call at",
    type: "datetime",
    fieldType: "date",
    description: "When the next attempt or callback is scheduled.",
  },
  {
    name: "ai_human_followup",
    label: "AI human follow-up requested",
    type: "bool",
    fieldType: "booleancheckbox",
    description: "The lead asked to speak to a person.",
    options: [
      { label: "Yes", value: "true", displayOrder: 0 },
      { label: "No", value: "false", displayOrder: 1 },
    ],
  },
  {
    name: "ai_do_not_call",
    label: "AI do not call",
    type: "bool",
    fieldType: "booleancheckbox",
    description: "The lead explicitly asked not to be contacted again.",
    options: [
      { label: "Yes", value: "true", displayOrder: 0 },
      { label: "No", value: "false", displayOrder: 1 },
    ],
  },
];

export { AI_PROPERTIES, PROPERTY_GROUP };

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

  private async request(path: string, method: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
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

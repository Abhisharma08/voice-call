import { createSign } from "node:crypto";
import { openSecret, type SealedSecret } from "@/lib/crypto/kms";
import { IntegrationError } from "@/lib/integrations/hubspot";

/**
 * Google Sheets append (PRD 13.2, 15, FR-041).
 *
 * "The Sheets API supports appending values to the next row of a table/range
 * and requires spreadsheet ID, range, and an input option." [Ref. 3]
 *
 * PRD 13.2 is explicit that PostgreSQL is the source of truth and the sheet is
 * an operational log - so this appends and never reads back, and idempotency
 * is enforced upstream by the outbox dedupe key (call_id), not by scanning the
 * sheet for an existing row.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** PRD 15's Call Log column order. Positional - do not reorder. */
export const SHEET_COLUMNS = [
  "call_id",
  "client_id",
  "campaign",
  "lead_id",
  "hubspot_record_id",
  "name",
  "phone",
  "call_date",
  "duration_sec",
  "call_status",
  "intent",
  "score",
  "qualification",
  "timeline",
  "budget",
  "location",
  "callback_requested",
  "human_followup",
  "dnc",
  "summary",
  "recording_ref",
  "sync_status",
] as const;

export type SheetRow = Record<(typeof SHEET_COLUMNS)[number], string>;

export function toRowValues(row: SheetRow): string[] {
  return SHEET_COLUMNS.map((c) => row[c] ?? "");
}

export class GoogleSheetsClient {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: ServiceAccountCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromSealedSecret(sealed: SealedSecret, fetchImpl?: typeof fetch): GoogleSheetsClient {
    const raw = openSecret(sealed, "google_sheets");
    return new GoogleSheetsClient(JSON.parse(raw) as ServiceAccountCredentials, fetchImpl);
  }

  async appendRow(args: { spreadsheetId: string; range: string; row: SheetRow }): Promise<void> {
    const token = await this.accessToken();
    const url =
      `${SHEETS_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/` +
      `${encodeURIComponent(args.range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ values: [toRowValues(args.row)] }),
      });
    } catch (err) {
      throw new IntegrationError(
        `Sheets request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    if (response.ok) return;

    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      this.tokenCache = null;
      throw new IntegrationError(`Sheets auth failure: ${detail.slice(0, 200)}`, false, response.status);
    }
    if (response.status === 404) {
      throw new IntegrationError(`Spreadsheet or range not found`, false, 404);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new IntegrationError(`Sheets transient error ${response.status}`, true, response.status);
    }
    throw new IntegrationError(
      `Sheets error ${response.status}: ${detail.slice(0, 200)}`,
      false,
      response.status,
    );
  }

  /** Service-account JWT bearer flow (PRD 13.2 prefers a server-side service account). */
  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: this.credentials.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );

    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(this.credentials.private_key).toString("base64url");
    const assertion = `${header}.${claims}.${signature}`;

    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new IntegrationError(
        `Google token exchange failed (${response.status}): ${detail.slice(0, 200)}`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      token: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return body.access_token;
  }
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

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

/**
 * PRD 15's Call Log column order. Positional - do not reorder.
 *
 * `source`, `email`, `enquiry` and `lead_created` are the lead's own data
 * rather than the call's: who they are, what they actually asked for, and when
 * they arrived. A row without them describes a phone call but not a lead, so
 * acting on one meant opening the platform to find out what the enquiry was.
 */
export const SHEET_COLUMNS = [
  "call_id",
  "client_id",
  "campaign",
  "lead_id",
  "hubspot_record_id",
  "source",
  "name",
  "phone",
  "email",
  "enquiry",
  "lead_created",
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

/**
 * The cell range a full row occupies, derived rather than written down.
 *
 * It was "A:V" in four files. Adding a column then meant finding all four, and
 * missing one truncates every append silently - Sheets accepts a row wider
 * than the range and drops the overflow.
 */
export const DEFAULT_SHEET_CELLS = `A:${columnLetter(SHEET_COLUMNS.length)}`;
export const DEFAULT_SHEET_RANGE = `Call Log!${DEFAULT_SHEET_CELLS}`;

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

    // Re-quote rather than trusting the stored range: a tab name with a space
    // saved as `Call Log!A:Z` is unparseable to the API.
    const { tab, cells } = splitRange(args.range);
    const range = formatRange(tab, cells ?? DEFAULT_SHEET_CELLS);

    const url =
      `${SHEETS_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/` +
      `${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

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

  /**
   * Confirm the service account can actually reach this spreadsheet.
   *
   * The usual failure is not a bad key but an unshared sheet: a service
   * account is a separate principal, and a Drive file nobody shared with it is
   * a 404 no matter how valid the credential is. Reporting that distinctly is
   * the difference between a five-minute fix and an afternoon.
   */
  async verifyConnection(spreadsheetId: string): Promise<{ title: string; tabs: string[] }> {
    const token = await this.accessToken();
    const url =
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}` +
      `?fields=properties.title,sheets.properties.title`;

    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (response.status === 404 || response.status === 403) {
      throw new IntegrationError(
        `Spreadsheet not reachable. Share it with the service account ` +
          `(${this.credentials.client_email}) as an Editor.`,
        false,
        response.status,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new IntegrationError(
        `Sheets error ${response.status}: ${detail.slice(0, 200)}`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }

    const body = (await response.json()) as {
      properties: { title: string };
      sheets: Array<{ properties: { title: string } }>;
    };

    return {
      title: body.properties.title,
      tabs: body.sheets.map((sheet) => sheet.properties.title),
    };
  }

  /**
   * Write the PRD 15 column headers if the target range is empty.
   *
   * Appends are positional, so a sheet without headers produces 22 unlabelled
   * columns that a human then has to decode. Idempotent - an existing first
   * row is left alone rather than overwritten.
   */
  async ensureHeaderRow(spreadsheetId: string, range: string): Promise<"written" | "already_present"> {
    const token = await this.accessToken();
    const { tab } = splitRange(range);

    // A brand-new spreadsheet has one tab called "Sheet1", so the configured
    // tab usually does not exist yet. Create it rather than failing - that is
    // what the operator wanted when they named it.
    await this.ensureTab(spreadsheetId, tab);

    const headerRange = `${quoteTab(tab)}!A1:${columnLetter(SHEET_COLUMNS.length)}1`;

    const existing = await this.fetchImpl(
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(headerRange)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    if (existing.ok) {
      const body = (await existing.json()) as { values?: string[][] };
      if (body.values && body.values.length > 0 && (body.values[0]?.length ?? 0) > 0) {
        return "already_present";
      }
    }

    const write = await this.fetchImpl(
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/` +
        `${encodeURIComponent(headerRange)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ values: [[...SHEET_COLUMNS]] }),
      },
    );

    if (!write.ok) {
      const detail = await write.text().catch(() => "");
      throw new IntegrationError(
        `Could not write the header row: ${detail.slice(0, 200)}`,
        write.status === 429 || write.status >= 500,
        write.status,
      );
    }

    return "written";
  }

  /** Add a tab if the spreadsheet does not already have one by that name. */
  async ensureTab(spreadsheetId: string, tab: string): Promise<"created" | "already_present"> {
    const existing = await this.verifyConnection(spreadsheetId);
    if (existing.tabs.includes(tab)) return "already_present";

    const token = await this.accessToken();
    const response = await this.fetchImpl(
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: tab } } }],
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new IntegrationError(
        `Could not create the "${tab}" tab: ${detail.slice(0, 200)}. ` +
          `Existing tabs: ${existing.tabs.join(", ")}`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }

    return "created";
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

/**
 * Split "Call Log!A:Z" into its tab and cell parts. A range with no "!" is
 * treated as a bare tab name.
 */
export function splitRange(range: string): { tab: string; cells: string | null } {
  const bang = range.lastIndexOf("!");
  if (bang === -1) return { tab: unquoteTab(range.trim()), cells: null };
  return {
    tab: unquoteTab(range.slice(0, bang).trim()),
    cells: range.slice(bang + 1).trim() || null,
  };
}

function unquoteTab(tab: string): string {
  if (tab.length >= 2 && tab.startsWith("'") && tab.endsWith("'")) {
    return tab.slice(1, -1).replace(/''/g, "'");
  }
  return tab;
}

/**
 * A1 notation requires a sheet name to be single-quoted unless it is a plain
 * identifier - so `Call Log!A1:V1` is rejected as unparseable while
 * `'Call Log'!A1:V1` is fine. Internal quotes are doubled.
 *
 * Getting this wrong is invisible until the first sheet whose tab name has a
 * space in it, which is most of them.
 */
export function quoteTab(tab: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tab)
    ? tab
    : `'${tab.replace(/'/g, "''")}'`;
}

export function formatRange(tab: string, cells: string | null): string {
  return cells ? `${quoteTab(tab)}!${cells}` : quoteTab(tab);
}

/** 1 -> A, 26 -> Z, 27 -> AA. */
function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

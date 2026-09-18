import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHEET_CELLS,
  GoogleSheetsClient,
  SHEET_COLUMNS,
  formatRange,
  quoteTab,
  splitRange,
} from "@/lib/integrations/google-sheets";

/**
 * A1 notation quoting.
 *
 * This exists because of a real failure: the default tab name in the seed is
 * "Call Log", and `Call Log!A1:V1` is rejected by the Sheets API as
 * unparseable. A1 notation requires a sheet name to be single-quoted unless it
 * is a plain identifier - and almost every human-named tab has a space in it.
 *
 * The bug was invisible in every test that stubbed the HTTP client, because
 * the range only has to be valid to Google.
 */

describe("A1 range quoting", () => {
  it("leaves a plain identifier unquoted", () => {
    expect(quoteTab("Sheet1")).toBe("Sheet1");
    expect(quoteTab("call_log")).toBe("call_log");
  });

  it("quotes a name containing a space", () => {
    expect(quoteTab("Call Log")).toBe("'Call Log'");
  });

  it("quotes a name starting with a digit", () => {
    expect(quoteTab("2026 Calls")).toBe("'2026 Calls'");
  });

  it("quotes a name containing punctuation", () => {
    expect(quoteTab("Q3-leads")).toBe("'Q3-leads'");
    expect(quoteTab("Acme (live)")).toBe("'Acme (live)'");
  });

  it("doubles an internal single quote", () => {
    expect(quoteTab("Bob's leads")).toBe("'Bob''s leads'");
  });
});

describe("range splitting", () => {
  it("splits a tab and cell range", () => {
    expect(splitRange("Call Log!A:V")).toEqual({ tab: "Call Log", cells: "A:V" });
  });

  it("treats a bare name as a tab", () => {
    expect(splitRange("Sheet1")).toEqual({ tab: "Sheet1", cells: null });
  });

  it("unwraps an already-quoted tab so it is not double-quoted", () => {
    expect(splitRange("'Call Log'!A1:V1")).toEqual({ tab: "Call Log", cells: "A1:V1" });
    expect(formatRange("Call Log", "A1:V1")).toBe("'Call Log'!A1:V1");
  });

  it("survives a round trip", () => {
    for (const tab of ["Sheet1", "Call Log", "Bob's leads", "2026 Calls"]) {
      const formatted = formatRange(tab, "A:V");
      expect(splitRange(formatted).tab).toBe(tab);
    }
  });

  it("handles a tab name containing an exclamation mark", () => {
    // Splitting on the LAST "!" is what makes this work.
    expect(splitRange("'Hot! leads'!A:V")).toEqual({ tab: "Hot! leads", cells: "A:V" });
  });
});

describe("appendRow request shape", () => {
  // A real throwaway key: the client signs a JWT before every request, so a
  // placeholder string fails in the signer before the URL is ever built.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const credentials = {
    client_email: "svc@test.iam.gserviceaccount.com",
    private_key: privateKey,
  };

  const row = Object.fromEntries(SHEET_COLUMNS.map((c) => [c, ""])) as Record<string, string>;

  function stubFetch(capture: string[]) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      capture.push(decodeURIComponent(href));
      void init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("quotes a spaced tab name in the append URL", async () => {
    const urls: string[] = [];
    const client = new GoogleSheetsClient(credentials, stubFetch(urls));

    // Deliberately pass the unquoted form a campaign would have stored.
    await client.appendRow({
      spreadsheetId: "sheet-1",
      range: "Call Log!A:V",
      row: row as never,
    });

    expect(urls[0]).toContain("'Call Log'!A:V:append");
    // The unquoted form is what Google rejects.
    expect(urls[0]).not.toContain("/values/Call Log!");
  });

  it("does not double-quote an already-quoted stored range", async () => {
    const urls: string[] = [];
    const client = new GoogleSheetsClient(credentials, stubFetch(urls));

    await client.appendRow({
      spreadsheetId: "sheet-1",
      range: "'Call Log'!A:V",
      row: row as never,
    });

    expect(urls[0]).toContain("'Call Log'!A:V:append");
    expect(urls[0]).not.toContain("''Call Log''");
  });

  it("defaults the cell range when a bare tab name is configured", async () => {
    const urls: string[] = [];
    const client = new GoogleSheetsClient(credentials, stubFetch(urls));

    await client.appendRow({ spreadsheetId: "sheet-1", range: "Sheet1", row: row as never });
    // Derived from SHEET_COLUMNS rather than written out, so adding a column
    // cannot leave this asserting a range that truncates every append.
    expect(urls[0]).toContain(`Sheet1!${DEFAULT_SHEET_CELLS}:append`);
  });
});

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { testIntegration, type ConnectionReport } from "./actions";

/**
 * Verify a credential from the UI, and bootstrap whatever the far end needs -
 * HubSpot custom properties, the Sheets header row.
 */
export function TestConnection({
  tenantId,
  integrationId,
  spreadsheetId,
  sheetRange,
}: {
  tenantId: string;
  integrationId: string;
  spreadsheetId: string | null;
  sheetRange: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ConnectionReport | null>(null);

  return (
    <div>
      <button
        className="ghost"
        disabled={busy}
        style={{ padding: "3px 8px", fontSize: 12 }}
        onClick={async () => {
          setBusy(true);
          setReport(null);

          const data = new FormData();
          data.set("tenantId", tenantId);
          data.set("integrationId", integrationId);
          if (spreadsheetId) data.set("spreadsheetId", spreadsheetId);
          if (sheetRange) data.set("sheetRange", sheetRange);

          const result = await testIntegration(data);
          setReport(result.ok ? result.data : { ok: false, summary: result.error, details: [] });
          setBusy(false);
          router.refresh();
        }}
      >
        {busy ? "Testing..." : "Test connection"}
      </button>

      {report ? (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span className={`pill ${report.ok ? "ok" : "warn"}`}>
            {report.ok ? "connected" : "failed"}
          </span>{" "}
          <span style={{ color: report.ok ? "var(--muted)" : "var(--danger)" }}>{report.summary}</span>
          {report.details.map((d) => (
            <div key={d} style={{ color: "var(--muted)", fontSize: 11, marginTop: 3 }}>
              {d}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

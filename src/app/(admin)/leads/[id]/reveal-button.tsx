"use client";

import { useState } from "react";

/**
 * "unmasked only on explicit detail-view action". The reveal writes
 * an audit row in the same transaction as the decrypt, so the number cannot be
 * read without a record of who read it.
 */
export function RevealButton({ tenantId, leadId }: { tenantId: string; leadId: string }) {
  const [value, setValue] = useState<{ phone: string | null; email: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  if (value) {
    return (
      <div style={{ marginTop: 6, fontSize: 12 }}>
        <div style={{ fontFamily: "ui-monospace, monospace" }}>{value.phone ?? "no number"}</div>
        {value.email ? <div style={{ color: "var(--muted)" }}>{value.email}</div> : null}
        <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 3 }}>This view was logged.</div>
      </div>
    );
  }

  return (
    <button
      className="ghost"
      disabled={busy}
      style={{ marginTop: 8, padding: "4px 9px", fontSize: 12 }}
      onClick={async () => {
        setBusy(true);
        const response = await fetch("/api/leads/reveal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenant_id: tenantId, lead_id: leadId }),
        });
        if (response.ok) setValue(await response.json());
        setBusy(false);
      }}
    >
      {busy ? "..." : "Reveal contact details"}
    </button>
  );
}

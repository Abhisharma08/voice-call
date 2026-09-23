"use client";

import { useState } from "react";

export interface LeadRow {
  id: string;
  status: string;
  statusReason: string | null;
  phoneLast4: string | null;
  source: string | null;
  dnc: boolean;
  attempts: number;
  nextCallAt: string | null;
  createdAt: string;
  campaignName: string | null;
  hasConsent: boolean;
  intent: string | null;
  score: number | null;
}

/**
 * The list view never receives a full phone number from the server.
 * "Reveal" is a separate authenticated request that writes an audit row in the
 * same transaction as the decrypt, so the number cannot be read without a
 * trace of who read it.
 */
export function LeadsTable({
  leads,
  tenantId,
  canReveal,
}: {
  leads: LeadRow[];
  tenantId: string;
  canReveal: boolean;
}) {
  const [revealed, setRevealed] = useState<Record<string, { phone: string | null; email: string | null }>>(
    {},
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reveal(leadId: string) {
    setBusyId(leadId);
    const response = await fetch("/api/leads/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: tenantId, lead_id: leadId }),
    });

    if (response.ok) {
      const body = (await response.json()) as { phone: string | null; email: string | null };
      setRevealed((prev) => ({ ...prev, [leadId]: body }));
    }
    setBusyId(null);
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {["Contact", "Campaign", "Status", "Consent", "Intent", "Attempts", "Next call", ""].map(
              (h) => <th key={h}>{h}</th>,
            )}
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const shown = revealed[lead.id];
            return (
              <tr key={lead.id}>
                <td>
                  <div className="mono">
                    {shown?.phone ?? (lead.phoneLast4 ? `******${lead.phoneLast4}` : "—")}
                  </div>
                  {shown?.email ? (
                    <div className="sub">{shown.email}</div>
                  ) : null}
                </td>
                <td>{lead.campaignName ?? "—"}</td>
                <td>
                  <span className={`pill ${statusTone(lead.status)}`}>{lead.status}</span>
                  {lead.statusReason ? (
                    <div className="sub">
                      {lead.statusReason}
                    </div>
                  ) : null}
                </td>
                <td>
                  {/* A lead cannot be queued without an active consent record. */}
                  <span className={`pill ${lead.hasConsent ? "ok" : "warn"}`}>
                    {lead.hasConsent ? "active" : "none"}
                  </span>
                </td>
                <td>
                  {lead.intent ? (
                    <>
                      <span className="pill">{lead.intent}</span>
                      {lead.score !== null ? (
                        <span style={{ color: "var(--muted)", marginLeft: 6 }}>{lead.score}</span>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{lead.attempts}</td>
                <td className="nowrap">
                  {lead.nextCallAt ? new Date(lead.nextCallAt).toLocaleString() : "—"}
                </td>
                <td>
                  {canReveal && !shown ? (
                    <button
                      className="ghost sm"
                      disabled={busyId === lead.id}
                      onClick={() => void reveal(lead.id)}
                    >
                      {busyId === lead.id ? "..." : "Reveal"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === "qualified") return "ok";
  if (status === "suppressed" || status === "quarantined" || status === "failed") return "warn";
  if (status === "pending_review") return "warn";
  return "";
}

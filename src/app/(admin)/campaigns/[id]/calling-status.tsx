"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setCampaignActive } from "../actions";

/**
 * Start and stop calling, and say plainly what is still missing.
 *
 * There is no compliance sign-off here. Consent is collected upstream in the
 * client's own funnel and recorded on each lead at intake, so the only things
 * standing between a campaign and a call are the ones that would break the
 * call itself: something to say, something to ask, and somewhere to write the
 * answer. The consent and approval columns still exist and the server actions
 * that write them are still there, unused, if a client ever needs that trail.
 */
export function CallingStatus({
  tenantId,
  campaignId,
  active,
  blockers,
  canConfigure,
}: {
  tenantId: string;
  campaignId: string;
  active: boolean;
  blockers: string[];
  canConfigure: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    setError(null);

    const data = new FormData();
    data.set("tenantId", tenantId);
    data.set("campaignId", campaignId);
    data.set("active", String(!active));

    const result = await setCampaignActive(data);
    if (!result.ok) setError(result.error ?? "Failed");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Calling</strong>
        <span className={`pill ${active ? "ok" : "warn"}`}>{active ? "on" : "off"}</span>
        <div className="spacer" />
        {canConfigure ? (
          <button
            className="ghost"
            disabled={busy || (!active && blockers.length > 0)}
            onClick={() => void toggle()}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {busy ? "Working..." : active ? "Stop calling" : "Start calling"}
          </button>
        ) : null}
      </div>

      {blockers.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 5 }}>
            Finish these first:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {blockers.map((b) => (
              <li key={b} style={{ marginBottom: 3 }}>
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
          {active
            ? "New leads on this campaign are called automatically inside the calling window."
            : "Everything is configured. Turn calling on whenever you are ready."}
        </p>
      )}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

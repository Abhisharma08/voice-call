"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { replayAllForTarget, replayDeadLetter } from "./dead-letter-actions";

export interface DeadLetter {
  id: string;
  target: "hubspot" | "google_sheets" | "notification";
  attempts: number;
  lastError: string | null;
  deadSince: string;
  /** Present when the row's payload names a call, which all of them do today. */
  callId: string | null;
  leadPhoneLast4: string | null;
  campaignName: string | null;
}

const TARGET_LABELS: Record<DeadLetter["target"], string> = {
  hubspot: "HubSpot",
  google_sheets: "Google Sheets",
  notification: "Slack notification",
};

/**
 * Deliveries that exhausted their retries.
 *
 * This panel is not a log. Every row here is a qualification result that a
 * client has not received - a hot lead their sales team does not know about -
 * so it is phrased as outstanding work rather than as history, and it stays on
 * screen until somebody clears it.
 */
export function DeadLetters({
  tenantId,
  items,
  canReplay,
}: {
  tenantId: string;
  items: DeadLetter[];
  canReplay: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byTarget = new Map<DeadLetter["target"], DeadLetter[]>();
  for (const item of items) {
    byTarget.set(item.target, [...(byTarget.get(item.target) ?? []), item]);
  }

  async function run(key: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(key);
    setError(null);

    const result = await action();
    if (!result.ok) setError(result.error ?? "Replay failed");

    setBusy(null);
    router.refresh();
  }

  return (
    <div className="stack">
      {error ? <p className="error">{error}</p> : null}

      {[...byTarget.entries()].map(([target, rows]) => (
        <div key={target} className="card stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>{TARGET_LABELS[target]}</strong>
            <span className="pill warn">
              {rows.length} undelivered
            </span>
            <div className="spacer" />
            {canReplay ? (
              <button
                className="ghost"
                disabled={busy !== null}
                style={{ padding: "3px 8px", fontSize: 12 }}
                onClick={() =>
                  run(`all:${target}`, () => {
                    const data = new FormData();
                    data.set("tenantId", tenantId);
                    data.set("target", target);
                    return replayAllForTarget(data);
                  })
                }
              >
                {busy === `all:${target}` ? "Queueing..." : `Replay all ${rows.length}`}
              </button>
            ) : null}
          </div>

          {/*
            The fix almost always belongs to the destination rather than to any
            individual row - an expired token strands every sync for a client
            at once - so the shared error is stated once at the top instead of
            being repeated down the list.
          */}
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Fix the credential above, then replay. Replaying before the cause is fixed just walks
            the same retry ladder again.
          </div>

          {rows.map((row) => (
            <div
              key={row.id}
              className="row"
              style={{
                gap: 8,
                flexWrap: "wrap",
                alignItems: "baseline",
                borderTop: "1px solid var(--border)",
                paddingTop: 6,
              }}
            >
              <span style={{ fontSize: 12 }}>
                {row.campaignName ?? "—"}
                {row.leadPhoneLast4 ? ` · ····${row.leadPhoneLast4}` : ""}
              </span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {row.attempts} attempt{row.attempts === 1 ? "" : "s"} · since{" "}
                {new Date(row.deadSince).toLocaleString()}
              </span>

              <div className="spacer" />

              {canReplay ? (
                <button
                  className="ghost"
                  disabled={busy !== null}
                  style={{ padding: "2px 7px", fontSize: 11 }}
                  onClick={() =>
                    run(row.id, () => {
                      const data = new FormData();
                      data.set("tenantId", tenantId);
                      data.set("id", row.id);
                      return replayDeadLetter(data);
                    })
                  }
                >
                  {busy === row.id ? "Queueing..." : "Replay"}
                </button>
              ) : null}

              {row.lastError ? (
                <div
                  style={{
                    flexBasis: "100%",
                    fontSize: 11,
                    color: "var(--danger)",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {row.lastError}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}

      {!canReplay ? (
        <p style={{ color: "var(--muted)", fontSize: 12 }}>
          Replaying a delivery is a Campaign Manager or Agency Admin action.
        </p>
      ) : null}
    </div>
  );
}

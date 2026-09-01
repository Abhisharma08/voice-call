"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { INTENTS } from "@/lib/qualification/schema";

export interface ReviewItem {
  id: string;
  callId: string;
  leadId: string;
  intent: string;
  score: number;
  confidence: number | null;
  reviewReason: string | null;
  createdAt: string;
  summary: string;
  reason: string;
  phoneLast4: string | null;
  campaignName: string | null;
  durationSec: number | null;
  payload: Record<string, unknown>;
}

/**
 * One card per held result. The operator sees what the model concluded, why it
 * was held, and the transcript-derived fields - then confirms, corrects, or
 * rejects.
 *
 * A correction only sends the fields that changed; the server re-scores from
 * the campaign rubric rather than trusting a score from the browser.
 */
export function ReviewList({
  items,
  tenantId,
  canResolve,
}: {
  items: ReviewItem[];
  tenantId: string;
  canResolve: boolean;
}) {
  return (
    <div className="stack">
      {items.map((item) => (
        <ReviewCard key={item.id} item={item} tenantId={tenantId} canResolve={canResolve} />
      ))}
    </div>
  );
}

function ReviewCard({
  item,
  tenantId,
  canResolve,
}: {
  item: ReviewItem;
  tenantId: string;
  canResolve: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [intent, setIntent] = useState(item.intent);
  const [note, setNote] = useState("");

  async function resolve(action: "confirm" | "correct" | "reject") {
    setBusy(true);
    setError(null);

    const response = await fetch("/api/review/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId,
        analysis_id: item.id,
        action,
        note: note || null,
        ...(action === "correct" ? { corrections: { intent } } : {}),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not resolve");
      setBusy(false);
      return;
    }

    router.refresh();
  }

  return (
    <div className="card stack">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className={`pill ${item.intent === "hot" ? "warn" : ""}`}>{item.intent}</span>
        <span className="pill">score {item.score}</span>
        <span className="pill">
          confidence {item.confidence === null ? "n/a" : item.confidence.toFixed(2)}
        </span>
        {item.campaignName ? <span className="pill">{item.campaignName}</span> : null}
        <span className="pill">
          {/* PRD 26.2: only the last four digits render without an explicit reveal. */}
          {item.phoneLast4 ? `ending ${item.phoneLast4}` : "no number"}
        </span>
        {item.durationSec !== null ? <span className="pill">{item.durationSec}s</span> : null}
        <div className="spacer" />
        <span className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
          {new Date(item.createdAt).toLocaleString()}
        </span>
      </div>

      {item.reviewReason ? (
        <div style={{ fontSize: 13 }}>
          <strong style={{ color: "var(--muted)", fontWeight: 500 }}>Held because: </strong>
          {item.reviewReason}
        </div>
      ) : null}

      <div style={{ fontSize: 13 }}>{item.summary}</div>

      {item.reason ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Model rationale: {item.reason}</div>
      ) : null}

      <ExtractedFields payload={item.payload} />

      {canResolve ? (
        <>
          {editing ? (
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <div>
                <label htmlFor={`intent-${item.id}`}>Corrected intent</label>
                <select
                  id={`intent-${item.id}`}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                >
                  {INTENTS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor={`note-${item.id}`}>Note (recorded in the audit log)</label>
                <input
                  id={`note-${item.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          ) : null}

          <div className="row" style={{ gap: 8 }}>
            <button disabled={busy} onClick={() => void resolve("confirm")}>
              Confirm
            </button>
            {editing ? (
              <button className="ghost" disabled={busy} onClick={() => void resolve("correct")}>
                Save correction
              </button>
            ) : (
              <button className="ghost" disabled={busy} onClick={() => setEditing(true)}>
                Correct
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => void resolve("reject")}>
              Reject
            </button>
            <div className="spacer" />
            {error ? <p className="error">{error}</p> : null}
          </div>
        </>
      ) : (
        <p className="note" style={{ color: "var(--muted)", fontSize: 12 }}>
          Read-only. Resolving is an Operations Manager action (PRD 4).
        </p>
      )}
    </div>
  );
}

const DISPLAY_FIELDS = [
  ["still_interested", "Still interested"],
  ["timeline", "Timeline"],
  ["budget", "Budget"],
  ["location", "Location"],
  ["product_interest", "Product"],
  ["callback_requested", "Callback"],
  ["human_followup", "Wants human"],
  ["do_not_call", "Do not call"],
  ["wrong_number", "Wrong number"],
] as const;

function ExtractedFields({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
      {DISPLAY_FIELDS.map(([key, label]) => {
        const value = payload[key];
        // A null is meaningful here: FR-032 says the model must say "unknown"
        // rather than invent, so showing it as blank would hide the signal
        // that triggered the review.
        const display =
          value === null || value === undefined || value === "" || value === "unknown"
            ? "—"
            : String(value);
        return (
          <span key={key} className="pill" title={label}>
            {label}: {display}
          </span>
        );
      })}
    </div>
  );
}

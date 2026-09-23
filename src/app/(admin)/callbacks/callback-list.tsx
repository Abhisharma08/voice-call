"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reschedule, resolve } from "./actions";

export interface CallbackItem {
  id: string;
  leadId: string;
  scheduledFor: string;
  requestedAt: string;
  status: string;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  note: string | null;
  phoneLast4: string | null;
  campaignName: string | null;
  leadStatus: string;
  leadNextCallAt: string | null;
  attempts: number;
  intent: string | null;
  summary: string | null;
}

/**
 * Outstanding callbacks as cards, resolved ones as a table.
 *
 * The split is deliberate: an outstanding callback is something to act on and
 * needs room for the context and the buttons, while a resolved one is history
 * and only has to be scannable.
 */
export function CallbackList({
  outstanding,
  resolved,
  tenantId,
  canWrite,
}: {
  outstanding: CallbackItem[];
  resolved: CallbackItem[];
  tenantId: string;
  canWrite: boolean;
}) {
  const now = Date.now();
  const overdue = outstanding.filter((c) => new Date(c.scheduledFor).getTime() < now);
  const upcoming = outstanding.filter((c) => new Date(c.scheduledFor).getTime() >= now);

  return (
    <div className="stack" style={{ gap: 10 }}>
      {overdue.length > 0 ? (
        <>
          <h2 className="section">Past due ({overdue.length})</h2>
          {overdue.map((c) => (
            <CallbackCard key={c.id} item={c} tenantId={tenantId} canWrite={canWrite} overdue />
          ))}
        </>
      ) : null}

      {upcoming.length > 0 ? (
        <>
          <h2 className="section">Upcoming ({upcoming.length})</h2>
          {upcoming.map((c) => (
            <CallbackCard key={c.id} item={c} tenantId={tenantId} canWrite={canWrite} />
          ))}
        </>
      ) : null}

      {outstanding.length === 0 ? (
        <div className="empty">
          Nothing outstanding. When a lead asks to be called back, the requested time goes straight
          onto the queue and the callback appears here until the call is placed.
        </div>
      ) : null}

      {resolved.length > 0 ? (
        <>
          <h2 className="section">Recently closed</h2>
          <ResolvedTable items={resolved} />
        </>
      ) : null}
    </div>
  );
}

function CallbackCard({
  item,
  tenantId,
  canWrite,
  overdue = false,
}: {
  item: CallbackItem;
  tenantId: string;
  canWrite: boolean;
  overdue?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(item.scheduledFor));
  const [note, setNote] = useState("");

  async function close(resolution: "completed" | "missed" | "canceled") {
    setBusy(true);
    setError(null);
    const result = await resolve({
      tenantId,
      callbackId: item.id,
      resolution,
      note: note || null,
    });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    router.refresh();
  }

  async function move() {
    setBusy(true);
    setError(null);
    setNotice(null);

    const result = await reschedule({
      tenantId,
      callbackId: item.id,
      scheduledFor: new Date(when).toISOString(),
    });

    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }

    // A lead that is suppressed or still mid-call is not put back on the queue
    // by a reschedule. Saying so here is the difference between a moved
    // callback and a moved call.
    if (!result.data.leadRequeued) {
      setNotice(
        `Callback moved, but the lead is ${result.data.leadStatus} and was not put back on the queue.`,
      );
      setBusy(false);
      setMoving(false);
      router.refresh();
      return;
    }

    router.refresh();
  }

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className={`pill ${overdue ? "bad" : "info"}`}>{relative(item.scheduledFor)}</span>
        <strong style={{ fontSize: 14 }}>{new Date(item.scheduledFor).toLocaleString()}</strong>
        <Link href={`/leads/${item.leadId}`} className="pill">
          {item.phoneLast4 ? `ending ${item.phoneLast4}` : "lead"}
        </Link>
        {item.campaignName ? <span className="pill">{item.campaignName}</span> : null}
        {item.intent ? <span className="pill">{item.intent}</span> : null}
        <div className="spacer" />
        <span style={{ fontSize: 11, color: "var(--faint)" }}>
          asked {new Date(item.requestedAt).toLocaleDateString()}
        </span>
      </div>

      {item.summary ? <div style={{ fontSize: 13 }}>{item.summary}</div> : null}

      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        Lead is <span className="pill">{item.leadStatus}</span> after {item.attempts} attempt
        {item.attempts === 1 ? "" : "s"}
        {item.leadNextCallAt
          ? ` · next call ${new Date(item.leadNextCallAt).toLocaleString()}`
          : " · no call scheduled"}
      </div>

      {canWrite ? (
        <>
          {moving ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label htmlFor={`when-${item.id}`}>New time</label>
                <input
                  id={`when-${item.id}`}
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </div>
              <button disabled={busy} onClick={() => void move()}>
                {busy ? "Moving..." : "Move and requeue"}
              </button>
              <button className="ghost" disabled={busy} onClick={() => setMoving(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="ghost" disabled={busy} onClick={() => setMoving(true)}>
                Reschedule
              </button>
              <button className="ghost" disabled={busy} onClick={() => void close("completed")}>
                Mark called
              </button>
              <button className="ghost" disabled={busy} onClick={() => void close("missed")}>
                Mark missed
              </button>
              <button className="danger" disabled={busy} onClick={() => void close("canceled")}>
                Cancel callback
              </button>
            </div>
          )}

          <div>
            <label htmlFor={`note-${item.id}`}>Note (kept with the resolution)</label>
            <input
              id={`note-${item.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
              style={{ width: "100%", maxWidth: 420 }}
            />
          </div>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
          Read-only. Only an Operations Manager can resolve a callback.
        </p>
      )}

      {notice ? <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function ResolvedTable({ items }: { items: CallbackItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {["Was due", "Lead", "Campaign", "Outcome", "Closed", "Note"].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="nowrap" style={{ color: "var(--muted)" }}>
                {new Date(c.scheduledFor).toLocaleString()}
              </td>
              <td>
                <Link href={`/leads/${c.leadId}`} className="mono">
                  {c.phoneLast4 ? `******${c.phoneLast4}` : c.leadId.slice(0, 8)}
                </Link>
              </td>
              <td>{c.campaignName ?? "—"}</td>
              <td>
                <span className={`pill ${outcomeTone(c.status)}`}>{c.status}</span>
              </td>
              <td className="nowrap" style={{ color: "var(--muted)", fontSize: 12 }}>
                {c.resolvedAt ? new Date(c.resolvedAt).toLocaleString() : "—"}
                <div className="sub">{c.resolvedByEmail ?? "automatically"}</div>
              </td>
              <td style={{ fontSize: 12, color: "var(--muted)", maxWidth: 280 }}>{c.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function outcomeTone(status: string): string {
  if (status === "completed") return "ok";
  if (status === "missed") return "bad";
  return "";
}

/** "in 2 hours" / "3 days late", which is what an operator triages on. */
function relative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const late = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);

  const value =
    mins < 60
      ? `${mins} min`
      : mins < 60 * 48
        ? `${Math.round(mins / 60)} hr`
        : `${Math.round(mins / 1440)} days`;

  return late ? `${value} late` : `in ${value}`;
}

/**
 * `datetime-local` will not accept an ISO string with a zone, and rendering it
 * in UTC would show the operator a time nobody agreed to. Local wall-clock,
 * trimmed to minutes.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

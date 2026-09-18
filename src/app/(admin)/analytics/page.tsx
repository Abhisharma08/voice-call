import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { loadMetrics } from "@/lib/analytics/metrics";

export const dynamic = "force-dynamic";

/**
 * KPIs (PRD 21).
 *
 * The PRD's closing instruction for this section is the one worth honouring:
 * "Separate AI performance metrics from commercial outcome metrics." A high
 * qualification-completion rate says the model is doing its job; it says
 * nothing about whether the leads were any good. They are grouped separately
 * here so nobody reads one as the other.
 *
 * Every number comes from one query that reads each table once; see
 * `lib/analytics/metrics.ts` for why that matters.
 */

/**
 * The page reports a window, not all of history.
 *
 * An all-time figure is the one number guaranteed to get slower every day the
 * client uses the platform, and it is also the least useful: "connect rate
 * since we onboarded" tells an operator nothing about whether the campaign is
 * working now. The window is named on the page so nobody reads a 30-day number
 * as a lifetime one.
 */
const WINDOWS = {
  "7d": { label: "7 days", interval: "7 days" },
  "30d": { label: "30 days", interval: "30 days" },
  "90d": { label: "90 days", interval: "90 days" },
  all: { label: "All time", interval: null },
} as const;

type WindowKey = keyof typeof WINDOWS;

function windowKey(raw: string | undefined): WindowKey {
  return raw && raw in WINDOWS ? (raw as WindowKey) : "30d";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const user = await requireUser();
  const selected = windowKey((await searchParams).window);

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Analytics</h1>
        <p className="page-sub">Connect rate, intent mix and operational latency.</p>
        <div className="empty">Select a client from the sidebar to see its metrics.</div>
      </>
    );
  }

  const tenantId = user.activeTenantId;
  const interval = WINDOWS[selected].interval;

  const m = await withTenant(user, tenantId, (tx) => loadMetrics(tx, tenantId, interval));

  const n = (v: string | null) => Number(v ?? 0);
  const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);

  const attempts = n(m.attempts);
  const connected = n(m.connected);
  const analyses = n(m.analyses);

  return (
    <>
      <h1 className="page-title">Analytics</h1>
      <p className="page-sub">Operational and AI metrics for the selected client (PRD 21).</p>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
          <Link
            key={key}
            href={`/analytics?window=${key}`}
            className={`pill ${key === selected ? "ok" : ""}`}
            style={{ textDecoration: "none" }}
          >
            {WINDOWS[key].label}
          </Link>
        ))}
      </div>

      <h2 style={heading}>Operational</h2>
      <div className="grid">
        <Stat title="Leads" value={String(n(m.leads))} note="All statuses" />
        <Stat title="Call attempts" value={String(attempts)} note="Including retries" />
        <Stat title="Connect rate" value={pct(connected, attempts)} note="connected / attempts" />
        <Stat
          title="Lead-to-call p95"
          value={m.p95_latency_sec ? `${m.p95_latency_sec}s` : "—"}
          note="G2 target: under 30s"
        />
        <Stat
          title="Avg call duration"
          value={m.avg_duration ? `${m.avg_duration}s` : "—"}
          note="Connected calls"
        />
        <Stat
          title="Callback completion"
          value={pct(n(m.callbacks_done), n(m.callbacks))}
          note="completed / scheduled"
        />
      </div>

      <h2 style={heading}>AI performance</h2>
      <p style={sub}>
        How reliably the model produces a usable result &mdash; not whether the leads are good.
      </p>
      <div className="grid">
        <Stat
          title="Qualification completion"
          value={pct(analyses, connected)}
          note="structured results / connected calls"
        />
        <Stat
          title="Held for review"
          value={pct(n(m.pending_review) + n(m.reviewed), analyses)}
          note="Share that needed a human (PRD 26.3)"
        />
        <Stat
          title="Correction rate"
          value={pct(n(m.corrected), n(m.reviewed))}
          note="Reviewed results an operator changed"
        />
        <Stat title="Avg score" value={m.avg_score ?? "—"} note="Across all analyses" />
      </div>

      <h2 style={heading}>Commercial outcome</h2>
      <div className="grid">
        <Stat title="Hot rate" value={pct(n(m.hot), connected)} note="hot / connected calls" />
        <Stat
          title="CRM sync success"
          value={pct(n(m.sync_ok), n(m.sync_ok) + n(m.sync_bad))}
          note="successful / attempted"
        />
        <Stat
          title="Analysis tokens"
          value={`${(n(m.input_tokens) / 1000).toFixed(1)}k in / ${(n(m.output_tokens) / 1000).toFixed(1)}k out`}
          note="Input to cost per qualified lead"
        />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0, fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Not yet measurable
        </h3>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
          Cost per qualified lead needs the voice provider&rsquo;s per-minute rate, which arrives with a
          real provider adapter. Human follow-up SLA (sales acknowledgement minus hot result) needs the
          notification transport from PRD 16. Lead conversion needs the client&rsquo;s own won/lost
          outcome back from HubSpot.
        </p>
      </div>
    </>
  );
}

function Stat({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}

const heading: React.CSSProperties = { fontSize: 14, margin: "22px 0 8px", fontWeight: 600 };
const sub: React.CSSProperties = { margin: "0 0 10px", color: "var(--muted)", fontSize: 12 };

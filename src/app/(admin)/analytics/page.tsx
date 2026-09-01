import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";

export const dynamic = "force-dynamic";

/**
 * KPIs (PRD 21).
 *
 * The PRD's closing instruction for this section is the one worth honouring:
 * "Separate AI performance metrics from commercial outcome metrics." A high
 * qualification-completion rate says the model is doing its job; it says
 * nothing about whether the leads were any good. They are grouped separately
 * here so nobody reads one as the other.
 */
export default async function AnalyticsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Analytics</h1>
        <p className="page-sub">Connect rate, intent mix and operational latency.</p>
        <div className="empty">Select a client from the sidebar to see its metrics.</div>
      </>
    );
  }

  const m = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<Record<string, string | null>>(
      `select
         (select count(*) from leads)                                            as leads,
         (select count(*) from call_attempts)                                    as attempts,
         (select count(*) from call_attempts where status = 'completed')          as connected,
         (select count(*) from call_analyses)                                     as analyses,
         (select count(*) from call_analyses where intent = 'hot')                as hot,
         (select count(*) from call_analyses where review_status = 'pending_review') as pending_review,
         (select count(*) from call_analyses where review_status in ('confirmed','corrected')) as reviewed,
         (select count(*) from call_analyses where review_status = 'corrected')   as corrected,
         (select count(*) from callbacks)                                         as callbacks,
         (select count(*) from callbacks where status = 'completed')              as callbacks_done,
         (select count(*) from sync_outbox where status = 'succeeded')            as sync_ok,
         (select count(*) from sync_outbox where status in ('failed','dead_letter')) as sync_bad,
         (select coalesce(sum(input_tokens), 0) from call_analyses)               as input_tokens,
         (select coalesce(sum(output_tokens), 0) from call_analyses)              as output_tokens,
         -- PRD 21 "Lead-to-call latency = first_call_started - lead_created".
         -- Measured from queued_at: it is the moment the platform accepted
         -- responsibility for the lead, which is what G2's 30s target is about.
         (select round(extract(epoch from
                   percentile_cont(0.95) within group (order by ca.started_at - l.queued_at)))
            from call_attempts ca
            join leads l on l.id = ca.lead_id
           where ca.attempt_no = 1
             and l.queued_at is not null
             and ca.started_at is not null)                                       as p95_latency_sec,
         (select round(avg(duration_sec)) from call_attempts where status = 'completed')
                                                                                  as avg_duration,
         (select round(avg(score)) from call_analyses where score is not null)     as avg_score`,
    );
    return r.rows[0]!;
  });

  const n = (key: string) => Number(m[key] ?? 0);
  const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);

  const attempts = n("attempts");
  const connected = n("connected");
  const analyses = n("analyses");

  return (
    <>
      <h1 className="page-title">Analytics</h1>
      <p className="page-sub">Operational and AI metrics for the selected client (PRD 21).</p>

      <h2 style={heading}>Operational</h2>
      <div className="grid">
        <Stat title="Leads" value={String(n("leads"))} note="All statuses" />
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
          value={pct(n("callbacks_done"), n("callbacks"))}
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
          value={pct(n("pending_review") + n("reviewed"), analyses)}
          note="Share that needed a human (PRD 26.3)"
        />
        <Stat
          title="Correction rate"
          value={pct(n("corrected"), n("reviewed"))}
          note="Reviewed results an operator changed"
        />
        <Stat title="Avg score" value={m.avg_score ?? "—"} note="Across all analyses" />
      </div>

      <h2 style={heading}>Commercial outcome</h2>
      <div className="grid">
        <Stat title="Hot rate" value={pct(n("hot"), connected)} note="hot / connected calls" />
        <Stat
          title="CRM sync success"
          value={pct(n("sync_ok"), n("sync_ok") + n("sync_bad"))}
          note="successful / attempted"
        />
        <Stat
          title="Analysis tokens"
          value={`${(n("input_tokens") / 1000).toFixed(1)}k in / ${(n("output_tokens") / 1000).toFixed(1)}k out`}
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

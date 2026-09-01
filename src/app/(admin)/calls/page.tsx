import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";

export const dynamic = "force-dynamic";

/**
 * Call history (PRD 12, 14.2).
 *
 * Each row carries the consent basis it was placed under and the campaign
 * config version it ran against - PRD 26.1 and PRD 9 respectively. Those two
 * columns are what make a call individually justifiable months later, which is
 * the whole reason they are stamped at call time rather than joined at read
 * time.
 */
export default async function CallsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Calls</h1>
        <p className="page-sub">Call attempts, outcomes and qualification results.</p>
        <div className="empty">Select a client from the sidebar to see its calls.</div>
      </>
    );
  }

  const calls = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      lead_id: string;
      attempt_no: number;
      status: string;
      duration_sec: number | null;
      started_at: Date | null;
      failure_reason: string | null;
      consent_basis: string | null;
      campaign_config_version: number | null;
      provider: string;
      campaign_name: string | null;
      phone_last4: string | null;
      intent: string | null;
      score: number | null;
      review_status: string | null;
      has_transcript: boolean;
    }>(
      `select ca.id, ca.lead_id, ca.attempt_no, ca.status, ca.duration_sec, ca.started_at,
              ca.failure_reason, ca.consent_basis, ca.campaign_config_version, ca.provider,
              c.name as campaign_name, l.phone_last4,
              an.intent, an.score, an.review_status,
              exists (select 1 from call_transcripts t where t.call_id = ca.id) as has_transcript
         from call_attempts ca
         join leads l on l.id = ca.lead_id
         left join campaigns c on c.id = ca.campaign_id
         left join call_analyses an on an.call_id = ca.id
        order by ca.created_at desc
        limit 200`,
    );
    return r.rows;
  });

  return (
    <>
      <h1 className="page-title">Calls</h1>
      <p className="page-sub">
        {calls.length} attempt{calls.length === 1 ? "" : "s"}. Every attempt has a durable record,
        whether or not it connected.
      </p>

      {calls.length === 0 ? (
        <div className="empty">No calls placed yet for this client.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                {["When", "Lead", "Campaign", "Attempt", "Outcome", "Result", "Consent", "Config"].map(
                  (h) => (
                    <th key={h} style={th}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ ...td, whiteSpace: "nowrap", color: "var(--muted)", fontSize: 12 }}>
                    {c.started_at ? c.started_at.toLocaleString() : "—"}
                  </td>
                  <td style={td}>
                    <Link href={`/leads/${c.lead_id}`} style={{ fontFamily: "ui-monospace, monospace" }}>
                      {c.phone_last4 ? `******${c.phone_last4}` : c.lead_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td style={td}>{c.campaign_name ?? "—"}</td>
                  <td style={td}>#{c.attempt_no}</td>
                  <td style={td}>
                    <span className={`pill ${c.status === "completed" ? "ok" : "warn"}`}>{c.status}</span>
                    {c.duration_sec ? (
                      <span style={{ color: "var(--muted)", marginLeft: 6 }}>{c.duration_sec}s</span>
                    ) : null}
                    {c.failure_reason ? (
                      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 3 }}>
                        {c.failure_reason.slice(0, 60)}
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>
                    {c.intent ? (
                      <>
                        <span className="pill">{c.intent}</span>
                        {c.score !== null ? (
                          <span style={{ color: "var(--muted)", marginLeft: 6 }}>{c.score}</span>
                        ) : null}
                        {c.review_status === "pending_review" ? (
                          <div>
                            <span className="pill warn" style={{ marginTop: 3 }}>
                              held
                            </span>
                          </div>
                        ) : null}
                      </>
                    ) : c.has_transcript ? (
                      <span style={{ color: "var(--muted)" }}>awaiting analysis</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* PRD 26.1: the basis this specific call was placed under. */}
                  <td style={{ ...td, fontSize: 12, color: "var(--muted)" }}>
                    {c.consent_basis ?? "—"}
                  </td>
                  <td style={{ ...td, fontSize: 12, color: "var(--muted)" }}>
                    {c.campaign_config_version !== null ? `v${c.campaign_config_version}` : "—"}
                    <div style={{ fontSize: 11 }}>{c.provider}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "9px 12px",
  color: "var(--muted)",
  fontWeight: 500,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = { padding: "9px 12px", verticalAlign: "top" };

import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { RevealButton } from "./reveal-button";

export const dynamic = "force-dynamic";

/**
 * Lead detail (PRD 14.4).
 *
 * PRD 14.4 asks for identity and source, latest intent and score, full call
 * history, transcript/summary "according to access policy", the next callback,
 * CRM sync status and an audit timeline.
 *
 * "According to access policy" is doing real work: the transcript is high
 * sensitivity under PRD 26.2, so this page shows the model's summary by
 * default and gates the transcript itself behind an explicit, audited reveal.
 */
export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.activeTenantId) notFound();

  const data = await withTenant(user, user.activeTenantId, async (tx) => {
    const lead = await tx.query<{
      id: string;
      status: string;
      status_reason: string | null;
      source: string | null;
      hubspot_record_id: string | null;
      phone_last4: string | null;
      phone_country: string | null;
      dnc: boolean;
      call_attempt_count: number;
      next_call_at: Date | null;
      created_at: Date;
      campaign_name: string | null;
    }>(
      `select l.id, l.status, l.status_reason, l.source, l.hubspot_record_id,
              l.phone_last4, l.phone_country, l.dnc, l.call_attempt_count,
              l.next_call_at, l.created_at, c.name as campaign_name
         from leads l left join campaigns c on c.id = l.campaign_id
        where l.id = $1`,
      [id],
    );
    if (!lead.rows[0]) return null;

    const consents = await tx.query<{
      basis: string;
      source: string;
      evidence_ref: string | null;
      captured_at: Date;
      captured_by: string | null;
      status: string;
    }>(
      `select basis, source, evidence_ref, captured_at, captured_by, status
         from consents where lead_id = $1 order by captured_at desc`,
      [id],
    );

    const calls = await tx.query<{
      id: string;
      attempt_no: number;
      status: string;
      duration_sec: number | null;
      started_at: Date | null;
      consent_basis: string | null;
      campaign_config_version: number | null;
      intent: string | null;
      score: number | null;
      review_status: string | null;
      summary: string | null;
    }>(
      `select ca.id, ca.attempt_no, ca.status, ca.duration_sec, ca.started_at,
              ca.consent_basis, ca.campaign_config_version,
              an.intent, an.score, an.review_status,
              an.structured_payload ->> 'summary' as summary
         from call_attempts ca
         left join call_analyses an on an.call_id = ca.id
        where ca.lead_id = $1
        order by ca.attempt_no desc`,
      [id],
    );

    const callbacks = await tx.query<{ scheduled_for: Date; status: string }>(
      `select scheduled_for, status from callbacks where lead_id = $1 order by scheduled_for desc`,
      [id],
    );

    const sync = await tx.query<{ target: string; status: string; last_error: string | null }>(
      `select o.target, o.status, o.last_error
         from sync_outbox o
        where o.dedupe_key in (select ca.id::text from call_attempts ca where ca.lead_id = $1)
        order by o.created_at desc`,
      [id],
    );

    const audit = await tx.query<{
      action: string;
      actor_type: string;
      actor_label: string | null;
      created_at: Date;
    }>(
      `select action, actor_type, actor_label, created_at
         from audit_events
        where entity_id = $1
           or entity_id in (select ca.id::text from call_attempts ca where ca.lead_id = $1)
        order by created_at desc limit 40`,
      [id],
    );

    return {
      lead: lead.rows[0],
      consents: consents.rows,
      calls: calls.rows,
      callbacks: callbacks.rows,
      sync: sync.rows,
      audit: audit.rows,
    };
  });

  if (!data) notFound();
  const { lead } = data;

  return (
    <>
      <h1 className="page-title">
        {lead.phone_last4 ? `Lead ending ${lead.phone_last4}` : "Lead"}
      </h1>
      <p className="page-sub">
        <Link href="/leads">&larr; All leads</Link>
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        <Card title="Status">
          <span className={`pill ${lead.status === "qualified" ? "ok" : "warn"}`}>{lead.status}</span>
          {lead.status_reason ? <Note>{lead.status_reason}</Note> : null}
          {lead.dnc ? <Note>On the do-not-call list</Note> : null}
        </Card>

        <Card title="Contact">
          <div style={{ fontFamily: "ui-monospace, monospace" }}>
            {lead.phone_last4 ? `******${lead.phone_last4}` : "no number"}
          </div>
          <Note>
            {lead.phone_country ?? "unknown region"} · source {lead.source ?? "unknown"}
          </Note>
          {can(user.role, "pii:reveal") ? (
            <RevealButton tenantId={user.activeTenantId} leadId={lead.id} />
          ) : null}
        </Card>

        <Card title="Campaign">
          {lead.campaign_name ?? "none"}
          <Note>{lead.call_attempt_count} attempts</Note>
          {lead.next_call_at ? <Note>next call {lead.next_call_at.toLocaleString()}</Note> : null}
        </Card>

        <Card title="CRM">
          {lead.hubspot_record_id ?? "not linked"}
          {data.sync.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              {data.sync.map((s, i) => (
                <div key={i} style={{ fontSize: 11, marginBottom: 2 }}>
                  <span className={`pill ${s.status === "succeeded" ? "ok" : "warn"}`}>
                    {s.target}: {s.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Note>nothing synced yet</Note>
          )}
        </Card>
      </div>

      {/* PRD 26.1: the evidentiary trail for why this person could be called. */}
      <Section title="Consent">
        {data.consents.length === 0 ? (
          <div className="empty">
            No consent record. This lead cannot be queued for calling (PRD 26.1).
          </div>
        ) : (
          data.consents.map((c, i) => (
            <div key={i} className="row" style={{ gap: 8, fontSize: 12, flexWrap: "wrap" }}>
              <span className={`pill ${c.status === "active" ? "ok" : "warn"}`}>{c.status}</span>
              <span className="pill">{c.basis}</span>
              <span style={{ color: "var(--muted)" }}>
                via {c.source}
                {c.evidence_ref ? ` · evidence ${c.evidence_ref}` : " · no evidence reference"}
                {c.captured_by ? ` · recorded as ${c.captured_by}` : ""}
                {` · ${c.captured_at.toLocaleDateString()}`}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="Call history">
        {data.calls.length === 0 ? (
          <div className="empty">No calls placed yet.</div>
        ) : (
          data.calls.map((c) => (
            <div key={c.id} className="card stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="pill">attempt {c.attempt_no}</span>
                <span className={`pill ${c.status === "completed" ? "ok" : "warn"}`}>{c.status}</span>
                {c.duration_sec ? <span className="pill">{c.duration_sec}s</span> : null}
                {c.intent ? <span className="pill">{c.intent}</span> : null}
                {c.score !== null ? <span className="pill">score {c.score}</span> : null}
                {c.review_status === "pending_review" ? (
                  <span className="pill warn">held for review</span>
                ) : null}
                <div className="spacer" />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {c.started_at?.toLocaleString() ?? ""}
                  {c.campaign_config_version !== null ? ` · config v${c.campaign_config_version}` : ""}
                  {c.consent_basis ? ` · ${c.consent_basis}` : ""}
                </span>
              </div>
              {/* The summary, not the transcript: PRD 26.2 treats recorded
                  content as independently regulated and gates it separately. */}
              {c.summary ? <div style={{ fontSize: 13 }}>{c.summary}</div> : null}
            </div>
          ))
        )}
      </Section>

      {data.callbacks.length > 0 ? (
        <Section title="Callbacks">
          {data.callbacks.map((c, i) => (
            <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
              <span className="pill">{c.status}</span>
              <span>{c.scheduled_for.toLocaleString()}</span>
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="Audit timeline">
        {data.audit.map((a, i) => (
          <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
            <span style={{ color: "var(--muted)", minWidth: 150 }}>
              {a.created_at.toLocaleString()}
            </span>
            <span className="pill">{a.action}</span>
            <span style={{ color: "var(--muted)" }}>{a.actor_label ?? a.actor_type}</span>
          </div>
        ))}
      </Section>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 14, margin: "0 0 8px", fontWeight: 600 }}>{title}</h2>
      <div className="stack" style={{ gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

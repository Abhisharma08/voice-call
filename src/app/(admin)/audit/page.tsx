import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { AccessDenied } from "../access-denied";

export const dynamic = "force-dynamic";

/**
 * Audit log (PRD 14.1, 17.1).
 *
 * PRD 17.1 requires configuration changes, manual suppression, routing changes
 * and data exports to be audited, and PRD 26.2 adds every read of a phone
 * number, transcript or recording. This page is where that record is actually
 * legible.
 *
 * The table is append-only for runtime roles (migration 0002 grants no UPDATE
 * or DELETE), so nothing here can have been edited after the fact.
 */

const CATEGORIES: Record<string, { label: string; actions: string[] }> = {
  config: {
    label: "Configuration",
    actions: [
      "tenant.created",
      "tenant.status_changed",
      "campaign.created",
      "campaign.updated",
      "campaign.activated",
      "campaign.deactivated",
      "integration.created",
      "integration.disabled",
    ],
  },
  compliance: {
    label: "Compliance & consent",
    actions: [
      "campaign.consent_declared",
      "campaign.compliance_approved",
      "campaign.compliance_revoked",
      "consent.recorded",
    ],
  },
  sensitive: {
    label: "Sensitive reads",
    actions: ["pii.reveal", "transcript.read", "recording.read"],
  },
  review: {
    label: "Human review",
    actions: ["review.confirmed", "review.corrected", "review.rejected"],
  },
  access: {
    label: "Access",
    actions: ["tenant.entered", "tenant.access_denied", "elevation.granted", "elevation.revoked"],
  },
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const user = await requireUser();
  const { category } = await searchParams;

  if (!can(user.role, "audit:read")) {
    return <AccessDenied title="Audit Log" needs="audit:read" />;
  }

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Audit Log</h1>
        <p className="page-sub">Configuration changes, suppressions, exports and sensitive reads.</p>
        <div className="empty">Select a client from the sidebar to see its audit trail.</div>
      </>
    );
  }

  const filter = category && CATEGORIES[category] ? CATEGORIES[category].actions : null;

  const events = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      action: string;
      actor_type: string;
      actor_label: string | null;
      entity_type: string | null;
      entity_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
      ip: string | null;
    }>(
      filter
        ? `select id, action, actor_type, actor_label, entity_type, entity_id, metadata, created_at, ip
             from audit_events where action = any($1)
            order by created_at desc limit 300`
        : `select id, action, actor_type, actor_label, entity_type, entity_id, metadata, created_at, ip
             from audit_events order by created_at desc limit 300`,
      filter ? [filter] : [],
    );
    return r.rows;
  });

  return (
    <>
      <h1 className="page-title">Audit Log</h1>
      <p className="page-sub">
        Append-only. The runtime database role can insert and read here, but cannot update or delete.
      </p>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        <a href="/audit" className={`pill ${!category ? "ok" : ""}`}>
          All
        </a>
        {Object.entries(CATEGORIES).map(([key, c]) => (
          <a key={key} href={`/audit?category=${key}`} className={`pill ${category === key ? "ok" : ""}`}>
            {c.label}
          </a>
        ))}
      </div>

      {events.length === 0 ? (
        <div className="empty">No events recorded for this filter.</div>
      ) : (
        <div className="table-wrap">
          <table className="table dense">
            <thead>
              <tr>
                {["When", "Action", "Actor", "Entity", "Detail"].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap" style={{ color: "var(--muted)" }}>
                    {e.created_at.toLocaleString()}
                  </td>
                  <td>
                    <span className={`pill ${tone(e.action)}`}>{e.action}</span>
                  </td>
                  <td>
                    {e.actor_label ?? e.actor_type}
                    <div className="sub">
                      {e.actor_type}
                      {e.ip ? ` · ${e.ip}` : ""}
                    </div>
                  </td>
                  <td style={{ color: "var(--muted)" }}>
                    {e.entity_type}
                    {e.entity_id ? (
                      <div className="mono" style={{ fontSize: 11 }}>
                        {e.entity_id.slice(0, 8)}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ maxWidth: 420 }}>
                    <code style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-word" }}>
                      {summarise(e.metadata)}
                    </code>
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

function tone(action: string): string {
  if (action.includes("denied") || action.includes("rejected") || action.includes("revoked")) return "warn";
  if (action.startsWith("pii.") || action.startsWith("transcript.") || action.startsWith("recording."))
    return "warn";
  if (action.includes("approved") || action.includes("confirmed")) return "ok";
  return "";
}

function summarise(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ")
    .slice(0, 300);
}

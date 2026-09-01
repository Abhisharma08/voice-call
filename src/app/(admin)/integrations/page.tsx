import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { AddIntegrationForm } from "./add-integration-form";

export const dynamic = "force-dynamic";

/**
 * Per-tenant integration credentials (PRD 13, PRD 22 Phase 2).
 *
 * The credential itself is never selected here. PRD 17.1 says to store only
 * secret references, and the corollary is that the UI has nothing to show: a
 * credential is write-only from the moment it is sealed. What an operator
 * actually needs to know is whether it still works, which is what the status
 * and last error report.
 */
export default async function IntegrationsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Integrations</h1>
        <p className="page-sub">Per-client HubSpot, Google Sheets and voice provider credentials.</p>
        <div className="empty">Select a client from the sidebar to see its integrations.</div>
      </>
    );
  }

  const integrations = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      type: string;
      name: string;
      status: string;
      last_error: string | null;
      created_at: Date;
      key_id: string | null;
      created_by_email: string | null;
      used_by_campaigns: string;
    }>(
      `select i.id, i.type, i.name, i.status, i.last_error, i.created_at,
              s.key_id, u.email as created_by_email,
              (select count(*) from campaigns c where c.hubspot_integration_id = i.id) as used_by_campaigns
         from integrations i
         left join secrets s on s.id = i.credential_ref
         left join users u on u.id = i.created_by
        order by i.type, i.name`,
    );
    return r.rows;
  });

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <p className="page-sub">
        Agency-managed credentials for this client. Secrets are sealed on entry and never displayed
        again.
      </p>

      {integrations.length === 0 ? (
        <div className="empty">No integrations configured for this client yet.</div>
      ) : (
        <div className="stack">
          {integrations.map((i) => (
            <div key={i.id} className="card stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{i.name}</strong>
                <span className="pill">{i.type}</span>
                <span className={`pill ${i.status === "active" ? "ok" : "warn"}`}>{i.status}</span>
                <div className="spacer" />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  key {i.key_id ?? "none"} · added by {i.created_by_email ?? "system"}
                </span>
              </div>

              {Number(i.used_by_campaigns) > 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Used by {i.used_by_campaigns} campaign{Number(i.used_by_campaigns) === 1 ? "" : "s"}
                </div>
              ) : null}

              {/* PRD 18.2: an auth failure disables the integration rather than
                  retrying into a rate limit. Surfacing the error is how it gets
                  fixed. */}
              {i.last_error ? (
                <div style={{ fontSize: 12, color: "var(--danger)" }}>{i.last_error}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {can(user.role, "secret:write") ? (
        <div style={{ marginTop: 20 }}>
          <AddIntegrationForm tenantId={user.activeTenantId} />
        </div>
      ) : (
        <p className="note" style={{ color: "var(--muted)", fontSize: 12, marginTop: 16 }}>
          Adding credentials is a Campaign Manager or Agency Admin action.
        </p>
      )}
    </>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listAccessibleTenants, withTenant } from "@/lib/auth/tenant";
import { can, hasGlobalScope } from "@/lib/auth/rbac";
import { CreateTenantForm } from "./create-tenant-form";
import { TenantStatusControl } from "./tenant-status-control";

export const dynamic = "force-dynamic";

/**
 * Client accounts (PRD 14.2 "Client health", 14.3 onboarding).
 *
 * Clients never log in (PRD 14.3), so this is an agency-internal roster, not a
 * customer-facing account area. The list is built from the caller's own
 * assignments, so a Campaign Manager sees only their clients (PRD 8.2).
 */
export default async function ClientsPage() {
  const user = await requireUser();
  const tenants = await listAccessibleTenants(user);

  // Per-tenant health, each read inside that tenant's own RLS scope.
  const rows = await Promise.all(
    tenants.map(async (t) => {
      const stats = await withTenant(user, t.id, async (tx) => {
        const r = await tx.query<{
          campaigns: string;
          active_campaigns: string;
          leads: string;
          queued: string;
          pending_review: string;
          integrations: string;
        }>(
          `select
             (select count(*) from campaigns)                                      as campaigns,
             (select count(*) from campaigns where active)                         as active_campaigns,
             (select count(*) from leads)                                          as leads,
             (select count(*) from leads where status = 'queued')                  as queued,
             (select count(*) from call_analyses where review_status = 'pending_review') as pending_review,
             (select count(*) from integrations where status = 'active')           as integrations`,
        );
        return r.rows[0]!;
      });

      return { tenant: t, stats };
    }),
  );

  return (
    <>
      <h1 className="page-title">Clients</h1>
      <p className="page-sub">
        Agency-managed client accounts. Clients do not log in; a Campaign Manager configures each
        account on their behalf.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          No clients assigned to you.{" "}
          {hasGlobalScope(user.role) ? "Create one below." : "An Agency Admin can assign you to one."}
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {rows.map(({ tenant, stats }) => {
            const active = Number(stats.active_campaigns);
            const total = Number(stats.campaigns);
            return (
              <div key={tenant.id} className="card stack" style={{ gap: 10 }}>
                <div className="row">
                  <strong>{tenant.name}</strong>
                  <div className="spacer" />
                  <span className={`pill ${tenant.status === "active" ? "ok" : "warn"}`}>
                    {tenant.status}
                  </span>
                </div>

                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="pill">{stats.leads} leads</span>
                  <span className="pill">{stats.queued} queued</span>
                  <span className="pill">{total} campaigns</span>
                  <span className="pill">{stats.integrations} integrations</span>
                  {Number(stats.pending_review) > 0 ? (
                    <span className="pill warn">{stats.pending_review} to review</span>
                  ) : null}
                </div>

                {total > 0 && active < total ? (
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {total - active} of {total} campaigns not calling yet
                  </div>
                ) : null}

                <div className="row" style={{ gap: 8 }}>
                  <Link href={`/campaigns?tenant=${tenant.id}`} style={{ fontSize: 12 }}>
                    Campaigns &rarr;
                  </Link>
                  <Link href={`/integrations?tenant=${tenant.id}`} style={{ fontSize: 12 }}>
                    Integrations &rarr;
                  </Link>
                  <div className="spacer" />
                  {can(user.role, "tenant:write") ? (
                    <TenantStatusControl tenantId={tenant.id} status={tenant.status} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {can(user.role, "tenant:write") ? (
        <div style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Onboard a client</h2>

          {/*
            Two paths on purpose. The full onboarding creates the campaign, its
            script and questions, and the credential HubSpot posts with, which
            is what "add a client" actually means. The bare form below remains
            for a tenant that is not getting a campaign yet.
          */}
          {can(user.role, "campaign:write") ? (
            <div className="card stack" style={{ maxWidth: 640, marginBottom: 16 }}>
              <strong>Client, campaign and HubSpot credential in one step</strong>
              <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
                Starts the campaign from a template so it has a script and qualification
                questions, and shows you the webhook URL and token to paste into the
                client&apos;s HubSpot.
              </p>
              <div className="row">
                <Link href="/clients/new">
                  <button type="button">Onboard a client</button>
                </Link>
              </div>
            </div>
          ) : null}

          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--muted)" }}>
              Or create just the client record
            </summary>
            <div style={{ marginTop: 12 }}>
              <CreateTenantForm />
            </div>
          </details>
        </div>
      ) : null}
    </>
  );
}

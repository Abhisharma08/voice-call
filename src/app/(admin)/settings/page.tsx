import { requireUser } from "@/lib/auth/current-user";
import { AccessDenied } from "../access-denied";
import { withGlobalScope } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { StaffTable, type StaffRow, type TenantOption } from "./staff-table";
import { CreateUserForm } from "./create-user-form";

export const dynamic = "force-dynamic";

/**
 * Staff, assignments and elevations.
 *
 * The primary isolation risk in this platform is an
 * internal operator viewing, editing or exporting the wrong client's leads,
 * not an external attacker probing for tenant IDs. This page is where that
 * risk is actually managed: who exists, what they are scoped to, and which
 * temporary exceptions are currently live.
 */
export default async function SettingsPage() {
  const user = await requireUser();

  if (!can(user.role, "user:read")) {
    return <AccessDenied title="Settings" needs="user:read" />;
  }

  const data = await withGlobalScope(user, async (tx) => {
    const users = await tx.query<{
      id: string;
      email: string;
      name: string;
      role: string;
      status: string;
      last_login_at: Date | null;
    }>(`select id, email, name, role, status, last_login_at from users order by role, email`);

    const assignments = await tx.query<{
      user_id: string;
      tenant_id: string;
      tenant_name: string;
      role: string;
    }>(
      `select a.user_id, a.tenant_id, t.name as tenant_name, a.role
         from user_tenant_assignments a join tenants t on t.id = a.tenant_id
        order by t.name`,
    );

    const elevations = await tx.query<{
      id: string;
      user_id: string;
      user_email: string;
      tenant_id: string;
      tenant_name: string;
      reason: string;
      expires_at: Date;
      granted_by_email: string | null;
    }>(
      `select e.id, e.user_id, u.email as user_email, e.tenant_id, t.name as tenant_name,
              e.reason, e.expires_at, g.email as granted_by_email
         from access_elevations e
         join users u on u.id = e.user_id
         join tenants t on t.id = e.tenant_id
         left join users g on g.id = e.granted_by
        where e.revoked_at is null and e.expires_at > now()
        order by e.expires_at`,
    );

    const tenants = await tx.query<{ id: string; name: string }>(
      `select id, name from tenants order by name`,
    );

    return {
      users: users.rows.map<StaffRow>((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        lastLoginAt: u.last_login_at?.toISOString() ?? null,
        assignments: assignments.rows
          .filter((a) => a.user_id === u.id)
          .map((a) => ({ tenantId: a.tenant_id, tenantName: a.tenant_name, role: a.role })),
      })),
      elevations: elevations.rows.map((e) => ({
        id: e.id,
        userEmail: e.user_email,
        tenantName: e.tenant_name,
        reason: e.reason,
        expiresAt: e.expires_at.toISOString(),
        grantedBy: e.granted_by_email,
      })),
      tenants: tenants.rows.map<TenantOption>((t) => ({ id: t.id, name: t.name })),
    };
  });

  const editable = can(user.role, "user:write");

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Staff, client assignments and temporary access. Access follows assignment, not job title.
      </p>

      {data.elevations.length > 0 ? (
        <div className="card stack" style={{ gap: 8, marginBottom: 16 }}>
          <div className="row">
            <strong style={{ fontSize: 13 }}>Live access elevations</strong>
            <span className="pill warn">{data.elevations.length}</span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
            Temporary access outside an assignment. Each expires on its own; revoke early if the
            reason no longer holds.
          </p>
          {data.elevations.map((e) => (
            <div key={e.id} className="row" style={{ gap: 8, fontSize: 12, flexWrap: "wrap" }}>
              <span className="pill warn">{e.userEmail}</span>
              <span>&rarr;</span>
              <span className="pill">{e.tenantName}</span>
              <span style={{ color: "var(--muted)" }}>{e.reason}</span>
              <div className="spacer" />
              <span style={{ color: "var(--muted)" }}>
                expires {new Date(e.expiresAt).toLocaleString()}
                {e.grantedBy ? ` · by ${e.grantedBy}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <StaffTable
        staff={data.users}
        tenants={data.tenants}
        currentUserId={user.id}
        editable={editable}
        canElevate={can(user.role, "elevation:grant")}
      />

      {editable ? (
        <div style={{ marginTop: 20 }}>
          <CreateUserForm />
        </div>
      ) : null}
    </>
  );
}

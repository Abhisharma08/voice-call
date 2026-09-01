import type { PoolClient } from "pg";
import { withActorScope, withScope, type TenantScope } from "@/db/client";
import { hasGlobalScope, type Role } from "@/lib/auth/rbac";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit";

/**
 * Tenant middleware (PRD 8.2).
 *
 * "Application authorization must derive tenant context from the authenticated
 * session, not from user-supplied request fields." A tenant id in a URL is
 * treated as a *request* to enter that tenant, which this module either grants
 * from the user's assignments or refuses. It is never trusted as proof.
 *
 * "No workflow or API endpoint may accept an arbitrary tenant_id from a public
 * client and trust it as authorization."
 */

export class TenantAccessError extends Error {
  constructor(readonly tenantId: string) {
    // PRD 23.3: cross-tenant URL manipulation returns 403/404 with no
    // disclosure of whether the tenant exists.
    super("Not found");
    this.name = "TenantAccessError";
  }
}

export interface TenantGrant {
  tenantId: string;
  role: Role;
  via: "assignment" | "elevation" | "global_admin";
}

/** Tenants this user may enter right now, without requesting an elevation. */
export async function listAccessibleTenants(
  user: AuthenticatedUser,
): Promise<Array<{ id: string; name: string; slug: string; status: string }>> {
  if (hasGlobalScope(user.role)) {
    return withScope({ tenantId: null, globalScope: true, actorId: user.id, actorType: "user" }, async (tx) => {
      const r = await tx.query(`select id, name, slug, status from tenants order by name`);
      return r.rows;
    });
  }

  return withActorScope(user.id, async (tx) => {
    const r = await tx.query(
      `select t.id, t.name, t.slug, t.status
         from tenants t
         join user_tenant_assignments a on a.tenant_id = t.id
        where a.user_id = $1
        order by t.name`,
      [user.id],
    );
    return r.rows;
  });
}

/**
 * Decide whether `user` may act inside `tenantId`, and on what basis.
 * Returns null rather than throwing, so callers can choose the response shape.
 */
export async function resolveGrant(
  user: AuthenticatedUser,
  tenantId: string,
): Promise<TenantGrant | null> {
  if (hasGlobalScope(user.role)) {
    return { tenantId, role: user.role, via: "global_admin" };
  }

  return withActorScope(user.id, async (tx) => {
    const assignment = await tx.query<{ role: Role }>(
      `select role from user_tenant_assignments where user_id = $1 and tenant_id = $2`,
      [user.id, tenantId],
    );
    const assigned = assignment.rows[0];
    if (assigned) return { tenantId, role: assigned.role, via: "assignment" as const };

    // PRD 8.2: reaching outside the assignment set requires an explicit,
    // time-boxed, logged elevation - not merely being agency staff.
    const elevation = await tx.query(
      `select 1 from access_elevations
        where user_id = $1 and tenant_id = $2
          and revoked_at is null and expires_at > now()
        limit 1`,
      [user.id, tenantId],
    );
    if (elevation.rowCount && elevation.rowCount > 0) {
      return { tenantId, role: user.role, via: "elevation" as const };
    }

    return null;
  });
}

export async function requireGrant(user: AuthenticatedUser, tenantId: string): Promise<TenantGrant> {
  const grant = await resolveGrant(user, tenantId);
  if (!grant) {
    await recordAudit({
      tenantId: null,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      action: "tenant.access_denied",
      entityType: "tenant",
      entityId: tenantId,
      metadata: { role: user.role },
    });
    throw new TenantAccessError(tenantId);
  }
  return grant;
}

export function scopeFor(user: AuthenticatedUser, grant: TenantGrant): TenantScope {
  return {
    tenantId: grant.tenantId,
    // Even an Agency Admin runs pinned to one tenant once they have entered
    // one, so a stray unfiltered query cannot span clients.
    globalScope: false,
    actorId: user.id,
    actorType: "user",
  };
}

/**
 * The wrapper request handlers should use: authorize, then run everything
 * inside an RLS transaction pinned to that tenant.
 */
export async function withTenant<T>(
  user: AuthenticatedUser,
  tenantId: string,
  fn: (tx: PoolClient, grant: TenantGrant) => Promise<T>,
): Promise<T> {
  const grant = await requireGrant(user, tenantId);
  return withScope(scopeFor(user, grant), (tx) => fn(tx, grant));
}

/** Cross-tenant reads for the Agency Admin dashboard only (PRD 14.2 client health). */
export async function withGlobalScope<T>(
  user: AuthenticatedUser,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!hasGlobalScope(user.role)) throw new TenantAccessError("global");
  return withScope(
    { tenantId: null, globalScope: true, actorId: user.id, actorType: "user" },
    fn,
  );
}

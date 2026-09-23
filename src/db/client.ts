import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/log";

/**
 * Database access. Three connections, three privilege levels:
 *
 *   owner   - migrations and admin scripts only. Owns the tables.
 *   app     - Next.js request handling for authenticated staff. RLS enforced.
 *   service - n8n workers and background jobs. RLS enforced, no access to
 *             staff accounts or sessions ("service identity only").
 *
 * Nothing in the request path may use the owner pool. RLS is only meaningful
 * against a non-owner role, and `force row level security` in migration 0002
 * closes the owner loophole as a second line of defence.
 */

export type ConnectionKind = "owner" | "app" | "service";

const pools = new Map<ConnectionKind, Pool>();

function urlFor(kind: ConnectionKind): string {
  const e = env();
  switch (kind) {
    case "owner":
      return e.DATABASE_URL;
    case "app":
      return e.DATABASE_URL_APP;
    case "service":
      return e.DATABASE_URL_SERVICE;
  }
}

export function pool(kind: ConnectionKind = "app"): Pool {
  let existing = pools.get(kind);
  if (!existing) {
    existing = new Pool({
      connectionString: urlFor(kind),
      // Serverless multiplies pools: every warm instance holds its own. A
      // small ceiling against a pooled connection string is what keeps a
      // traffic spike from exhausting the database's connection slots, which
      // fails as "cannot connect" across the whole app rather than as
      // backpressure on the one route that spiked.
      max: kind === "owner" ? 2 : (env().DB_POOL_MAX ?? (env().APP_ENV === "development" ? 10 : 3)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: `leadcalling-${kind}`,
    });
    existing.on("error", (err) => {
      logger.error("pg pool error", {
        kind,
        err: err.message,
      });
    });
    pools.set(kind, existing);
  }
  return existing;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

/**
 * The scope a transaction runs under. Built by the tenant middleware from the
 * authenticated session, never from a request body or query parameter.
 */
export interface TenantScope {
  tenantId: string | null;
  /** Agency Admin only. Everything else is pinned to one tenant. */
  globalScope: boolean;
  actorId: string | null;
  actorType: "user" | "service" | "system";
}

export const SYSTEM_SCOPE: TenantScope = {
  tenantId: null,
  globalScope: true,
  actorId: null,
  actorType: "system",
};

export function tenantScope(tenantId: string, actorId: string | null, actorType: TenantScope["actorType"] = "user"): TenantScope {
  return { tenantId, globalScope: false, actorId, actorType };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidOrNull(value: string | null, label: string): void {
  if (value !== null && !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

/**
 * Run `fn` inside a transaction whose RLS scope is fixed for its whole
 * lifetime. `set_config(..., true)` makes the setting transaction-local, so a
 * pooled connection can never carry one request's tenant scope into the next.
 */
export async function withScope<T>(
  scope: TenantScope,
  fn: (tx: PoolClient) => Promise<T>,
  kind: ConnectionKind = "app",
): Promise<T> {
  assertUuidOrNull(scope.tenantId, "tenantId");
  assertUuidOrNull(scope.actorId, "actorId");

  if (!scope.globalScope && scope.tenantId === null) {
    throw new Error("Refusing to open an unscoped transaction: set a tenantId or use global scope");
  }

  const client = await pool(kind).connect();
  try {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.tenant_id',    $1, true),
         set_config('app.global_scope', $2, true),
         set_config('app.actor_id',     $3, true),
         set_config('app.actor_type',   $4, true)`,
      [
        scope.tenantId ?? "",
        scope.globalScope ? "on" : "off",
        scope.actorId ?? "",
        scope.actorType,
      ],
    );

    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Actor scope with no tenant pinned. Used for the one step that has to happen
 * before tenant scope exists: reading which tenants this user is assigned to.
 * RLS still applies - the assignments and elevations policies match on
 * app.actor_id - so a user can only see their own grants, and every
 * tenant-scoped business table stays invisible because tenant_id can never
 * match.
 */
export async function withActorScope<T>(
  actorId: string,
  fn: (tx: PoolClient) => Promise<T>,
  kind: ConnectionKind = "app",
): Promise<T> {
  assertUuidOrNull(actorId, "actorId");

  const client = await pool(kind).connect();
  try {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.tenant_id',    '',   true),
         set_config('app.global_scope', 'off', true),
         set_config('app.actor_id',     $1,   true),
         set_config('app.actor_type',   'user', true)`,
      [actorId],
    );
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Escape hatch for the pre-authentication path only: session lookup and login,
 * which happen before any tenant is known. Callers must not read tenant-scoped
 * tables here, and RLS would deny them anyway.
 */
export async function withoutScope<T>(
  fn: (tx: PoolClient) => Promise<T>,
  kind: ConnectionKind = "app",
): Promise<T> {
  const client = await pool(kind).connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

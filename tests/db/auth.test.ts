import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools } from "@/db/client";
import { hashPassword } from "@/lib/crypto/password";
import { login, logout, resolveSession, setActiveTenant } from "@/lib/auth/session";
import { listAccessibleTenants, requireGrant, resolveGrant, TenantAccessError } from "@/lib/auth/tenant";

/**
 * The authentication path runs before any tenant scope exists, which is
 * exactly where RLS is easiest to get wrong: too tight and nobody can log in,
 * too loose and the whole isolation model leaks. These tests pin both ends.
 */

const TENANT_X = "dddddddd-0000-4000-8000-000000000001";
const TENANT_Y = "eeeeeeee-0000-4000-8000-000000000002";
const MANAGER = "ffffffff-0000-4000-8000-000000000003";
const ADMIN = "99999999-0000-4000-8000-000000000004";
const WORKER = "88888888-0000-4000-8000-000000000005";

const PASSWORD = "test-password-9931";

let owner: Client;

async function asGlobal<T>(fn: () => Promise<T>): Promise<T> {
  await owner.query("begin");
  await owner.query(`select set_config('app.global_scope', 'on', true)`);
  try {
    const out = await fn();
    await owner.query("commit");
    return out;
  } catch (err) {
    await owner.query("rollback").catch(() => {});
    throw err;
  }
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  const hash = await hashPassword(PASSWORD);

  await asGlobal(async () => {
    await owner.query(
      `insert into tenants (id, name, slug) values
         ($1, 'Auth Test X', 'auth-test-x'),
         ($2, 'Auth Test Y', 'auth-test-y')
       on conflict (id) do nothing`,
      [TENANT_X, TENANT_Y],
    );

    await owner.query(
      `insert into users (id, email, name, role, password_hash, status) values
         ($1, 'auth-manager@agency.test', 'Auth Manager', 'campaign_manager', $4, 'active'),
         ($2, 'auth-admin@agency.test',   'Auth Admin',   'agency_admin',     $4, 'active'),
         ($3, 'auth-worker@agency.test',  'n8n Worker',   'service',          $4, 'active')
       on conflict (id) do nothing`,
      [MANAGER, ADMIN, WORKER, hash],
    );

    await owner.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role)
       values ($1, $2, 'campaign_manager') on conflict do nothing`,
      [MANAGER, TENANT_X],
    );
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from users where id = any($1::uuid[])`, [[MANAGER, ADMIN, WORKER]]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT_X, TENANT_Y]]);
  });
  await owner.end();
  await closePools();
});

describe("login", () => {
  it("authenticates a valid staff account", async () => {
    const result = await login("auth-manager@agency.test", PASSWORD);
    expect(result).not.toBeNull();
    expect(result?.user.role).toBe("campaign_manager");
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is case-insensitive on email", async () => {
    expect(await login("AUTH-MANAGER@AGENCY.TEST", PASSWORD)).not.toBeNull();
  });

  it("rejects a wrong password", async () => {
    expect(await login("auth-manager@agency.test", "wrong")).toBeNull();
  });

  it("rejects an unknown account", async () => {
    expect(await login("nobody@agency.test", PASSWORD)).toBeNull();
  });

  it("refuses to log in a service identity", async () => {
    // PRD 4: the n8n worker is a service identity, not a human surface.
    expect(await login("auth-worker@agency.test", PASSWORD)).toBeNull();
  });

  it("refuses a disabled account", async () => {
    await asGlobal(async () => {
      await owner.query(`update users set status = 'disabled' where id = $1`, [ADMIN]);
    });
    expect(await login("auth-admin@agency.test", PASSWORD)).toBeNull();
    await asGlobal(async () => {
      await owner.query(`update users set status = 'active' where id = $1`, [ADMIN]);
    });
  });
});

describe("sessions", () => {
  it("resolves a live session and revokes it on logout", async () => {
    const result = await login("auth-manager@agency.test", PASSWORD);
    if (!result) throw new Error("login failed");

    const resolved = await resolveSession(result.token);
    expect(resolved?.id).toBe(MANAGER);

    await logout(result.token);
    expect(await resolveSession(result.token)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await resolveSession("not-a-real-token")).toBeNull();
  });

  it("does not store the raw token", async () => {
    const result = await login("auth-manager@agency.test", PASSWORD);
    if (!result) throw new Error("login failed");

    const rows = await asGlobal(async () =>
      (await owner.query(`select 1 from sessions where token_hash = $1`, [result.token])).rowCount,
    );
    expect(rows).toBe(0);
  });

  it("carries the active tenant through to the resolved session", async () => {
    const result = await login("auth-manager@agency.test", PASSWORD);
    if (!result) throw new Error("login failed");

    await setActiveTenant(result.user.sessionId, TENANT_X);
    expect((await resolveSession(result.token))?.activeTenantId).toBe(TENANT_X);
  });

  it("stops resolving once expired", async () => {
    const result = await login("auth-manager@agency.test", PASSWORD);
    if (!result) throw new Error("login failed");

    await asGlobal(async () => {
      await owner.query(`update sessions set expires_at = now() - interval '1 minute' where id = $1`, [
        result.user.sessionId,
      ]);
    });
    expect(await resolveSession(result.token)).toBeNull();
  });
});

describe("tenant grants (PRD 8.2)", () => {
  const manager = {
    id: MANAGER,
    email: "auth-manager@agency.test",
    name: "Auth Manager",
    role: "campaign_manager" as const,
    sessionId: "00000000-0000-4000-8000-00000000ffff",
    activeTenantId: null,
  };

  const admin = { ...manager, id: ADMIN, role: "agency_admin" as const };

  it("lists only assigned tenants for scoped staff", async () => {
    const tenants = await listAccessibleTenants(manager);
    const ids = tenants.map((t) => t.id);
    expect(ids).toContain(TENANT_X);
    expect(ids).not.toContain(TENANT_Y);
  });

  it("lists every tenant for the Agency Admin", async () => {
    const ids = (await listAccessibleTenants(admin)).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([TENANT_X, TENANT_Y]));
  });

  it("grants an assigned tenant", async () => {
    expect(await resolveGrant(manager, TENANT_X)).toMatchObject({ via: "assignment" });
  });

  it("refuses an unassigned tenant", async () => {
    // Being agency staff is not itself authorization for a given client.
    expect(await resolveGrant(manager, TENANT_Y)).toBeNull();
    await expect(requireGrant(manager, TENANT_Y)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("makes an unassigned tenant indistinguishable from a nonexistent one (PRD 23.3)", async () => {
    const missing = "00000000-0000-4000-8000-00000000dead";
    const unassigned = await requireGrant(manager, TENANT_Y).catch((e: Error) => e.message);
    const nonexistent = await requireGrant(manager, missing).catch((e: Error) => e.message);
    expect(unassigned).toBe(nonexistent);
  });

  it("honours a live elevation, and stops honouring it once expired", async () => {
    await asGlobal(async () => {
      await owner.query(
        `insert into access_elevations (user_id, tenant_id, reason, expires_at)
         values ($1, $2, 'incident triage', now() + interval '1 hour')`,
        [MANAGER, TENANT_Y],
      );
    });
    expect(await resolveGrant(manager, TENANT_Y)).toMatchObject({ via: "elevation" });

    await asGlobal(async () => {
      await owner.query(`update access_elevations set expires_at = now() - interval '1 minute'
                          where user_id = $1 and tenant_id = $2`, [MANAGER, TENANT_Y]);
    });
    expect(await resolveGrant(manager, TENANT_Y)).toBeNull();
  });

  it("ignores a revoked elevation", async () => {
    await asGlobal(async () => {
      await owner.query(
        `insert into access_elevations (user_id, tenant_id, reason, expires_at, revoked_at)
         values ($1, $2, 'revoked grant', now() + interval '1 hour', now())`,
        [MANAGER, TENANT_Y],
      );
    });
    expect(await resolveGrant(manager, TENANT_Y)).toBeNull();
  });

  it("logs every denied attempt (PRD 17.1)", async () => {
    await requireGrant(manager, "00000000-0000-4000-8000-00000000beef").catch(() => undefined);

    const rows = await asGlobal(async () =>
      (
        await owner.query(
          `select 1 from audit_events
            where action = 'tenant.access_denied' and actor_id = $1`,
          [MANAGER],
        )
      ).rowCount,
    );
    expect(rows).toBeGreaterThan(0);
  });
});

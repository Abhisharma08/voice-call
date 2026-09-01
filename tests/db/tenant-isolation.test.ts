import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withActorScope, withScope, withoutScope } from "@/db/client";
import { encryptPii } from "@/lib/crypto/pii";

/**
 * PRD 19 requires 100% authorization test coverage on tenant boundaries, and
 * PRD 23.3 lists "Cross-tenant URL manipulation -> 403/404; no data
 * disclosure" as an acceptance scenario.
 *
 * These tests go one level below the HTTP layer: they connect as the runtime
 * role and try to read across tenants directly in SQL. If RLS is doing its
 * job, the rows are simply not there - no application filter involved.
 */

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER_A = "cccccccc-0000-4000-8000-000000000003";

let owner: Client;

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  await owner.query("begin");
  await owner.query(`select set_config('app.global_scope', 'on', true)`);

  await owner.query(
    `insert into tenants (id, name, slug) values
       ($1, 'Isolation Test A', 'isolation-test-a'),
       ($2, 'Isolation Test B', 'isolation-test-b')
     on conflict (id) do nothing`,
    [TENANT_A, TENANT_B],
  );

  await owner.query(
    `insert into users (id, email, name, role) values ($1, 'iso-a@agency.test', 'Iso A', 'campaign_manager')
     on conflict (id) do nothing`,
    [USER_A],
  );

  await owner.query(
    `insert into user_tenant_assignments (user_id, tenant_id, role) values ($1, $2, 'campaign_manager')
     on conflict do nothing`,
    [USER_A, TENANT_A],
  );

  await owner.query(
    `insert into leads (tenant_id, source, name_enc, phone_bidx, phone_last4, status) values
       ($1, 'test', $3, 'bidx-a', '1111', 'new'),
       ($2, 'test', $4, 'bidx-b', '2222', 'new')`,
    [TENANT_A, TENANT_B, encryptPii("Lead In A"), encryptPii("Lead In B")],
  );

  await owner.query("commit");
});

afterAll(async () => {
  await owner.query("begin");
  await owner.query(`select set_config('app.global_scope', 'on', true)`);
  await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT_A, TENANT_B]]);
  await owner.query(`delete from users where id = $1`, [USER_A]);
  await owner.query("commit");
  await owner.end();
  await closePools();
});

const scopeA = { tenantId: TENANT_A, globalScope: false, actorId: USER_A, actorType: "user" as const };
const scopeB = { tenantId: TENANT_B, globalScope: false, actorId: USER_A, actorType: "user" as const };

describe("row-level security (PRD 8.2, FR-005)", () => {
  it("shows only the scoped tenant's leads", async () => {
    const rows = await withScope(scopeA, async (tx) => (await tx.query(`select phone_last4 from leads`)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].phone_last4).toBe("1111");
  });

  it("returns nothing for another tenant's row, even when its id is known", async () => {
    // The application-layer equivalent of pasting another client's UUID into a URL.
    const rows = await withScope(scopeA, async (tx) =>
      (await tx.query(`select id from leads where tenant_id = $1`, [TENANT_B])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to write a row into another tenant", async () => {
    await expect(
      withScope(scopeA, async (tx) => {
        await tx.query(
          `insert into leads (tenant_id, source, phone_bidx) values ($1, 'smuggled', 'bidx-x')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to move an existing row across tenants", async () => {
    await expect(
      withScope(scopeA, async (tx) => {
        await tx.query(`update leads set tenant_id = $1`, [TENANT_B]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot delete another tenant's rows", async () => {
    const deleted = await withScope(scopeA, async (tx) => {
      const r = await tx.query(`delete from leads where tenant_id = $1`, [TENANT_B]);
      return r.rowCount;
    });
    expect(deleted).toBe(0);

    const stillThere = await withScope(scopeB, async (tx) =>
      (await tx.query(`select 1 from leads`)).rowCount,
    );
    expect(stillThere).toBe(1);
  });

  it("isolates every tenant-scoped table, not just leads", async () => {
    const tables = [
      "campaigns",
      "consents",
      "dnc_entries",
      "call_attempts",
      "call_transcripts",
      "call_analyses",
      "callbacks",
      "routing_events",
      "sync_outbox",
      "integrations",
      "secrets",
      "audit_events",
    ];

    for (const table of tables) {
      const enabled = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`,
        [table],
      );
      expect(enabled.rows[0]?.relrowsecurity, `${table} has RLS enabled`).toBe(true);
      // FORCE matters: without it the owner connection silently bypasses the policy.
      expect(enabled.rows[0]?.relforcerowsecurity, `${table} forces RLS`).toBe(true);

      const policies = await owner.query(
        `select 1 from pg_policies where tablename = $1`,
        [table],
      );
      expect(policies.rowCount, `${table} has a policy`).toBeGreaterThan(0);
    }
  });

  it("sees nothing at all when no scope was established", async () => {
    // Fails closed: app.tenant_visible() returns false with no tenant set.
    const rows = await withoutScope(async (tx) => (await tx.query(`select 1 from leads`)).rows);
    expect(rows).toHaveLength(0);
  });

  it("does not leak scope between transactions on a pooled connection", async () => {
    await withScope(scopeB, async (tx) => {
      await tx.query(`select 1 from leads`);
    });
    // set_config(..., true) is transaction-local, so the next borrower of this
    // connection starts with no tenant scope.
    const rows = await withoutScope(async (tx) => (await tx.query(`select 1 from leads`)).rows);
    expect(rows).toHaveLength(0);
  });

  it("refuses to open a transaction with neither tenant nor global scope", async () => {
    await expect(
      withScope(
        { tenantId: null, globalScope: false, actorId: USER_A, actorType: "user" },
        async () => undefined,
      ),
    ).rejects.toThrow(/unscoped transaction/i);
  });

  it("rejects a non-UUID tenant id before it reaches SQL", async () => {
    await expect(
      withScope(
        { tenantId: "' or true --", globalScope: false, actorId: null, actorType: "user" },
        async () => undefined,
      ),
    ).rejects.toThrow(/must be a UUID/);
  });
});

describe("assignments and elevations (PRD 8.2)", () => {
  it("lets a user read their own assignments without a tenant scope", async () => {
    const rows = await withActorScope(USER_A, async (tx) =>
      (await tx.query(`select tenant_id from user_tenant_assignments where user_id = $1`, [USER_A])).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it("does not expose other users' assignments", async () => {
    const rows = await withActorScope(USER_A, async (tx) =>
      (await tx.query(`select 1 from user_tenant_assignments where user_id <> $1`, [USER_A])).rows,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("audit trail is append-only (PRD 17.1)", () => {
  it("allows inserts", async () => {
    await withScope(scopeA, async (tx) => {
      await tx.query(
        `insert into audit_events (tenant_id, actor_type, action) values ($1, 'user', 'test.event')`,
        [TENANT_A],
      );
    });
    const rows = await withScope(scopeA, async (tx) =>
      (await tx.query(`select 1 from audit_events where action = 'test.event'`)).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it("denies updates and deletes to the runtime role", async () => {
    await expect(
      withScope(scopeA, async (tx) => {
        await tx.query(`update audit_events set action = 'tampered' where action = 'test.event'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withScope(scopeA, async (tx) => {
        await tx.query(`delete from audit_events where action = 'test.event'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

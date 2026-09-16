import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import { MAX_SYNC_ATTEMPTS, claimDueSyncs, enqueueSync, markSyncFailed, replaySync } from "@/lib/integrations/outbox";

/**
 * Dead-lettering and manual replay (PRD 18.3).
 *
 * `replaySync` shipped in Phase 1 with nothing able to call it, so its
 * behaviour had never been pinned down. Now that an operator can reach it from
 * `/integrations`, the properties the UI depends on need to hold: that a
 * replayed row becomes claimable again, that replaying something which is not
 * dead-lettered is refused rather than silently duplicating work, and that a
 * replay cannot reach across tenants.
 */

const TENANT = "b1b1b1b1-0000-4000-8000-000000000001";
const OTHER = "b2b2b2b2-0000-4000-8000-000000000002";

let owner: Client;

const scope = (tenantId: string): TenantScope => ({
  tenantId,
  globalScope: false,
  actorId: null,
  actorType: "service",
});

beforeEach(async () => {
  if (!owner) {
    owner = new Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
  }

  await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT, OTHER]]);
  await owner.query(
    `insert into tenants (id, name, slug) values ($1,'Replay Co','replay-co'), ($2,'Other Co','other-co')`,
    [TENANT, OTHER],
  );
});

afterAll(async () => {
  if (owner) {
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT, OTHER]]);
    await owner.end();
  }
  await closePools();
});

async function seedDeadLetter(tenantId: string, dedupeKey: string): Promise<string> {
  return withScope(scope(tenantId), async (tx) => {
    await enqueueSync(tx, {
      tenantId,
      target: "hubspot",
      dedupeKey,
      payload: { call_id: "11111111-2222-4333-8444-555555555555" },
    });

    const r = await tx.query<{ id: string }>(
      `select id from sync_outbox where tenant_id = $1 and dedupe_key = $2`,
      [tenantId, dedupeKey],
    );
    const id = r.rows[0]!.id;

    await markSyncFailed(tx, {
      id,
      tenantId,
      attempts: MAX_SYNC_ATTEMPTS,
      error: "HubSpot auth failure: token expired",
      retryable: false,
    });

    return id;
  }, "service");
}

describe("dead-lettering", () => {
  it("takes a non-retryable failure straight to dead_letter", async () => {
    const id = await seedDeadLetter(TENANT, "dl-1");

    const r = await owner.query<{ status: string }>(`select status from sync_outbox where id = $1`, [
      id,
    ]);
    expect(r.rows[0]!.status).toBe("dead_letter");
  });

  /**
   * The row must not be picked up again on its own. If it were, "dead letter"
   * would mean nothing and the retry ladder would run forever.
   */
  it("is not claimable by the drain", async () => {
    await seedDeadLetter(TENANT, "dl-2");

    const claimed = await withScope(scope(TENANT), (tx) => claimDueSyncs(tx, 50), "service");
    expect(claimed).toHaveLength(0);
  });

  it("records the error that caused it, for the operator to read", async () => {
    const id = await seedDeadLetter(TENANT, "dl-3");
    const r = await owner.query<{ last_error: string }>(
      `select last_error from sync_outbox where id = $1`,
      [id],
    );
    expect(r.rows[0]!.last_error).toMatch(/token expired/);
  });
});

describe("replaySync", () => {
  it("returns the row to the queue and resets its attempts", async () => {
    const id = await seedDeadLetter(TENANT, "r-1");

    const replayed = await withScope(scope(TENANT), (tx) => replaySync(tx, id), "service");
    expect(replayed).toBe(true);

    const r = await owner.query<{ status: string; attempts: number; last_error: string | null }>(
      `select status, attempts, last_error from sync_outbox where id = $1`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });

  it("makes the row claimable again", async () => {
    const id = await seedDeadLetter(TENANT, "r-2");
    await withScope(scope(TENANT), (tx) => replaySync(tx, id), "service");

    const claimed = await withScope(scope(TENANT), (tx) => claimDueSyncs(tx, 50), "service");
    expect(claimed.map((c) => c.id)).toContain(id);
  });

  /**
   * The UI turns this into "that delivery is no longer dead-lettered". Without
   * it, double-clicking Replay would re-queue a row already in flight.
   */
  it("refuses a row that is not dead-lettered", async () => {
    const id = await seedDeadLetter(TENANT, "r-3");

    expect(await withScope(scope(TENANT), (tx) => replaySync(tx, id), "service")).toBe(true);
    expect(await withScope(scope(TENANT), (tx) => replaySync(tx, id), "service")).toBe(false);
  });

  it("reports false for an id that does not exist", async () => {
    const replayed = await withScope(
      scope(TENANT),
      (tx) => replaySync(tx, "99999999-9999-4999-8999-999999999999"),
      "service",
    );
    expect(replayed).toBe(false);
  });

  /**
   * RLS, not a WHERE clause, is what stops this. Another tenant's row is
   * indistinguishable from one that does not exist (PRD 23.3), which is the
   * same answer the previous test gets.
   */
  it("cannot replay another tenant's dead letter", async () => {
    const id = await seedDeadLetter(OTHER, "r-4");

    const replayed = await withScope(scope(TENANT), (tx) => replaySync(tx, id), "service");
    expect(replayed).toBe(false);

    const r = await owner.query<{ status: string }>(`select status from sync_outbox where id = $1`, [
      id,
    ]);
    expect(r.rows[0]!.status).toBe("dead_letter");
  });
});

describe("bulk replay by target", () => {
  /**
   * Mirrors the statement behind the "Replay all" button. Scoped to one
   * destination because that is the shape dead letters actually arrive in: an
   * expired token strands every CRM sync for a client and nothing else.
   */
  it("replays only the named target, and only this tenant's rows", async () => {
    await seedDeadLetter(TENANT, "b-1");
    await seedDeadLetter(OTHER, "b-2");

    await withScope(scope(TENANT), async (tx) => {
      await enqueueSync(tx, {
        tenantId: TENANT,
        target: "notification",
        dedupeKey: "b-3",
        payload: { call_id: "11111111-2222-4333-8444-555555555555" },
      });
      const r = await tx.query<{ id: string }>(
        `select id from sync_outbox where dedupe_key = 'b-3'`,
      );
      await markSyncFailed(tx, {
        id: r.rows[0]!.id,
        tenantId: TENANT,
        attempts: MAX_SYNC_ATTEMPTS,
        error: "Slack webhook is no longer valid",
        retryable: false,
      });
    }, "service");

    const replayed = await withScope(scope(TENANT), async (tx) => {
      const r = await tx.query<{ id: string }>(
        `update sync_outbox
            set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
          where target = $1 and status = 'dead_letter'
          returning id`,
        ["hubspot"],
      );
      return r.rows.length;
    }, "service");

    expect(replayed).toBe(1);

    const rows = await owner.query<{ dedupe_key: string; status: string }>(
      `select dedupe_key, status from sync_outbox
        where dedupe_key = any($1::text[]) order by dedupe_key`,
      [["b-1", "b-2", "b-3"]],
    );

    expect(rows.rows).toEqual([
      { dedupe_key: "b-1", status: "pending" }, // this tenant, this target
      { dedupe_key: "b-2", status: "dead_letter" }, // other tenant, untouched
      { dedupe_key: "b-3", status: "dead_letter" }, // this tenant, other target
    ]);
  });
});

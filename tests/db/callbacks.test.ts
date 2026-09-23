import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import { ingestLead } from "@/lib/leads/intake";
import { runCallingTick } from "@/lib/calling/worker";
import { resetMockProvider } from "@/lib/providers/voice/mock";
import {
  listOutstanding,
  listResolved,
  markMissedCallbacks,
  rescheduleCallback,
  resolveCallback,
} from "@/lib/calling/callbacks";

/**
 * The callback worklist against a real database.
 *
 * What is actually being tested here is that the row follows reality: a
 * callback is only "completed" because a call went out, only "missed" because
 * one did not, and a reschedule moves the queue rather than just the label.
 * Every one of those is a claim the operator acts on.
 */

const TENANT = "e5e5e5e5-0000-4000-8000-000000000005";
const CAMPAIGN = "f6f6f6f6-0000-4000-8000-000000000006";
const OPERATOR = "a7a7a7a7-0000-4000-8000-000000000007";

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: null,
  actorType: "service",
};

const globalScope: TenantScope = {
  tenantId: null,
  globalScope: true,
  actorId: null,
  actorType: "service",
};

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

  await asGlobal(async () => {
    await owner.query(
      `insert into tenants (id, name, slug, timezone)
       values ($1, 'Callback Test Co', 'callback-test-co', 'Asia/Kolkata')
       on conflict (id) do nothing`,
      [TENANT],
    );

    await owner.query(
      `insert into users (id, email, name, role)
       values ($1, 'callback-ops@agency.test', 'Callback Ops', 'operations_manager')
       on conflict (id) do nothing`,
      [OPERATOR],
    );

    await owner.query(
      `insert into campaigns
         (id, tenant_id, name, business_context, script, timezone, active, voice_provider,
          calling_config, routing_config, scoring_rubric)
       values ($1, $2, 'Callback Campaign', 'Test context', 'Hello', 'Asia/Kolkata', true, 'mock',
               $3::jsonb, '{"hot_threshold":75,"interested_threshold":50}'::jsonb, '{}'::jsonb)
       on conflict (id) do nothing`,
      [
        CAMPAIGN,
        TENANT,
        JSON.stringify({
          window_start: "00:00",
          window_end: "23:59",
          max_attempts: 3,
          retry_minutes: [15, 120, 1440],
          country: "IN",
        }),
      ],
    );

    await owner.query(
      `insert into qualification_rules (tenant_id, campaign_id, field_name, question, required, position)
       values ($1, $2, 'still_interested', 'Still looking?', true, 1)
       on conflict (campaign_id, field_name) do nothing`,
      [TENANT, CAMPAIGN],
    );

    // The assignment is what makes the resolver's own name readable back from
    // inside this tenant: migration 0002 hides staff who are not assigned to
    // the scoped tenant, so a resolution by an unassigned account would show
    // as anonymous on the page even though the audit log names them. Anyone
    // who can resolve a callback here holds that grant by definition -
    // `withTenant` refuses the write otherwise.
    await owner.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role)
       values ($1, $2, 'operations_manager')
       on conflict (user_id, tenant_id) do nothing`,
      [OPERATOR, TENANT],
    );
  });
});

beforeEach(async () => {
  resetMockProvider();
  await asGlobal(async () => {
    await owner.query(`delete from callbacks where tenant_id = $1`, [TENANT]);
    await owner.query(`delete from leads where tenant_id = $1`, [TENANT]);
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from tenants where id = $1`, [TENANT]);
    await owner.query(`delete from users where id = $1`, [OPERATOR]);
  });
  await owner.end();
  await closePools();
});

/** A queued lead, and a callback on it at `scheduledFor`. */
async function seed(
  phone: string,
  scheduledFor: Date,
): Promise<{ leadId: string; callbackId: string }> {
  const leadId = await withScope(scope, async (tx) => {
    const outcome = await ingestLead(tx, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      source: "test",
      recordId: `cb-${phone.slice(-6)}`,
      contact: { name: "Callback Lead", phone, email: null },
      consent: {
        basis: "opt_in_form",
        source: "landing_page_form",
        evidenceRef: "form-1",
        capturedAt: null,
      },
      correlationId: null,
    });
    if (!outcome.leadId) throw new Error(`Lead not created: ${outcome.status}`);
    return outcome.leadId;
  });

  const callbackId = await withScope(scope, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `insert into callbacks (tenant_id, lead_id, scheduled_for) values ($1, $2, $3) returning id`,
      [TENANT, leadId, scheduledFor],
    );
    return r.rows[0]!.id;
  });

  return { leadId, callbackId };
}

async function statusOf(callbackId: string): Promise<{
  status: string;
  resolved_at: Date | null;
  fulfilled_call_id: string | null;
  resolved_by: string | null;
}> {
  return withScope(scope, async (tx) => {
    const r = await tx.query<{
      status: string;
      resolved_at: Date | null;
      fulfilled_call_id: string | null;
      resolved_by: string | null;
    }>(
      `select status, resolved_at, fulfilled_call_id, resolved_by from callbacks where id = $1`,
      [callbackId],
    );
    return r.rows[0]!;
  });
}

async function dial(): Promise<void> {
  await withScope(scope, (tx) =>
    runCallingTick(tx, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      workerId: "callback-test",
      webhookBaseUrl: "http://localhost:3000",
    }),
  );
}

describe("callback worklist", () => {
  it("completes a callback when the call it promised goes out", async () => {
    const { callbackId } = await seed("+919812300001", new Date(Date.now() - 60_000));

    await dial();

    const row = await statusOf(callbackId);
    expect(row.status).toBe("completed");
    expect(row.fulfilled_call_id).not.toBeNull();
    // The platform kept it, not a person.
    expect(row.resolved_by).toBeNull();
  });

  it("leaves a callback alone when the call goes out before it is due", async () => {
    const { callbackId } = await seed("+919812300002", new Date(Date.now() + 6 * 3600_000));

    await dial();

    expect((await statusOf(callbackId)).status).toBe("scheduled");
  });

  it("marks a callback missed only once the grace period has passed with no call", async () => {
    const { callbackId } = await seed("+919812300003", new Date(Date.now() - 30 * 60_000));

    // Half an hour late is late, not missed.
    const early = await withScope(globalScope, (tx) => markMissedCallbacks(tx, { tenantId: TENANT }), "service");
    expect(early.find((c) => c.id === callbackId)).toBeUndefined();
    expect((await statusOf(callbackId)).status).toBe("scheduled");

    const swept = await withScope(
      globalScope,
      (tx) => markMissedCallbacks(tx, { graceMinutes: 10, tenantId: TENANT }),
      "service",
    );
    expect(swept.map((c) => c.id)).toContain(callbackId);
    expect((await statusOf(callbackId)).status).toBe("missed");
  });

  it("does not mark a callback missed when the call actually went out", async () => {
    const { callbackId } = await seed("+919812300004", new Date(Date.now() - 60 * 60_000));

    await dial();
    await withScope(globalScope, (tx) => markMissedCallbacks(tx, { graceMinutes: 1, tenantId: TENANT }), "service");

    expect((await statusOf(callbackId)).status).toBe("completed");
  });

  it("revives a missed callback when the late call finally happens", async () => {
    const { callbackId } = await seed("+919812300005", new Date(Date.now() - 60 * 60_000));

    await withScope(globalScope, (tx) => markMissedCallbacks(tx, { graceMinutes: 1, tenantId: TENANT }), "service");
    expect((await statusOf(callbackId)).status).toBe("missed");

    await dial();
    expect((await statusOf(callbackId)).status).toBe("completed");
  });

  it("reschedules the callback and puts the lead back on the queue", async () => {
    const { leadId, callbackId } = await seed("+919812300006", new Date(Date.now() - 60_000));
    const when = new Date(Date.now() + 4 * 3600_000);

    const result = await withScope(scope, (tx) =>
      rescheduleCallback(tx, {
        tenantId: TENANT,
        callbackId,
        scheduledFor: when,
        userId: OPERATOR,
        userEmail: "callback-ops@agency.test",
      }),
    );

    expect(result).toEqual({ ok: true, leadRequeued: true, leadStatus: "queued" });

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; next_call_at: Date }>(
          `select status, next_call_at from leads where id = $1`,
          [leadId],
        )
      ).rows[0]!,
    );

    expect(lead.status).toBe("queued");
    expect(lead.next_call_at.toISOString()).toBe(when.toISOString());

    // The call is genuinely deferred, not just relabelled.
    await dial();
    expect((await statusOf(callbackId)).status).toBe("scheduled");
  });

  it("refuses to resurrect a suppressed lead when its callback is moved", async () => {
    const { leadId, callbackId } = await seed("+919812300007", new Date(Date.now() - 60_000));

    await withScope(scope, (tx) =>
      tx.query(
        `update leads set status = 'suppressed', status_reason = 'manual_dnc' where id = $1`,
        [leadId],
      ),
    );

    const result = await withScope(scope, (tx) =>
      rescheduleCallback(tx, {
        tenantId: TENANT,
        callbackId,
        scheduledFor: new Date(Date.now() + 3600_000),
        userId: OPERATOR,
        userEmail: "callback-ops@agency.test",
      }),
    );

    expect(result).toEqual({ ok: true, leadRequeued: false, leadStatus: "suppressed" });

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string }>(`select status from leads where id = $1`, [leadId])
      ).rows[0]!,
    );
    expect(lead.status).toBe("suppressed");
  });

  it("closes a callback by hand once, and records who did it", async () => {
    const { callbackId } = await seed("+919812300008", new Date(Date.now() + 3600_000));

    const first = await withScope(scope, (tx) =>
      resolveCallback(tx, {
        tenantId: TENANT,
        callbackId,
        resolution: "completed",
        userId: OPERATOR,
        userEmail: "callback-ops@agency.test",
        note: "Called from my mobile",
      }),
    );
    expect(first).toBe(true);

    const row = await statusOf(callbackId);
    expect(row.status).toBe("completed");
    expect(row.resolved_by).toBe(OPERATOR);

    // A second press of the button is a no-op, not a rewrite.
    const second = await withScope(scope, (tx) =>
      resolveCallback(tx, {
        tenantId: TENANT,
        callbackId,
        resolution: "canceled",
        userId: OPERATOR,
        userEmail: "callback-ops@agency.test",
        note: null,
      }),
    );
    expect(second).toBe(false);
    expect((await statusOf(callbackId)).status).toBe("completed");

    const audit = await withScope(scope, async (tx) =>
      (
        await tx.query<{ action: string }>(
          `select action from audit_events where entity_id = $1 order by created_at`,
          [callbackId],
        )
      ).rows.map((r) => r.action),
    );
    expect(audit).toContain("callback.resolved");
  });

  it("separates what is outstanding from what is closed", async () => {
    const open = await seed("+919812300009", new Date(Date.now() + 3600_000));
    const closed = await seed("+919812300010", new Date(Date.now() + 7200_000));

    await withScope(scope, (tx) =>
      resolveCallback(tx, {
        tenantId: TENANT,
        callbackId: closed.callbackId,
        resolution: "canceled",
        userId: OPERATOR,
        userEmail: "callback-ops@agency.test",
        note: null,
      }),
    );

    const { outstanding, resolved } = await withScope(scope, async (tx) => ({
      outstanding: await listOutstanding(tx),
      resolved: await listResolved(tx),
    }));

    expect(outstanding.map((c) => c.id)).toEqual([open.callbackId]);
    expect(resolved.map((c) => c.id)).toEqual([closed.callbackId]);
    expect(resolved[0]?.resolvedByEmail).toBe("callback-ops@agency.test");
  });
});

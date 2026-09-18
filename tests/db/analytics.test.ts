import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import { loadMetrics } from "@/lib/analytics/metrics";

/**
 * The analytics page's metrics (PRD 21).
 *
 * The query behind them was rewritten from seventeen independent subqueries
 * into one pass per table using FILTER aggregates, which is exactly the kind
 * of change that silently shifts a number by one. These tests pin the
 * arithmetic against a fixture whose every count is known by construction, and
 * check that the date window actually excludes what it says it does.
 */

const TENANT = "a1a1a1a1-0000-4000-8000-000000000001";
const OTHER_TENANT = "a2a2a2a2-0000-4000-8000-000000000002";
const CAMPAIGN = "a3a3a3a3-0000-4000-8000-000000000003";
const ADMIN = "a4a4a4a4-0000-4000-8000-000000000004";

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: ADMIN,
  actorType: "user",
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
    for (const [id, slug] of [
      [TENANT, "analytics-test-co"],
      [OTHER_TENANT, "analytics-other-co"],
    ] as const) {
      await owner.query(
        `insert into tenants (id, name, slug) values ($1, $2, $2)
         on conflict (id) do nothing`,
        [id, slug],
      );
    }
    await owner.query(
      `insert into users (id, email, name, role)
       values ($1, 'analytics-admin@agency.test', 'Anl', 'agency_admin')
       on conflict (id) do nothing`,
      [ADMIN],
    );
    await owner.query(
      `insert into campaigns (id, tenant_id, name, timezone, calling_config, routing_config, scoring_rubric)
       values ($1, $2, 'Analytics Campaign', 'Asia/Kolkata', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
       on conflict (id) do nothing`,
      [CAMPAIGN, TENANT],
    );
  });
});

beforeEach(async () => {
  await asGlobal(async () => {
    for (const t of [TENANT, OTHER_TENANT]) {
      await owner.query(`delete from call_analyses where tenant_id = $1`, [t]);
      await owner.query(`delete from call_attempts where tenant_id = $1`, [t]);
      await owner.query(`delete from callbacks where tenant_id = $1`, [t]);
      await owner.query(`delete from sync_outbox where tenant_id = $1`, [t]);
      await owner.query(`delete from leads where tenant_id = $1`, [t]);
    }
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    for (const t of [TENANT, OTHER_TENANT]) {
      await owner.query(`delete from call_analyses where tenant_id = $1`, [t]);
      await owner.query(`delete from call_attempts where tenant_id = $1`, [t]);
      await owner.query(`delete from leads where tenant_id = $1`, [t]);
      await owner.query(`delete from campaigns where tenant_id = $1`, [t]);
      await owner.query(`delete from tenants where id = $1`, [t]);
    }
    await owner.query(`delete from users where id = $1`, [ADMIN]);
  });
  await owner.end();
  await closePools();
});

/**
 * One lead, one attempt and (optionally) one analysis, all aged the same.
 * `ageDays` back-dates created_at so the window tests have something to
 * exclude.
 */
async function fixture(args: {
  tenantId: string;
  status: string;
  durationSec?: number | null;
  queueLatencySec?: number | null;
  intent?: string;
  reviewStatus?: string;
  score?: number;
  ageDays?: number;
}): Promise<void> {
  const age = `${args.ageDays ?? 0} days`;

  await asGlobal(async () => {
    const lead = await owner.query<{ id: string }>(
      `insert into leads (tenant_id, campaign_id, source, status, queued_at, created_at)
       values ($1, $2, 'test', 'queued', now() - $3::interval, now() - $3::interval)
       returning id`,
      [args.tenantId, args.tenantId === TENANT ? CAMPAIGN : null, age],
    );

    const call = await owner.query<{ id: string }>(
      `insert into call_attempts
         (tenant_id, lead_id, attempt_no, status, provider, duration_sec,
          queue_latency_sec, started_at, created_at)
       values ($1, $2, 1, $3::call_status, 'mock', $4, $5, now() - $6::interval, now() - $6::interval)
       returning id`,
      [
        args.tenantId,
        lead.rows[0]!.id,
        args.status,
        args.durationSec ?? null,
        args.queueLatencySec ?? null,
        age,
      ],
    );

    if (args.intent) {
      await owner.query(
        `insert into call_analyses
           (tenant_id, call_id, intent, score, structured_payload, review_status, model,
            input_tokens, output_tokens, created_at)
         values ($1, $2, $3::call_intent, $4, '{}'::jsonb, $5::review_status, 'test',
                 100, 20, now() - $6::interval)`,
        [
          args.tenantId,
          call.rows[0]!.id,
          args.intent,
          args.score ?? null,
          args.reviewStatus ?? "auto_approved",
          age,
        ],
      );
    }
  });
}

const read = (window: string | null) =>
  withScope(scope, (tx) => loadMetrics(tx, TENANT, window));

describe("analytics metrics", () => {
  it("counts each subset of the same rows in one pass", async () => {
    await fixture({ tenantId: TENANT, status: "completed", durationSec: 100, queueLatencySec: 10,
                    intent: "hot", reviewStatus: "auto_approved", score: 80 });
    await fixture({ tenantId: TENANT, status: "completed", durationSec: 200, queueLatencySec: 20,
                    intent: "interested", reviewStatus: "pending_review", score: 60 });
    await fixture({ tenantId: TENANT, status: "completed", durationSec: 300, queueLatencySec: 30,
                    intent: "not_interested", reviewStatus: "corrected", score: 10 });
    await fixture({ tenantId: TENANT, status: "no_answer" });

    const m = await read("30 days");

    expect(Number(m.leads)).toBe(4);
    expect(Number(m.attempts)).toBe(4);
    expect(Number(m.connected)).toBe(3);
    expect(Number(m.analyses)).toBe(3);
    expect(Number(m.hot)).toBe(1);
    expect(Number(m.pending_review)).toBe(1);
    // 'corrected' is counted by both `reviewed` and `corrected`, which is what
    // makes the correction rate a share of reviewed rather than of all.
    expect(Number(m.reviewed)).toBe(1);
    expect(Number(m.corrected)).toBe(1);
    expect(Number(m.avg_duration)).toBe(200);
    expect(Number(m.avg_score)).toBe(50);
    expect(Number(m.input_tokens)).toBe(300);
    expect(Number(m.output_tokens)).toBe(60);
  });

  it("averages duration over connected calls only", async () => {
    // An unconnected attempt has no duration; including it as a zero would
    // drag the average down and make a healthy campaign look broken.
    await fixture({ tenantId: TENANT, status: "completed", durationSec: 120, intent: "hot" });
    await fixture({ tenantId: TENANT, status: "no_answer", durationSec: null });

    expect(Number((await read("30 days")).avg_duration)).toBe(120);
  });

  it("reads the p95 latency from the stamped column, not a join", async () => {
    for (const sec of [1, 2, 3, 4, 100]) {
      await fixture({ tenantId: TENANT, status: "completed", queueLatencySec: sec, intent: "hot" });
    }

    const m = await read("30 days");
    // percentile_cont interpolates; with 100s as the outlier the p95 sits
    // close to it, and well above the median.
    expect(Number(m.p95_latency_sec)).toBeGreaterThan(4);
  });

  it("excludes rows outside the window, and includes them for all time", async () => {
    await fixture({ tenantId: TENANT, status: "completed", intent: "hot", ageDays: 0 });
    await fixture({ tenantId: TENANT, status: "completed", intent: "hot", ageDays: 45 });

    expect(Number((await read("30 days")).leads)).toBe(1);
    expect(Number((await read("90 days")).leads)).toBe(2);
    expect(Number((await read(null)).leads)).toBe(2);
  });

  it("counts nothing from another tenant", async () => {
    await fixture({ tenantId: TENANT, status: "completed", intent: "hot" });
    await fixture({ tenantId: OTHER_TENANT, status: "completed", intent: "hot" });
    await fixture({ tenantId: OTHER_TENANT, status: "completed", intent: "hot" });

    const m = await read(null);
    expect(Number(m.leads)).toBe(1);
    expect(Number(m.attempts)).toBe(1);
    expect(Number(m.analyses)).toBe(1);
  });

  it("returns zeroes rather than nulls for a client with no activity", async () => {
    const m = await read("30 days");

    expect(Number(m.leads)).toBe(0);
    expect(Number(m.attempts)).toBe(0);
    expect(Number(m.analyses)).toBe(0);
    expect(Number(m.input_tokens)).toBe(0);
    // Averages over an empty set are genuinely unknown, and the page renders
    // these as an em dash rather than as zero.
    expect(m.avg_duration).toBeNull();
    expect(m.p95_latency_sec).toBeNull();
  });
});

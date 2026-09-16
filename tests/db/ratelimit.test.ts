import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools } from "@/db/client";
import { RateLimits, consumeAll, consumeRateLimit } from "@/lib/ratelimit";

/**
 * The rate limiter, against the real function (migration 0011).
 *
 * The properties worth asserting here are the ones a unit test with a fake
 * cannot reach: that the counter is shared rather than per-process, that the
 * check and the increment are one atomic statement, and that the runtime roles
 * reach it only through the SECURITY DEFINER entry point.
 */

let owner: Client;

async function ownerClient(): Promise<Client> {
  if (!owner) {
    owner = new Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
  }
  return owner;
}

const rule = (limit: number, windowSeconds = 300) => ({
  name: "test",
  limit,
  windowSeconds,
});

/** A fresh subject per test, so windows from other tests cannot bleed in. */
function subject(): string {
  return `s-${Math.random().toString(36).slice(2)}`;
}

beforeEach(async () => {
  const db = await ownerClient();
  await db.query(`delete from rate_limit_counters where bucket_key like 'test:%'`);
});

afterAll(async () => {
  await closePools();
  if (owner) await owner.end();
});

describe("consumeRateLimit", () => {
  it("admits exactly the limit, then denies", async () => {
    const s = subject();

    for (let i = 0; i < 3; i++) {
      const v = await consumeRateLimit(rule(3), s);
      expect(v.allowed, `attempt ${i + 1}`).toBe(true);
      expect(v.remaining).toBe(2 - i);
    }

    const denied = await consumeRateLimit(rule(3), s);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("tells a denied caller when the window rolls over", async () => {
    const s = subject();
    await consumeRateLimit(rule(1, 300), s);

    const denied = await consumeRateLimit(rule(1, 300), s);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it("keeps separate subjects on separate budgets", async () => {
    const a = subject();
    const b = subject();

    await consumeRateLimit(rule(1), a);
    expect((await consumeRateLimit(rule(1), a)).allowed).toBe(false);
    expect((await consumeRateLimit(rule(1), b)).allowed).toBe(true);
  });

  it("keeps separate rules on separate budgets for the same subject", async () => {
    const s = subject();

    await consumeRateLimit({ name: "test", limit: 1, windowSeconds: 300 }, s);
    expect((await consumeRateLimit({ name: "test", limit: 1, windowSeconds: 300 }, s)).allowed).toBe(
      false,
    );
    // Same subject, different rule namespace: unaffected.
    expect(
      (await consumeRateLimit({ name: "test-other", limit: 1, windowSeconds: 300 }, s)).allowed,
    ).toBe(true);
  });

  /**
   * The denials must not inflate the counter. If they did, a sustained flood
   * would push the count so far past the limit that the bucket could never
   * drain within the window, turning a rate limit into an unbounded row.
   */
  it("does not count the requests it refused", async () => {
    const s = subject();
    for (let i = 0; i < 10; i++) await consumeRateLimit(rule(2), s);

    const db = await ownerClient();
    const r = await db.query<{ count: number }>(
      `select count from rate_limit_counters where bucket_key = $1`,
      [`test:${s}`],
    );
    expect(r.rows[0]?.count).toBe(2);
  });

  /**
   * The property an in-process limiter cannot have. Every call here opens its
   * own transaction, which on a serverless platform is the same shape as a
   * separate instance handling each request - and they still share one budget.
   */
  it("admits exactly the limit across concurrent callers", async () => {
    const s = subject();

    const verdicts = await Promise.all(
      Array.from({ length: 25 }, () => consumeRateLimit(rule(5), s)),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(verdicts.filter((v) => !v.allowed)).toHaveLength(20);
  });

  it("charges a multi-unit cost, and refuses one that would overshoot whole", async () => {
    const s = subject();

    expect((await consumeRateLimit(rule(10), s, 8)).allowed).toBe(true);
    // 8 + 8 would exceed 10, so it is refused entirely rather than partially.
    expect((await consumeRateLimit(rule(10), s, 8)).allowed).toBe(false);
    // ...but a cost that still fits is admitted, so one oversized request does
    // not wedge the bucket for the rest of the window.
    expect((await consumeRateLimit(rule(10), s, 2)).allowed).toBe(true);
  });
});

describe("consumeAll", () => {
  it("returns null when every rule admits", async () => {
    const s = subject();
    const denied = await consumeAll([
      { rule: rule(5), subject: s },
      { rule: { name: "test-b", limit: 5, windowSeconds: 300 }, subject: s },
    ]);
    expect(denied).toBeNull();
  });

  it("names the rule that denied", async () => {
    const s = subject();
    await consumeRateLimit(rule(1), s);

    const denied = await consumeAll([{ rule: rule(1), subject: s }]);
    expect(denied?.rule.name).toBe("test");
    expect(denied?.verdict.allowed).toBe(false);
  });

  /**
   * Evaluation stops at the first denial, so a request already blocked by the
   * broad per-address rule does not also spend the narrow per-account budget.
   * Without this, an attacker could lock a real user out of their own account
   * simply by flooding - turning the brute-force defence into the outage it
   * exists to prevent.
   */
  it("does not spend a later rule's budget once an earlier one denies", async () => {
    const flooded = subject();
    const account = subject();
    const second = { name: "test-account", limit: 2, windowSeconds: 300 };

    await consumeRateLimit(rule(1), flooded);

    for (let i = 0; i < 5; i++) {
      await consumeAll([
        { rule: rule(1), subject: flooded },
        { rule: second, subject: account },
      ]);
    }

    // The account budget was never touched, so the real user can still sign in.
    expect((await consumeRateLimit(second, account)).allowed).toBe(true);
  });
});

describe("the limiter's exposure", () => {
  /**
   * Same posture as the auth lookups in migration 0003: the table stays closed
   * to the runtime roles and exactly one narrow SECURITY DEFINER function is
   * exposed. A runtime role that could write the table directly could also
   * erase its own counter.
   */
  it("does not grant the runtime roles direct access to the counter table", async () => {
    const db = await ownerClient();
    const r = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_name = 'rate_limit_counters'
          and grantee in ('app_user', 'app_service')`,
    );
    expect(r.rows).toHaveLength(0);
  });

  it("lets both runtime roles execute the consume function", async () => {
    const db = await ownerClient();
    for (const role of ["app_user", "app_service"]) {
      const r = await db.query<{ has: boolean }>(
        `select has_function_privilege($1, 'app.rate_limit_consume(text,integer,integer,integer)', 'execute') as has`,
        [role],
      );
      expect(r.rows[0]?.has, role).toBe(true);
    }
  });

  it("rejects a non-positive limit rather than admitting everything", async () => {
    const db = await ownerClient();
    await expect(
      db.query(`select * from app.rate_limit_consume('test:bad', 0, 60)`),
    ).rejects.toThrow(/must be positive/);
  });
});

describe("the sweep's housekeeping", () => {
  it("clears windows that have rolled over and keeps live ones", async () => {
    const db = await ownerClient();
    const live = subject();

    await consumeRateLimit(rule(5), live);
    await db.query(
      `insert into rate_limit_counters (bucket_key, window_start, count)
       values ('test:stale', now() - interval '3 hours', 1)`,
    );

    const r = await db.query<{ rate_limit_gc: number }>(
      `select app.rate_limit_gc(interval '1 hour')`,
    );
    expect(r.rows[0]!.rate_limit_gc).toBeGreaterThanOrEqual(1);

    const remaining = await db.query(
      `select bucket_key from rate_limit_counters where bucket_key in ($1, 'test:stale')`,
      [`test:${live}`],
    );
    expect(remaining.rows.map((x) => (x as { bucket_key: string }).bucket_key)).toEqual([
      `test:${live}`,
    ]);
  });
});

describe("the production rules", () => {
  it("apply to the login path as configured", async () => {
    const ip = subject();

    for (let i = 0; i < RateLimits.loginPerIp.limit; i++) {
      expect((await consumeRateLimit(RateLimits.loginPerIp, ip)).allowed).toBe(true);
    }
    expect((await consumeRateLimit(RateLimits.loginPerIp, ip)).allowed).toBe(false);
  });
});

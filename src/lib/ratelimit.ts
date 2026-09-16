import { withoutScope } from "@/db/client";
import { logger } from "@/lib/observability/log";

/**
 * Rate limiting for the pre-authentication surface (migration 0011).
 *
 * The counter is a row in PostgreSQL, not a Map in the process. On a
 * serverless platform an in-process limiter is not a weaker limit, it is
 * *no* limit: every warm instance gets its own memory, so a ceiling of 10
 * becomes 10 x however many instances the platform decided to run - a number
 * the application neither chooses nor observes. It also resets on every cold
 * start, which is exactly when a flood is arriving.
 *
 * `app.rate_limit_consume()` does the check and the increment in one
 * statement, so two concurrent requests cannot both read 9 and both write 10.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over. 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Distinguishes one limiter from another within the key space. */
  name: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Consume `cost` from the bucket for `rule` + `subject`.
 *
 * **Fails open.** If the limiter itself cannot be reached, the request is
 * allowed and the failure is logged at error level. This is deliberate and it
 * is the less obvious choice, so: every endpoint this protects needs the same
 * database to do its actual work, so a limiter that cannot reach PostgreSQL is
 * a request that was going to fail regardless. Failing closed would convert a
 * database blip into a total outage of lead intake - dropping real leads that
 * HubSpot will not redeliver forever - to defend against an attacker who, in
 * that same window, cannot get a lead ingested either.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string,
  cost = 1,
): Promise<RateLimitVerdict> {
  const key = `${rule.name}:${subject}`;

  try {
    return await withoutScope(async (tx) => {
      const r = await tx.query<{
        allowed: boolean;
        remaining: number;
        retry_after_seconds: number;
      }>(`select * from app.rate_limit_consume($1, $2, $3, $4)`, [
        key,
        rule.limit,
        rule.windowSeconds,
        cost,
      ]);

      const row = r.rows[0];
      if (!row) return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };

      return {
        allowed: row.allowed,
        remaining: row.remaining,
        retryAfterSeconds: row.retry_after_seconds,
      };
    }, "service");
  } catch (err) {
    logger.error("rate limiter unavailable; allowing the request", {
      rule: rule.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/**
 * Evaluate several rules and return the first denial.
 *
 * Order matters and the caller controls it: rules are consumed in sequence and
 * evaluation *stops* at the first denial, so a request blocked by a cheap
 * broad rule does not also burn the narrow per-account budget. That keeps one
 * attacker's flood from locking out the account they are guessing at, which is
 * how a brute-force defence turns into a denial-of-service against the real
 * user.
 */
export async function consumeAll(
  checks: Array<{ rule: RateLimitRule; subject: string; cost?: number }>,
): Promise<{ verdict: RateLimitVerdict; rule: RateLimitRule } | null> {
  for (const check of checks) {
    const verdict = await consumeRateLimit(check.rule, check.subject, check.cost);
    if (!verdict.allowed) return { verdict, rule: check.rule };
  }
  return null;
}

/**
 * Response headers for a denial.
 *
 * Returned as a plain object rather than a `NextResponse` so this module stays
 * free of the framework and can be unit-tested without it. `Retry-After` is
 * the part that matters: HubSpot and the voice providers both back off on it,
 * so a limited caller retries when the window has actually rolled over instead
 * of immediately.
 */
export function retryAfterHeaders(verdict: RateLimitVerdict): Record<string, string> {
  return {
    "retry-after": String(Math.max(1, verdict.retryAfterSeconds)),
    "x-ratelimit-remaining": String(verdict.remaining),
  };
}

/**
 * The calling client's address, as the platform reports it.
 *
 * `x-forwarded-for` is attacker-controlled in general - anyone can send the
 * header - and is only trustworthy because the platform in front of the app
 * overwrites it. Vercel's own `x-vercel-forwarded-for` is preferred where
 * present because it is set by the proxy and not passed through from the
 * client, and the first entry of `x-forwarded-for` is the last resort.
 *
 * A request with no usable address is bucketed under a single shared key
 * rather than being waved through: unattributable traffic should share one
 * budget, not get an unlimited one each.
 *
 * **This is a deployment dependency, not a guarantee this code can make.**
 * Every address here is only as trustworthy as the proxy in front of the app.
 * Behind Vercel it is trustworthy, because the platform sets these headers and
 * replaces whatever the client sent. Exposed directly to the internet it is
 * not: an attacker rotating `x-forwarded-for` gets a fresh budget per value
 * and the per-address rules stop binding. Anything that terminates traffic in
 * front of this app must overwrite these headers rather than pass them
 * through - see docs/DEPLOY.md.
 *
 * The per-account login rule is deliberately keyed on the email instead, so
 * the brute-force ceiling on a *specific* account survives even where the
 * address cannot be trusted.
 */
export function clientAddress(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return first(vercel);

  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  const forwarded = headers.get("x-forwarded-for")?.trim();
  if (forwarded) return first(forwarded);

  return "unknown";
}

function first(headerValue: string): string {
  return headerValue.split(",")[0]!.trim() || "unknown";
}

/**
 * The rules themselves, in one place so the ceilings can be read together
 * rather than found one route at a time.
 *
 * These are sized for a control plane used by a handful of agency staff and a
 * handful of client portals - not a consumer API. The generous-looking webhook
 * limits are per source address, and HubSpot delivers in batches of up to 40
 * events per request.
 */
export const RateLimits = {
  /**
   * Password verification is scrypt at N = 2^16: ~300ms of CPU and ~64MB of
   * memory each. Ten per minute per address is far above what a person signing
   * in needs and far below what an attacker needs to be useful.
   */
  loginPerIp: { name: "login:ip", limit: 10, windowSeconds: 60 },

  /**
   * Narrower, and per account rather than per source, so that a distributed
   * guess at one known address - the agency admin's - is still bounded when
   * no single IP looks abusive.
   */
  loginPerEmail: { name: "login:email", limit: 5, windowSeconds: 300 },

  /**
   * Consulted before the HubSpot signature can be verified, because verifying
   * it requires first resolving the portal and unsealing that client's secret.
   */
  hubspotWebhook: { name: "webhook:hubspot", limit: 120, windowSeconds: 60 },

  /** Provider callbacks: one per call, plus interim status updates. */
  voiceWebhook: { name: "webhook:voice", limit: 240, windowSeconds: 60 },

  /** This platform's own lead event shape, authenticated by service token. */
  leadWebhook: { name: "webhook:lead", limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

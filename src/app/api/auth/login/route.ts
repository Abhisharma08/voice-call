import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, login, sessionCookieOptions } from "@/lib/auth/session";
import { recordUnscopedAudit } from "@/lib/audit";
import {
  RateLimits,
  clientAddress,
  consumeAll,
  retryAfterHeaders,
} from "@/lib/ratelimit";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = request.headers.get("user-agent");

  /**
   * Rate limiting happens after parsing and before `login()`, because
   * `login()` is the expensive part: verifying a password is scrypt at
   * N = 2^16, roughly 300ms of CPU and 64MB of memory per attempt. That cost
   * is deliberate - it is what makes a stolen hash expensive to crack - but
   * unmetered it is also the cheapest way for a remote attacker to exhaust
   * this instance, and an unlimited budget for guessing a password.
   *
   * Two rules, broad first. The per-address rule is what a flood hits; the
   * per-account rule catches a distributed guess at one known address, where
   * no single IP looks abusive. `consumeAll` stops at the first denial, so a
   * request already blocked by the IP rule does not also spend the account's
   * budget - otherwise an attacker could lock a real user out of their own
   * account just by guessing at it, turning this defence into the outage it
   * is meant to prevent.
   *
   * The email is lowercased into the key so that `Admin@` and `admin@` share
   * one budget rather than being two.
   */
  const denied = await consumeAll([
    { rule: RateLimits.loginPerIp, subject: clientAddress(request.headers) },
    { rule: RateLimits.loginPerEmail, subject: parsed.data.email.toLowerCase() },
  ]);

  if (denied) {
    await recordUnscopedAudit({
      tenantId: null,
      actorType: "system",
      action: "auth.login_rate_limited",
      entityType: "user",
      metadata: { email: parsed.data.email, rule: denied.rule.name },
      ip,
    });

    // Deliberately the same body as a wrong password. Confirming that *this*
    // account is the one being throttled would tell an attacker their guesses
    // are landing somewhere real (PRD 23.3).
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 429, headers: retryAfterHeaders(denied.verdict) },
    );
  }

  const result = await login(parsed.data.email, parsed.data.password, { ip, userAgent });

  if (!result) {
    await recordUnscopedAudit({
      tenantId: null,
      actorType: "system",
      action: "auth.login_failed",
      entityType: "user",
      metadata: { email: parsed.data.email },
      ip,
    });
    // One message for every failure mode: unknown account, wrong password,
    // disabled account.
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await recordUnscopedAudit({
    tenantId: null,
    actorType: "user",
    actorId: result.user.id,
    actorLabel: result.user.email,
    action: "auth.login",
    entityType: "user",
    entityId: result.user.id,
    ip,
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions());
  return response;
}

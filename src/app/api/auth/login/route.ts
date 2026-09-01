import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, login, sessionCookieOptions } from "@/lib/auth/session";
import { recordUnscopedAudit } from "@/lib/audit";

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

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentUser, } from "@/lib/auth/current-user";
import { requireGrant, TenantAccessError } from "@/lib/auth/tenant";
import { setActiveTenant } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

const Body = z.object({ tenantId: z.string().uuid().nullable() });

/**
 * Switch the session's active tenant.
 *
 * PRD 8.2: the tenant id in this request is a *request to enter* a tenant, not
 * authorization. requireGrant() decides, from the user's assignments and live
 * elevations, whether it is allowed - and logs the attempt either way.
 */
export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { tenantId } = parsed.data;

  if (tenantId === null) {
    await setActiveTenant(user.sessionId, null);
    return NextResponse.json({ ok: true, tenantId: null });
  }

  try {
    const grant = await requireGrant(user, tenantId);
    await setActiveTenant(user.sessionId, tenantId);

    await recordAudit({
      tenantId,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      action: "tenant.entered",
      entityType: "tenant",
      entityId: tenantId,
      metadata: { via: grant.via },
    });

    return NextResponse.json({ ok: true, tenantId });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // PRD 23.3: no disclosure of whether the tenant exists.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}

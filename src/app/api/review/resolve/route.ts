import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth/current-user";
import { withTenant, TenantAccessError } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { resolveReview } from "@/lib/qualification/resolve";

export const runtime = "nodejs";

const Body = z.object({
  tenant_id: z.string().uuid(),
  analysis_id: z.string().uuid(),
  action: z.enum(["confirm", "correct", "reject"]),
  note: z.string().max(1000).nullable().optional(),
  corrections: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Resolve a held qualification (PRD 26.3). Restricted to `review:resolve`,
 * which PRD 4 gives to the Operations Manager - the owner of this queue.
 */
export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!can(user.role, "review:resolve")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const body = parsed.data;

  try {
    const result = await withTenant(user, body.tenant_id, (tx) =>
      resolveReview(tx, {
        tenantId: body.tenant_id,
        analysisId: body.analysis_id,
        action: body.action,
        reviewerId: user.id,
        reviewerLabel: user.email,
        corrections: body.corrections,
        note: body.note ?? null,
      }),
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found") || message.includes("not pending")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("validation")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error(JSON.stringify({ level: "error", msg: "review resolve failed", err: message }));
    return NextResponse.json({ error: "Resolve failed" }, { status: 500 });
  }
}

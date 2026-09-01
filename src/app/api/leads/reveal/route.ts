import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth/current-user";
import { withTenant, TenantAccessError } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { decryptPiiOrNull } from "@/lib/crypto/pii";
import { auditInTx } from "@/lib/audit";

export const runtime = "nodejs";

const Body = z.object({
  tenant_id: z.string().uuid(),
  lead_id: z.string().uuid(),
});

/**
 * Reveal a lead's full phone number and email (PRD 26.2).
 *
 * "Column-level encryption at rest; masked in list views, unmasked only on
 * explicit detail-view action." The reveal is a distinct, permissioned,
 * audited action rather than a field that happens to be on the page - so the
 * audit log answers "who looked at this person's number, and when".
 */
export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!can(user.role, "pii:reveal")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { tenant_id: tenantId, lead_id: leadId } = parsed.data;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  try {
    const revealed = await withTenant(user, tenantId, async (tx) => {
      const r = await tx.query<{ phone_enc: Buffer | null; email_enc: Buffer | null }>(
        `select phone_enc, email_enc from leads where id = $1`,
        [leadId],
      );
      const row = r.rows[0];
      if (!row) return null;

      // The audit row is written in the same transaction as the read, so a
      // reveal cannot commit without its log entry.
      await auditInTx(tx, {
        tenantId,
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        action: "pii.reveal",
        entityType: "lead",
        entityId: leadId,
        metadata: { fields: ["phone", "email"] },
        ip,
      });

      return {
        phone: decryptPiiOrNull(row.phone_enc),
        email: decryptPiiOrNull(row.email_enc),
      };
    });

    if (!revealed) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(revealed);
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}

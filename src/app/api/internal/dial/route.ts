import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { runCallingTick } from "@/lib/calling/worker";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Calling worker tick (workflow W02). n8n's schedule trigger calls this; the
 * queue, the locks and the concurrency caps all live in PostgreSQL.
 */

const Body = z.object({
  campaign_id: z.string().uuid(),
  worker_id: z.string().min(1).max(64).default("n8n-w02"),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function POST(request: NextRequest) {
  const identity = await authenticateService(request, "calls:dial");
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const result = await withServiceScope(identity, (tx) =>
      runCallingTick(tx, {
        tenantId: identity.tenantId,
        campaignId: parsed.data.campaign_id,
        workerId: parsed.data.worker_id,
        webhookBaseUrl: env().APP_URL,
        limit: parsed.data.limit,
      }),
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A campaign id outside this token's tenant simply does not exist under
    // RLS - report it as not found, with no disclosure (PRD 23.3).
    if (message.includes("Campaign not found")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error(JSON.stringify({ level: "error", msg: "dial tick failed", err: message }));
    return NextResponse.json({ error: "Dial tick failed" }, { status: 500 });
  }
}

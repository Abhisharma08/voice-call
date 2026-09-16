import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { drainSyncOutbox } from "@/lib/integrations/sync-worker";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

/**
 * Outbox drain (workflow W03 steps 7-9, PRD 18.2). Runs on a schedule so a
 * HubSpot or Sheets outage clears itself once the provider recovers.
 */

const Body = z.object({ limit: z.number().int().min(1).max(100).optional() });

export async function POST(request: NextRequest) {
  const identity = await authenticateService(request, "sync:drain");
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  const limit = parsed.success ? parsed.data.limit : undefined;

  try {
    const result = await withServiceScope(identity, (tx) => drainSyncOutbox(tx, {}, limit));
    return NextResponse.json(result);
  } catch (err) {
    logger.error("sync drain failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Sync drain failed" }, { status: 500 });
  }
}

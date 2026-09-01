import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateService, withServiceScope } from "@/lib/auth/service";
import { qualifyCall } from "@/lib/qualification/pipeline";

export const runtime = "nodejs";

/**
 * Qualification (workflow W03). Called once per completed call; the pipeline
 * itself is idempotent, so a duplicate n8n execution returns the existing
 * analysis rather than paying for a second model call.
 */

const Body = z.object({ call_id: z.string().uuid() });

export async function POST(request: NextRequest) {
  const identity = await authenticateService(request, "analysis:run");
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const result = await withServiceScope(identity, (tx) =>
      qualifyCall(tx, { tenantId: identity.tenantId, callId: parsed.data.call_id }),
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Call not found")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error(JSON.stringify({ level: "error", msg: "analysis failed", err: message }));
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
  }
}

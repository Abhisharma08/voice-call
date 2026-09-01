import { NextResponse } from "next/server";
import { pool } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Reports database reachability, nothing else. */
export async function GET() {
  const started = Date.now();
  try {
    await pool("app").query("select 1");
    return NextResponse.json({
      status: "ok",
      database: "reachable",
      latency_ms: Date.now() - started,
    });
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unreachable" },
      { status: 503 },
    );
  }
}

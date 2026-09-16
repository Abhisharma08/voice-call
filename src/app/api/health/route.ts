import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/db/client";
import { providerDiagnostics } from "@/lib/providers/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness, readiness, and - for an authenticated caller - diagnosis.
 *
 * Two audiences with incompatible needs meet at this URL. A load balancer
 * wants a fast yes/no and nothing else. A person working out why a deploy is
 * misbehaving wants to know whether the migrations ran, whether the scheduler
 * is configured, and which voice providers actually registered.
 *
 * The second set cannot be public. This endpoint is in the proxy's
 * PUBLIC_PATHS - it has to be, a probe cannot sign in - so everything it
 * returns, it returns to the internet. "Which environment variables are
 * missing" is a useful map of a half-configured deployment for somebody who
 * did not deploy it.
 *
 * So the public body stays exactly what it was, and the detail is gated behind
 * the same shared secret the scheduler already uses: nothing new to configure,
 * and a boundary that is already drawn.
 */

interface Detail {
  migrations: { applied: number; latest: string | null };
  scheduler: { configured: boolean };
  voiceProviders: Array<{ name: string; registered: boolean; missing: string[] }>;
}

export async function GET(request: NextRequest) {
  const started = Date.now();

  let applied: { count: number; latest: string | null };
  try {
    applied = await migrationState();
  } catch {
    // The probe's whole job. Everything below needs the database, so there is
    // nothing further worth reporting.
    return NextResponse.json(
      { status: "degraded", database: "unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  /**
   * A database that answers but holds no schema is not ready. That is the
   * exact shape of a deploy pointed at the wrong database, or one where the
   * migration step was skipped - and without this check it reports healthy
   * right up until the first request touches a table.
   */
  if (applied.count === 0) {
    return NextResponse.json(
      { status: "degraded", database: "reachable", schema: "not migrated" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const body: Record<string, unknown> = {
    status: "ok",
    database: "reachable",
    latency_ms: Date.now() - started,
  };

  if (authorizedForDetail(request)) {
    body.detail = {
      migrations: { applied: applied.count, latest: applied.latest },
      scheduler: { configured: Boolean(process.env.CRON_SECRET) },
      voiceProviders: providerDiagnostics().map((p) => ({
        name: p.name,
        registered: p.registered,
        missing: p.missing,
      })),
    } satisfies Detail;
  }

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

async function migrationState(): Promise<{ count: number; latest: string | null }> {
  // The `app` pool rather than the owner's: this is the connection the request
  // path uses, so probing it is what proves the credential the application
  // actually runs on works - which an owner-pool check would not.
  const r = await pool("app").query<{ count: string; latest: string | null }>(
    `select count(*)::text as count, max(filename) as latest from schema_migrations`,
  );

  return { count: Number(r.rows[0]?.count ?? 0), latest: r.rows[0]?.latest ?? null };
}

/**
 * The same shared secret and the same constant-time comparison as the
 * scheduled sweep. A missing CRON_SECRET denies detail rather than granting
 * it: the failure mode of getting that backwards is an endpoint that hands its
 * configuration to anyone who asks.
 */
function authorizedForDetail(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

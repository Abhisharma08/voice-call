import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { withScope, withoutScope, type TenantScope } from "@/db/client";
import { recordUnscopedAudit } from "@/lib/audit";

/**
 * Service identities for n8n workers (PRD 4: "Service identity only", PRD 9).
 *
 * A worker token is bound to exactly one tenant at issue time. That is the
 * whole point: PRD 8.2 says "No workflow or API endpoint may accept an
 * arbitrary tenant_id from a public client and trust it as authorization", so
 * the tenant comes from the credential, never from the request body - even
 * though the caller is our own automation.
 */

export interface ServiceIdentity {
  tokenId: string;
  tenantId: string;
  name: string;
  scopes: string[];
}

export type ServiceScope =
  | "leads:ingest"
  | "calls:dial"
  | "calls:result"
  | "analysis:run"
  | "sync:drain";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateServiceToken(): { token: string; hash: string } {
  const token = `svc_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

/** Extract a bearer token without leaking timing on the prefix comparison. */
function bearerFrom(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const prefix = "Bearer ";
  if (header.length <= prefix.length) return null;

  const given = Buffer.from(header.slice(0, prefix.length));
  const expected = Buffer.from(prefix);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const token = header.slice(prefix.length).trim();
  return token === "" ? null : token;
}

export async function authenticateService(
  request: NextRequest,
  required: ServiceScope,
): Promise<ServiceIdentity | null> {
  const token = bearerFrom(request);
  if (!token) return null;

  const identity = await withoutScope(async (tx) => {
    const r = await tx.query<{
      token_id: string;
      tenant_id: string;
      name: string;
      scopes: string[];
    }>(`select * from app.service_token_lookup($1)`, [hashToken(token)]);

    const row = r.rows[0];
    if (!row) return null;

    await tx.query(`select app.service_token_touch($1)`, [row.token_id]);
    return {
      tokenId: row.token_id,
      tenantId: row.tenant_id,
      name: row.name,
      scopes: row.scopes,
    };
  }, "service");

  if (!identity) {
    await recordUnscopedAudit({
      tenantId: null,
      actorType: "system",
      action: "service.auth_failed",
      metadata: { required_scope: required },
    });
    return null;
  }

  if (!identity.scopes.includes(required) && !identity.scopes.includes("*")) {
    await recordUnscopedAudit({
      tenantId: identity.tenantId,
      actorType: "service",
      actorLabel: identity.name,
      action: "service.scope_denied",
      metadata: { required_scope: required, held_scopes: identity.scopes },
    });
    return null;
  }

  return identity;
}

export function serviceScope(identity: ServiceIdentity): TenantScope {
  return {
    tenantId: identity.tenantId,
    globalScope: false,
    actorId: null,
    actorType: "service",
  };
}

/** Run work inside the RLS scope carried by the worker's own credential. */
export async function withServiceScope<T>(
  identity: ServiceIdentity,
  fn: Parameters<typeof withScope<T>>[1],
): Promise<T> {
  return withScope(serviceScope(identity), fn, "service");
}

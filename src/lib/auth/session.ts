import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withoutScope } from "@/db/client";
import { env } from "@/lib/env";
import { verifyPassword } from "@/lib/crypto/password";
import type { Role } from "@/lib/auth/rbac";

/**
 * Opaque server-side sessions.
 *
 * The cookie carries a random 256-bit token; only its SHA-256 is stored, so a
 * database dump does not yield usable sessions. Nothing about role or tenant
 * lives in the cookie - PRD 8.2 requires tenant context to be derived from the
 * authenticated session server-side, and a self-describing token would put
 * that decision back in the client's hands.
 */

export const SESSION_COOKIE = "lc_session";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  activeTenantId: string | null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().APP_ENV !== "development",
    path: "/",
    maxAge: env().SESSION_TTL_HOURS * 3600,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface LoginResult {
  token: string;
  user: AuthenticatedUser;
}

/**
 * Verify credentials and mint a session. Returns null for every failure mode -
 * unknown email, wrong password, disabled account - so the caller cannot leak
 * which one it was.
 */
export async function login(
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LoginResult | null> {
  return withoutScope(async (tx) => {
    // Via a SECURITY DEFINER function: `users` stays closed to the runtime
    // role, and this is the only path that can read a password hash.
    const found = await tx.query<{
      id: string;
      email: string;
      name: string;
      role: Role;
      status: string;
      password_hash: string | null;
    }>(`select * from app.login_lookup($1)`, [email]);

    const user = found.rows[0];

    // Always run a verification so a missing account and a wrong password take
    // comparable time.
    const hash = user?.password_hash ?? DUMMY_HASH;
    const ok = await verifyPassword(password, hash);

    if (!user || !ok || user.status !== "active" || user.role === "service") return null;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600 * 1000);

    const inserted = await tx.query<{ id: string }>(
      `insert into sessions (user_id, token_hash, ip, user_agent, expires_at)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [user.id, hashToken(token), meta.ip ?? null, meta.userAgent ?? null, expiresAt],
    );

    await tx.query(`select app.mark_login($1)`, [user.id]);

    const session = inserted.rows[0];
    if (!session) throw new Error("Failed to create session");

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sessionId: session.id,
        activeTenantId: null,
      },
    };
  });
}

/** A well-formed scrypt hash of an unguessable value, for timing equalisation. */
const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Y2Fubm90bWF0Y2hhbnl0aGluZ2V2ZXJoZXJlaXNqdXN0cGFkZGluZ3RvNjRieXRlc29rISE=";

export async function resolveSession(token: string | undefined | null): Promise<AuthenticatedUser | null> {
  if (!token) return null;

  return withoutScope(async (tx) => {
    const result = await tx.query<{
      session_id: string;
      active_tenant_id: string | null;
      user_id: string;
      email: string;
      name: string;
      role: Role;
      status: string;
    }>(
      `select * from app.session_lookup($1)`,
      [hashToken(token)],
    );

    const row = result.rows[0];
    if (!row || row.status !== "active") return null;

    await tx.query(`select app.session_touch($1)`, [row.session_id]);

    return {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      sessionId: row.session_id,
      activeTenantId: row.active_tenant_id,
    };
  });
}

export async function setActiveTenant(sessionId: string, tenantId: string | null): Promise<void> {
  await withoutScope(async (tx) => {
    await tx.query(`update sessions set active_tenant_id = $2 where id = $1`, [sessionId, tenantId]);
  });
}

export async function logout(token: string): Promise<void> {
  await withoutScope(async (tx) => {
    await tx.query(`update sessions set revoked_at = now() where token_hash = $1`, [hashToken(token)]);
  });
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await withoutScope(async (tx) => {
    await tx.query(
      `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
      [userId],
    );
  });
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, globalAction, success, type ActionResult } from "@/lib/actions";
import { hashPassword } from "@/lib/crypto/password";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { ROLES } from "@/lib/auth/rbac";

/**
 * Staff, assignments and elevations (PRD 4, 8.2).
 *
 * PRD 8.2's point is that agency staff should be scoped to their assigned
 * clients by default, and that reaching outside that set "requires an
 * explicit, logged elevation rather than being available by default because
 * the agency 'has access to everything.'" These actions are that mechanism.
 */

const CreateUser = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES),
  password: z.string().min(12).max(200),
});

export async function createStaffUser(formData: FormData): Promise<ActionResult> {
  const parsed = CreateUser.safeParse({
    email: formData.get("email"),
    name: formData.get("name"),
    role: formData.get("role"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      issue?.path[0] === "password"
        ? "Password must be at least 12 characters"
        : (issue?.message ?? "Invalid input"),
      issue?.path.join("."),
    );
  }

  // A service identity is not a person and must not be able to sign in.
  // login() already refuses the role; refusing to mint one with a password
  // closes the other half.
  if (parsed.data.role === "service") {
    return failure("Service identities use scoped tokens, not passwords", "role");
  }

  return globalAction({ permission: "user:write" }, async (ctx) => {
    const hash = await hashPassword(parsed.data.password);

    const r = await ctx.tx.query<{ id: string }>(
      `insert into users (email, name, role, password_hash) values ($1, $2, $3, $4)
       on conflict (email) do nothing
       returning id`,
      [parsed.data.email, parsed.data.name, parsed.data.role, hash],
    );

    if (r.rowCount === 0) return failure("A user with that email already exists", "email");

    await ctx.audit({
      action: "user.created",
      entityType: "user",
      entityId: r.rows[0]!.id,
      metadata: { email: parsed.data.email, role: parsed.data.role },
    });

    revalidatePath("/settings");
    return success();
  });
}

const SetUserStatus = z.object({
  userId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
});

export async function setUserStatus(formData: FormData): Promise<ActionResult> {
  const parsed = SetUserStatus.safeParse({
    userId: formData.get("userId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return failure("Invalid input");

  return globalAction({ permission: "user:write" }, async (ctx) => {
    if (parsed.data.userId === ctx.user.id && parsed.data.status === "disabled") {
      return failure("You cannot disable your own account");
    }

    await ctx.tx.query(`update users set status = $2 where id = $1`, [
      parsed.data.userId,
      parsed.data.status,
    ]);

    // A disabled account with a live session is still an active account.
    if (parsed.data.status === "disabled") {
      await revokeAllSessionsForUser(parsed.data.userId);
    }

    await ctx.audit({
      action: "user.status_changed",
      entityType: "user",
      entityId: parsed.data.userId,
      metadata: { status: parsed.data.status },
    });

    revalidatePath("/settings");
    return success();
  });
}

const Assignment = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: z.enum(ROLES),
});

export async function assignUserToTenant(formData: FormData): Promise<ActionResult> {
  const parsed = Assignment.safeParse({
    userId: formData.get("userId"),
    tenantId: formData.get("tenantId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return failure("Invalid input");

  return globalAction({ permission: "user:write" }, async (ctx) => {
    await ctx.tx.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role, created_by)
       values ($1, $2, $3, $4)
       on conflict (user_id, tenant_id) do update set role = excluded.role`,
      [parsed.data.userId, parsed.data.tenantId, parsed.data.role, ctx.user.id],
    );

    await ctx.audit({
      action: "assignment.granted",
      entityType: "user",
      entityId: parsed.data.userId,
      metadata: { tenant_id: parsed.data.tenantId, role: parsed.data.role },
    });

    revalidatePath("/settings");
    return success();
  });
}

export async function removeAssignment(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId"));
  const tenantId = String(formData.get("tenantId"));

  return globalAction({ permission: "user:write" }, async (ctx) => {
    await ctx.tx.query(
      `delete from user_tenant_assignments where user_id = $1 and tenant_id = $2`,
      [userId, tenantId],
    );

    // Clear the session's active tenant if it pointed at what was just
    // revoked, so the next request re-derives scope rather than continuing
    // under a grant that no longer exists.
    await ctx.tx.query(
      `update sessions set active_tenant_id = null where user_id = $1 and active_tenant_id = $2`,
      [userId, tenantId],
    );

    await ctx.audit({
      action: "assignment.revoked",
      entityType: "user",
      entityId: userId,
      metadata: { tenant_id: tenantId },
    });

    revalidatePath("/settings");
    return success();
  });
}

const Elevation = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  reason: z.string().min(10).max(500),
  hours: z.coerce.number().int().min(1).max(72),
});

/**
 * PRD 8.2's explicit, logged elevation.
 *
 * Time-boxed by construction - there is no "permanent" option - because an
 * elevation that never expires is just an assignment with extra steps, and the
 * whole point is that reaching outside your assigned clients should be a
 * visible, temporary exception.
 */
export async function grantElevation(formData: FormData): Promise<ActionResult> {
  const parsed = Elevation.safeParse({
    userId: formData.get("userId"),
    tenantId: formData.get("tenantId"),
    reason: formData.get("reason"),
    hours: formData.get("hours"),
  });

  if (!parsed.success) {
    return failure("Give a reason of at least 10 characters and a duration in hours", "reason");
  }

  return globalAction({ permission: "elevation:grant" }, async (ctx) => {
    const r = await ctx.tx.query<{ id: string }>(
      `insert into access_elevations (user_id, tenant_id, reason, granted_by, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(hours => $5))
       returning id`,
      [parsed.data.userId, parsed.data.tenantId, parsed.data.reason, ctx.user.id, parsed.data.hours],
    );

    await ctx.audit({
      action: "elevation.granted",
      entityType: "user",
      entityId: parsed.data.userId,
      metadata: {
        elevation_id: r.rows[0]!.id,
        tenant_id: parsed.data.tenantId,
        reason: parsed.data.reason,
        hours: parsed.data.hours,
      },
    });

    revalidatePath("/settings");
    return success();
  });
}

export async function revokeElevation(formData: FormData): Promise<ActionResult> {
  const elevationId = String(formData.get("elevationId"));

  return globalAction({ permission: "elevation:grant" }, async (ctx) => {
    const r = await ctx.tx.query<{ user_id: string; tenant_id: string }>(
      `update access_elevations set revoked_at = now()
        where id = $1 and revoked_at is null
        returning user_id, tenant_id`,
      [elevationId],
    );

    const row = r.rows[0];
    if (!row) return failure("That elevation is already revoked or expired");

    await ctx.tx.query(
      `update sessions set active_tenant_id = null
        where user_id = $1 and active_tenant_id = $2`,
      [row.user_id, row.tenant_id],
    );

    await ctx.audit({
      action: "elevation.revoked",
      entityType: "user",
      entityId: row.user_id,
      metadata: { elevation_id: elevationId, tenant_id: row.tenant_id },
    });

    revalidatePath("/settings");
    return success();
  });
}

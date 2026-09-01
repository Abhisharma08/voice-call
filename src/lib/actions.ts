import type { PoolClient } from "pg";
import { requireUser } from "@/lib/auth/current-user";
import { withGlobalScope, withTenant, TenantAccessError } from "@/lib/auth/tenant";
import { AuthorizationError, can, type Permission } from "@/lib/auth/rbac";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { auditInTx } from "@/lib/audit";

/**
 * The single path every configuration write takes.
 *
 * PRD 17.1 requires configuration changes, manual suppression, routing changes
 * and data exports to be audited. Rather than trusting each form handler to
 * remember, these wrappers make the permission check and the audit row
 * structural: you cannot get a transaction without naming the permission it
 * needs, and the audit row is written inside that same transaction, so it
 * cannot describe a change that rolled back.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; field?: string };

export function failure(error: string, field?: string): ActionResult<never> {
  return { ok: false, error, ...(field ? { field } : {}) };
}

export function success(): ActionResult<void>;
export function success<T>(data: T): ActionResult<T>;
export function success<T>(data?: T): ActionResult<T | void> {
  return { ok: true, data: data as T };
}

export interface ActionContext {
  user: AuthenticatedUser;
  tx: PoolClient;
  tenantId: string;
  /** Write an audit row inside this action's transaction. */
  audit: (entry: {
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Run a tenant-scoped write. Resolves the session, checks the permission,
 * verifies the tenant grant, and opens an RLS-scoped transaction.
 *
 * `tenantId` arriving from a form is a *request* to act inside that tenant;
 * `withTenant` decides whether it is allowed (PRD 8.2) and logs a denial.
 */
export async function tenantAction<T>(
  args: { tenantId: string; permission: Permission },
  fn: (ctx: ActionContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const user = await requireUser();

  if (!can(user.role, args.permission)) {
    return failure("You do not have permission to do that");
  }

  try {
    return await withTenant(user, args.tenantId, (tx) =>
      fn({
        user,
        tx,
        tenantId: args.tenantId,
        audit: (entry) =>
          auditInTx(tx, {
            tenantId: args.tenantId,
            actorType: "user",
            actorId: user.id,
            actorLabel: user.email,
            ...entry,
          }),
      }),
    );
  } catch (err) {
    return translate(err);
  }
}

/** Writes that are not scoped to one tenant: creating one, managing staff. */
export async function globalAction<T>(
  args: { permission: Permission },
  fn: (ctx: Omit<ActionContext, "tenantId">) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const user = await requireUser();

  if (!can(user.role, args.permission)) {
    return failure("You do not have permission to do that");
  }

  try {
    return await withGlobalScope(user, (tx) =>
      fn({
        user,
        tx,
        audit: (entry) =>
          auditInTx(tx, {
            tenantId: null,
            actorType: "user",
            actorId: user.id,
            actorLabel: user.email,
            ...entry,
          }),
      }),
    );
  } catch (err) {
    return translate(err);
  }
}

function translate(err: unknown): ActionResult<never> {
  // PRD 23.3: a tenant the caller may not reach is indistinguishable from one
  // that does not exist.
  if (err instanceof TenantAccessError) return failure("Not found");
  if (err instanceof AuthorizationError) return failure("Not authorized");

  const message = err instanceof Error ? err.message : String(err);

  // Surface the database's own guardrails as readable messages rather than
  // leaking SQL. These constraints exist for reasons the operator should see.
  if (message.includes("campaigns_compliance_needs_consent_ck")) {
    return failure(
      "Record the consent basis for this client's lead list before approving the campaign (PRD 14.3, 26.1)",
      "consentBasis",
    );
  }
  if (message.includes("campaigns_tenant_name_uniq") || message.includes("campaigns_tenant_id_name_key")) {
    return failure("A campaign with that name already exists for this client", "name");
  }
  if (message.includes("tenants_slug_key")) {
    return failure("That client identifier is already taken", "slug");
  }
  if (message.includes("qualification_rules_campaign_field_uniq")) {
    return failure("That field name is already used on this campaign", "fieldName");
  }
  if (message.includes("duplicate key")) {
    return failure("That record already exists");
  }

  console.error(JSON.stringify({ level: "error", msg: "action failed", err: message }));
  return failure("Something went wrong. The change was not saved.");
}

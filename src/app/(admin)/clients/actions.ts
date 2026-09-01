"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, globalAction, success, tenantAction, type ActionResult } from "@/lib/actions";
import { sealSecret } from "@/lib/crypto/kms";
import { DEFAULT_CAMPAIGN_CONFIG } from "@/lib/campaigns/config";

/**
 * Client onboarding (PRD 14.3).
 *
 * "The client does not use this platform, log in, or configure anything
 * directly. The agency holds full access to the client's HubSpot, Google
 * Workspace, and (where applicable) voice provider accounts, and a Campaign
 * Manager runs this wizard on the client's behalf."
 *
 * So there is no client-facing signup. Creating a tenant is an Agency Admin
 * action, and every credential stored here is agency-managed.
 */

const CreateTenant = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, digits and hyphens"),
  timezone: z.string().min(1).max(64),
  notes: z.string().max(2000).optional(),
});

export async function createTenant(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateTenant.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    timezone: formData.get("timezone"),
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid input", issue?.path.join("."));
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: parsed.data.timezone });
  } catch {
    return failure("Not a recognised IANA timezone", "timezone");
  }

  return globalAction({ permission: "tenant:write" }, async (ctx) => {
    const r = await ctx.tx.query<{ id: string }>(
      `insert into tenants (name, slug, timezone, notes, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [parsed.data.name, parsed.data.slug, parsed.data.timezone, parsed.data.notes ?? null, ctx.user.id],
    );

    const id = r.rows[0]!.id;

    // PRD 8.2: agency staff are scoped by assignment. The creator gets one
    // immediately, so the new client is reachable without an elevation - and
    // nobody else silently gains access.
    await ctx.tx.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role, created_by)
       values ($1, $2, $3, $1) on conflict do nothing`,
      [ctx.user.id, id, ctx.user.role],
    );

    await ctx.audit({
      action: "tenant.created",
      entityType: "tenant",
      entityId: id,
      metadata: { name: parsed.data.name, slug: parsed.data.slug },
    });

    revalidatePath("/clients");
    return success({ id });
  });
}

const SetTenantStatus = z.object({
  tenantId: z.string().uuid(),
  status: z.enum(["active", "inactive", "suspended"]),
});

export async function setTenantStatus(formData: FormData): Promise<ActionResult> {
  const parsed = SetTenantStatus.safeParse({
    tenantId: formData.get("tenantId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return failure("Invalid input");

  return tenantAction(
    { tenantId: parsed.data.tenantId, permission: "tenant:write" },
    async (ctx) => {
      await ctx.tx.query(`update tenants set status = $2 where id = $1`, [
        parsed.data.tenantId,
        parsed.data.status,
      ]);

      // A suspended client must stop being dialled immediately, not at the end
      // of the current queue. checkEligibility already refuses a non-active
      // tenant, but leaving rows queued would make the dashboard lie about what
      // is about to happen.
      if (parsed.data.status !== "active") {
        await ctx.tx.query(
          `update leads set status = 'suppressed', status_reason = 'tenant_inactive',
                  next_call_at = null, locked_by = null, lock_expires_at = null
            where status in ('queued', 'new')`,
        );
        await ctx.tx.query(`update campaigns set active = false`);
      }

      await ctx.audit({
        action: "tenant.status_changed",
        entityType: "tenant",
        entityId: parsed.data.tenantId,
        metadata: { status: parsed.data.status },
      });

      revalidatePath("/clients");
      return success();
    },
  );
}

const AddIntegration = z.object({
  tenantId: z.string().uuid(),
  type: z.enum(["hubspot", "google_sheets", "voice_provider", "notification"]),
  name: z.string().min(1).max(120),
  credential: z.string().min(1).max(20_000),
});

/**
 * Store an agency-managed credential for a client (PRD 14.3 steps 2-3).
 *
 * The plaintext is sealed before it touches the database and is never read
 * back into the UI - `integrations` shows a status, never a secret. PRD 17.1:
 * "store only secret references in app/database".
 */
export async function addIntegration(formData: FormData): Promise<ActionResult> {
  const parsed = AddIntegration.safeParse({
    tenantId: formData.get("tenantId"),
    type: formData.get("type"),
    name: formData.get("name"),
    credential: formData.get("credential"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid input", issue?.path.join("."));
  }

  const { tenantId, type, name, credential } = parsed.data;

  // Validate the credential shape here, while we still have the plaintext.
  // Discovering a malformed service-account key at 2am during a sync is worse
  // than refusing it at the point someone pastes it in.
  const shapeError = validateCredentialShape(type, credential);
  if (shapeError) return failure(shapeError, "credential");

  return tenantAction({ tenantId, permission: "secret:write" }, async (ctx) => {
    const sealed = sealSecret(credential, type);

    const secret = await ctx.tx.query<{ id: string }>(
      `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        tenantId,
        type,
        sealed.keyId,
        sealed.wrappedDek,
        sealed.iv,
        sealed.ciphertext,
        sealed.authTag,
        ctx.user.id,
      ],
    );

    const integration = await ctx.tx.query<{ id: string }>(
      `insert into integrations (tenant_id, type, name, credential_ref, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [tenantId, type, name, secret.rows[0]!.id, ctx.user.id],
    );

    await ctx.audit({
      action: "integration.created",
      entityType: "integration",
      entityId: integration.rows[0]!.id,
      // The credential itself never reaches the audit log.
      metadata: { type, name },
    });

    revalidatePath("/integrations");
    revalidatePath("/clients");
    return success();
  });
}

function validateCredentialShape(type: string, credential: string): string | null {
  if (type === "hubspot") {
    try {
      const parsed = JSON.parse(credential) as { accessToken?: unknown };
      if (typeof parsed.accessToken !== "string" || parsed.accessToken.length < 10) {
        return 'Expected JSON like {"accessToken": "pat-na1-..."}';
      }
    } catch {
      return 'Expected JSON like {"accessToken": "pat-na1-..."}';
    }
    return null;
  }

  if (type === "google_sheets") {
    try {
      const parsed = JSON.parse(credential) as { client_email?: unknown; private_key?: unknown };
      if (typeof parsed.client_email !== "string" || !parsed.client_email.includes("@")) {
        return "Service account JSON must include a client_email";
      }
      if (
        typeof parsed.private_key !== "string" ||
        !parsed.private_key.includes("BEGIN PRIVATE KEY")
      ) {
        return "Service account JSON must include a PEM private_key";
      }
    } catch {
      return "Expected the downloaded service-account JSON";
    }
    return null;
  }

  return null;
}

const CreateCampaign = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(120),
});

export async function createCampaign(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateCampaign.safeParse({
    tenantId: formData.get("tenantId"),
    name: formData.get("name"),
  });
  if (!parsed.success) return failure("A campaign name is required", "name");

  return tenantAction({ tenantId: parsed.data.tenantId, permission: "campaign:write" }, async (ctx) => {
    const tenant = await ctx.tx.query<{ timezone: string }>(
      `select timezone from tenants where id = $1`,
      [parsed.data.tenantId],
    );

    const defaults = DEFAULT_CAMPAIGN_CONFIG;
    const r = await ctx.tx.query<{ id: string }>(
      `insert into campaigns
         (tenant_id, name, timezone, calling_config, routing_config, scoring_rubric,
          google_sheet_tab, created_by, updated_by, active)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $8, false)
       returning id`,
      [
        parsed.data.tenantId,
        parsed.data.name,
        tenant.rows[0]?.timezone ?? defaults.timezone,
        JSON.stringify(defaults.callingConfig),
        JSON.stringify(defaults.routingConfig),
        JSON.stringify(defaults.scoringRubric),
        defaults.googleSheetTab,
        ctx.user.id,
      ],
    );

    const id = r.rows[0]!.id;
    await ctx.audit({
      action: "campaign.created",
      entityType: "campaign",
      entityId: id,
      metadata: { name: parsed.data.name },
    });

    revalidatePath("/campaigns");
    return success({ id });
  });
}

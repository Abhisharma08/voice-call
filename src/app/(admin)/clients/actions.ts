"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, globalAction, success, tenantAction, type ActionResult } from "@/lib/actions";
import { sealSecret } from "@/lib/crypto/kms";
import { activationBlockers, DEFAULT_CAMPAIGN_CONFIG } from "@/lib/campaigns/config";
import { auditInTx } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import { generateServiceToken } from "@/lib/auth/service";
import { env } from "@/lib/env";
import {
  hubspotAppWebhookUrl,
  hubspotWebhookUrl,
  templateById,
} from "@/lib/onboarding/templates";
import { validateSlackCredential } from "@/lib/integrations/slack";

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
    const shape =
      'Expected JSON like {"accessToken": "pat-na1-...", "clientSecret": "..."}';
    try {
      const parsed = JSON.parse(credential) as {
        accessToken?: unknown;
        clientSecret?: unknown;
      };
      if (typeof parsed.accessToken !== "string" || parsed.accessToken.length < 10) {
        return shape;
      }
      // Optional, because a portal that pushes leads some other way never
      // needs it. Required for private-app webhooks, which is how a free
      // HubSpot account sends leads at all - so a value that is present but
      // obviously truncated is worth refusing now rather than at 2am as an
      // invalid signature.
      if (parsed.clientSecret !== undefined) {
        if (typeof parsed.clientSecret !== "string" || parsed.clientSecret.trim().length < 16) {
          return "clientSecret looks truncated - copy the private app's full client secret";
        }
      }
    } catch {
      return shape;
    }
    return null;
  }

  // A Slack incoming webhook URL is itself the credential - anyone holding it
  // can post to the client's channel - so it is sealed like any other secret
  // and checked for shape here, while the plaintext is still in hand.
  if (type === "notification") {
    return validateSlackCredential(credential);
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

// ─────────────────────────────────────────────────────────────────────────────
// One-step onboarding
// ─────────────────────────────────────────────────────────────────────────────

const OnboardClient = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, digits and hyphens"),
  timezone: z.string().min(1).max(64),
  campaignName: z.string().min(1).max(120),
  template: z.string().min(1).max(60),
  /**
   * A number the campaign may dial, for the first live test. Empty means
   * unrestricted, which is the right setting only once the client is live.
   */
  testNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, "Use E.164, e.g. +919876543210")
    .optional(),
  notes: z.string().max(2000).optional(),
});

export interface OnboardedClient {
  tenantId: string;
  campaignId: string;
  /** Shown once. Only the hash is stored, so it cannot be recovered later. */
  token: string;
  /** Private-app subscription target. The path a free HubSpot portal can use. */
  appWebhookUrl: string;
  /** Workflow-action target, for a portal on a plan that has workflows. */
  webhookUrl: string;
  blockers: string[];
}

/**
 * Create a client, its first campaign and the credential HubSpot posts with -
 * in one transaction (PRD 14.3).
 *
 * Every piece of this existed already; what did not exist was a way to do it
 * without a Node script. Onboarding a client meant creating a tenant in the
 * UI, creating a campaign, writing a script and questions by hand, then
 * running a seed file to mint a service token - and the token step had no UI
 * at all, so in practice every new client involved editing the repository.
 *
 * One transaction because a half-onboarded client is worse than none: a tenant
 * with no campaign is invisible in most of the UI, and a campaign whose token
 * was never minted looks configured while HubSpot has no way to reach it.
 *
 * What this deliberately does not do:
 *
 *   - activate the campaign. `active` stays false and `activationBlockers()`
 *     is returned instead, so the remaining work is stated rather than
 *     skipped.
 *   - approve compliance (PRD 17.3). That is a named person's attestation.
 *   - choose a real voice provider. The campaign starts on `mock`, so a new
 *     client cannot dial anyone until someone decides it should.
 */
export async function onboardClient(
  formData: FormData,
): Promise<ActionResult<OnboardedClient>> {
  const parsed = OnboardClient.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    timezone: formData.get("timezone"),
    campaignName: formData.get("campaignName"),
    template: formData.get("template"),
    testNumber: formData.get("testNumber") || undefined,
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid input", issue?.path.join("."));
  }

  const input = parsed.data;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: input.timezone });
  } catch {
    return failure("Not a recognised IANA timezone", "timezone");
  }

  const template = templateById(input.template);
  if (!template) return failure("Unknown campaign template", "template");

  return globalAction({ permission: "tenant:write" }, async (ctx) => {
    // globalAction checked tenant:write. Creating the campaign is a second
    // permission, and an Operations Manager holding one without the other
    // must not get half of this.
    if (!can(ctx.user.role, "campaign:write")) {
      return failure("You do not have permission to create campaigns");
    }

    const tenant = await ctx.tx.query<{ id: string }>(
      `insert into tenants (name, slug, timezone, notes, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.name, input.slug, input.timezone, input.notes ?? null, ctx.user.id],
    );
    const tenantId = tenant.rows[0]!.id;

    // PRD 8.2: scope comes from assignment. Without this the creator would
    // have to grant themselves an elevation to open the client they just made.
    await ctx.tx.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role, created_by)
       values ($1, $2, $3, $1) on conflict do nothing`,
      [ctx.user.id, tenantId, ctx.user.role],
    );

    const defaults = DEFAULT_CAMPAIGN_CONFIG;
    const campaign = await ctx.tx.query<{ id: string }>(
      `insert into campaigns
         (tenant_id, name, timezone, business_context, script,
          calling_config, routing_config, scoring_rubric,
          google_sheet_tab, consent_origin, dial_allowlist,
          created_by, updated_by, active)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11,
               $12, $12, false)
       returning id`,
      [
        tenantId,
        input.campaignName,
        input.timezone,
        template.businessContext,
        template.script,
        JSON.stringify({
          ...defaults.callingConfig,
          // Neural Indian English rather than the flat standard voice. Read by
          // the TwiML endpoint; harmless to a provider that runs its own agent.
          voice: "Polly.Kajal-Neural",
          language: "en-IN",
        }),
        JSON.stringify(defaults.routingConfig),
        JSON.stringify(template.scoringRubric),
        defaults.googleSheetTab,
        template.consentOrigin,
        input.testNumber ? [input.testNumber] : [],
        ctx.user.id,
      ],
    );
    const campaignId = campaign.rows[0]!.id;

    for (const q of template.questions) {
      await ctx.tx.query(
        `insert into qualification_rules
           (tenant_id, campaign_id, field_name, question, required, position)
         values ($1, $2, $3, $4, $5, $6)`,
        [tenantId, campaignId, q.fieldName, q.question, q.required, q.position],
      );
    }

    // The credential HubSpot presents. Scoped to intake alone: dialling is
    // triggered by intake itself and swept by the scheduler, so a token that
    // leaves this building never needs to be able to place a call.
    const minted = generateServiceToken();
    await ctx.tx.query(
      `insert into service_tokens (tenant_id, name, token_hash, scopes, created_by)
       values ($1, 'hubspot-intake', $2, $3, $4)`,
      [tenantId, minted.hash, ["leads:ingest"], ctx.user.id],
    );

    await ctx.audit({
      action: "tenant.created",
      entityType: "tenant",
      entityId: tenantId,
      metadata: { name: input.name, slug: input.slug, via: "onboarding" },
    });

    // Tenant-scoped entries carry the tenant, unlike globalAction's own audit
    // helper - a campaign created for a client belongs in that client's trail.
    for (const entry of [
      {
        action: "campaign.created",
        entityType: "campaign",
        entityId: campaignId,
        metadata: {
          name: input.campaignName,
          template: template.id,
          questions: template.questions.length,
          via: "onboarding",
        },
      },
      {
        action: "service_token.created",
        entityType: "tenant",
        entityId: tenantId,
        // The token itself never reaches the audit log.
        metadata: { name: "hubspot-intake", scopes: ["leads:ingest"] },
      },
    ]) {
      await auditInTx(ctx.tx, {
        tenantId,
        actorType: "user",
        actorId: ctx.user.id,
        actorLabel: ctx.user.email,
        ...entry,
      });
    }

    revalidatePath("/clients");
    revalidatePath("/campaigns");

    return success({
      tenantId,
      campaignId,
      token: minted.token,
      appWebhookUrl: hubspotAppWebhookUrl(env().APP_URL),
      webhookUrl: hubspotWebhookUrl(env().APP_URL, campaignId),
      blockers: activationBlockers({
        script: template.script,
        questions: template.questions.length,
        googleSheetId: null,
        hubspotIntegrationId: null,
      }),
    });
  });
}

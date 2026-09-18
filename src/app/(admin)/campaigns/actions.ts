"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, success, tenantAction, type ActionResult } from "@/lib/actions";
import {
  CampaignConfigSchema,
  ConsentDeclarationSchema,
  activationBlockers,
  loadCampaignConfig,
  saveCampaignConfig,
} from "@/lib/campaigns/config";

/**
 * Campaign configuration actions (PRD 22 Phase 2).
 *
 * Nothing here gates calling on a compliance sign-off - consent is collected
 * upstream in the client's funnel and recorded on each lead at intake. The
 * `declareConsentBasis`, `approveCompliance` and `revokeCompliance` actions
 * below are kept, unused by the UI, for a client that later needs a named
 * attestation on file. They no longer stop a campaign from dialling.
 */

export async function saveCampaign(
  tenantId: string,
  campaignId: string,
  raw: unknown,
  changeNote: string | null,
): Promise<ActionResult<{ version: number }>> {
  const parsed = CampaignConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid configuration", issue?.path.join("."));
  }

  return tenantAction({ tenantId, permission: "campaign:write" }, async (ctx) => {
    const before = await loadCampaignConfig(ctx.tx, campaignId);
    if (!before) return failure("Not found");

    const version = await saveCampaignConfig(ctx.tx, {
      tenantId,
      campaignId,
      config: parsed.data,
      userId: ctx.user.id,
      changeNote,
    });

    await ctx.audit({
      action: "campaign.updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: {
        version,
        note: changeNote,
        changed: changedKeys(before, parsed.data),
      },
    });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
    return success({ version });
  });
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

const Declare = z.object({
  tenantId: z.string().uuid(),
  campaignId: z.string().uuid(),
  basis: ConsentDeclarationSchema.shape.basis,
  source: ConsentDeclarationSchema.shape.source,
  evidenceRef: z.string().max(300).nullable(),
});

/**
 * PRD 14.3 step 10: record the consent basis for this client's lead list.
 *
 * PRD 26.1 is blunt about why this is a separate, attributed action: "A
 * client's verbal assurance that 'leads are opted in' is not sufficient
 * evidence on its own." Whoever records it is named in the row.
 */
export async function declareConsentBasis(formData: FormData): Promise<ActionResult> {
  const parsed = Declare.safeParse({
    tenantId: formData.get("tenantId"),
    campaignId: formData.get("campaignId"),
    basis: formData.get("basis"),
    source: formData.get("source"),
    evidenceRef: formData.get("evidenceRef") || null,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid input", issue?.path.join("."));
  }

  const { tenantId, campaignId, basis, source, evidenceRef } = parsed.data;

  return tenantAction({ tenantId, permission: "campaign:write" }, async (ctx) => {
    await ctx.tx.query(
      `update campaigns set
          consent_basis = $3, consent_source = $4, consent_evidence_ref = $5,
          consent_declared_by = $6, consent_declared_at = now()
        where id = $1 and tenant_id = $2`,
      [campaignId, tenantId, basis, source, evidenceRef, ctx.user.id],
    );

    await ctx.audit({
      action: "campaign.consent_declared",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { basis, source, evidence_ref: evidenceRef },
    });

    revalidatePath(`/campaigns/${campaignId}`);
    return success();
  });
}

const Approve = z.object({
  tenantId: z.string().uuid(),
  campaignId: z.string().uuid(),
  attestation: z.string().min(20).max(2000),
});

/**
 * PRD 17.3's compliance gate.
 *
 * "Do not activate India outbound campaigns until a telecom/compliance review
 * confirms the agency's own sender/telemarketer registration and calling
 * category, the consent basis and evidence supplied for the client's lead
 * list, provider arrangement, DNC handling, recording notices, and retention
 * requirements."
 *
 * No longer a precondition for calling. Kept so a client who needs a named
 * person on record can still produce one, and restricted to
 * `compliance:approve`, which only the Agency Admin holds.
 */
export async function approveCompliance(formData: FormData): Promise<ActionResult> {
  const parsed = Approve.safeParse({
    tenantId: formData.get("tenantId"),
    campaignId: formData.get("campaignId"),
    attestation: formData.get("attestation"),
  });

  if (!parsed.success) {
    return failure(
      "Record what was reviewed and by whom, in at least a sentence.",
      "attestation",
    );
  }

  const { tenantId, campaignId, attestation } = parsed.data;

  return tenantAction({ tenantId, permission: "compliance:approve" }, async (ctx) => {
    const r = await ctx.tx.query(
      `update campaigns set compliance_approved_at = now(), compliance_approved_by = $3
        where id = $1 and tenant_id = $2 and consent_basis is not null`,
      [campaignId, tenantId, ctx.user.id],
    );

    if (r.rowCount === 0) {
      return failure(
        "Record the consent basis for this client's lead list before approving (PRD 14.3 step 10)",
      );
    }

    await ctx.audit({
      action: "campaign.compliance_approved",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { attestation },
    });

    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/campaigns");
    return success();
  });
}

export async function revokeCompliance(formData: FormData): Promise<ActionResult> {
  const tenantId = String(formData.get("tenantId"));
  const campaignId = String(formData.get("campaignId"));
  const reason = String(formData.get("reason") ?? "");

  return tenantAction({ tenantId, permission: "compliance:approve" }, async (ctx) => {
    // Revoking still stops the campaign. Nothing else reads the approval now,
    // so pausing is the only way this can mean anything.
    await ctx.tx.query(
      `update campaigns
          set compliance_approved_at = null, compliance_approved_by = null, active = false
        where id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );

    await ctx.audit({
      action: "campaign.compliance_revoked",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { reason },
    });

    revalidatePath(`/campaigns/${campaignId}`);
    return success();
  });
}

const SetActive = z.object({
  tenantId: z.string().uuid(),
  campaignId: z.string().uuid(),
  active: z.enum(["true", "false"]),
});

/** Start or stop calling. Refuses to start while anything on the checklist is open. */
export async function setCampaignActive(formData: FormData): Promise<ActionResult> {
  const parsed = SetActive.safeParse({
    tenantId: formData.get("tenantId"),
    campaignId: formData.get("campaignId"),
    active: formData.get("active"),
  });
  if (!parsed.success) return failure("Invalid input");

  const { tenantId, campaignId } = parsed.data;
  const active = parsed.data.active === "true";

  return tenantAction({ tenantId, permission: "campaign:write" }, async (ctx) => {
    if (active) {
      const r = await ctx.tx.query<{
        script: string | null;
        google_sheet_id: string | null;
        hubspot_integration_id: string | null;
        questions: string;
      }>(
        `select c.script, c.google_sheet_id, c.hubspot_integration_id,
                (select count(*) from qualification_rules q where q.campaign_id = c.id) as questions
           from campaigns c where c.id = $1`,
        [campaignId],
      );

      const c = r.rows[0];
      if (!c) return failure("Not found");

      const blockers = activationBlockers({
        script: c.script,
        questions: Number(c.questions),
        googleSheetId: c.google_sheet_id,
        hubspotIntegrationId: c.hubspot_integration_id,
      });

      if (blockers.length > 0) return failure(blockers[0]!);
    }

    await ctx.tx.query(`update campaigns set active = $3, updated_by = $4 where id = $1 and tenant_id = $2`, [
      campaignId,
      tenantId,
      active,
      ctx.user.id,
    ]);

    await ctx.audit({
      action: active ? "campaign.activated" : "campaign.deactivated",
      entityType: "campaign",
      entityId: campaignId,
    });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
    return success();
  });
}

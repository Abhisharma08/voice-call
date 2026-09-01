import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { loadCampaignConfig, activationBlockers } from "@/lib/campaigns/config";
import { providerNames } from "@/lib/providers/voice";
import { CampaignEditor } from "./campaign-editor";
import { CompliancePanel } from "./compliance-panel";

export const dynamic = "force-dynamic";

/**
 * Campaign configuration (PRD 22 Phase 2: "Per-campaign prompts/questions/
 * scoring").
 *
 * Everything that makes one client's calls differ from another's is on this
 * page. Nothing here is code: the same workflows serve every campaign.
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.activeTenantId) notFound();

  const data = await withTenant(user, user.activeTenantId, async (tx) => {
    const config = await loadCampaignConfig(tx, id);
    if (!config) return null;

    const meta = await tx.query<{
      compliance_approved_at: Date | null;
      consent_basis: string | null;
      consent_source: string | null;
      consent_evidence_ref: string | null;
      consent_declared_at: Date | null;
      declared_by_email: string | null;
      approved_by_email: string | null;
    }>(
      `select c.compliance_approved_at, c.consent_basis, c.consent_source,
              c.consent_evidence_ref, c.consent_declared_at,
              d.email as declared_by_email, a.email as approved_by_email
         from campaigns c
         left join users d on d.id = c.consent_declared_by
         left join users a on a.id = c.compliance_approved_by
        where c.id = $1`,
      [id],
    );

    const integrations = await tx.query<{ id: string; name: string; type: string; status: string }>(
      `select id, name, type, status from integrations where type = 'hubspot' order by name`,
    );

    const versions = await tx.query<{
      version: number;
      created_at: Date;
      change_note: string | null;
      email: string | null;
    }>(
      `select v.version, v.created_at, v.change_note, u.email
         from campaign_versions v
         left join users u on u.id = v.changed_by
        where v.campaign_id = $1
        order by v.version desc limit 10`,
      [id],
    );

    return {
      config,
      meta: meta.rows[0]!,
      hubspotIntegrations: integrations.rows,
      versions: versions.rows.map((v) => ({
        version: v.version,
        createdAt: v.created_at.toISOString(),
        note: v.change_note,
        by: v.email,
      })),
    };
  });

  if (!data) notFound();

  const blockers = activationBlockers({
    complianceApprovedAt: data.meta.compliance_approved_at,
    consentBasis: data.meta.consent_basis,
    script: data.config.script,
    questions: data.config.questions.length,
    googleSheetId: data.config.googleSheetId,
    hubspotIntegrationId: data.config.hubspotIntegrationId,
  });

  return (
    <>
      <h1 className="page-title">{data.config.name}</h1>
      <p className="page-sub">
        Configuration version {data.config.configVersion}. Each call records the version it ran under,
        so a result can always be traced to the script that produced it.
      </p>

      <CompliancePanel
        tenantId={user.activeTenantId}
        campaignId={id}
        active={data.config.active}
        blockers={blockers}
        consent={{
          basis: data.meta.consent_basis,
          source: data.meta.consent_source,
          evidenceRef: data.meta.consent_evidence_ref,
          declaredAt: data.meta.consent_declared_at?.toISOString() ?? null,
          declaredBy: data.meta.declared_by_email,
        }}
        approval={{
          approvedAt: data.meta.compliance_approved_at?.toISOString() ?? null,
          approvedBy: data.meta.approved_by_email,
        }}
        canConfigure={can(user.role, "campaign:write")}
        canApprove={can(user.role, "compliance:approve")}
      />

      <CampaignEditor
        tenantId={user.activeTenantId}
        campaignId={id}
        initial={data.config}
        providers={providerNames()}
        hubspotIntegrations={data.hubspotIntegrations}
        versions={data.versions}
        readOnly={!can(user.role, "campaign:write")}
      />
    </>
  );
}

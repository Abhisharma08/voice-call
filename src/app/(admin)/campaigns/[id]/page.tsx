import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { loadCampaignConfig, activationBlockers } from "@/lib/campaigns/config";
import { providersForTenant } from "@/lib/providers/voice/tenant";
import { CampaignEditor } from "./campaign-editor";
import { CallingStatus } from "./calling-status";

export const dynamic = "force-dynamic";

/**
 * Campaign configuration: per-campaign prompts, questions and scoring.
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
      // Includes anything this client has its own credential for, not only
      // what the process registered from the environment.
      providers: await providersForTenant(tx),
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

      <CallingStatus
        tenantId={user.activeTenantId}
        campaignId={id}
        active={data.config.active}
        blockers={blockers}
        canConfigure={can(user.role, "campaign:write")}
      />

      <CampaignEditor
        tenantId={user.activeTenantId}
        campaignId={id}
        initial={data.config}
        providers={data.providers}
        hubspotIntegrations={data.hubspotIntegrations}
        versions={data.versions}
        readOnly={!can(user.role, "campaign:write")}
      />
    </>
  );
}

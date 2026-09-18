import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { NewCampaignForm } from "./new-campaign-form";

export const dynamic = "force-dynamic";

/**
 * Campaign list (PRD 22 Phase 2: "Multiple campaigns").
 *
 * One client can run several campaigns, each with its own script, questions,
 * scoring and calling hours - that is the whole point of the configuration
 * model. Each row shows whether it can actually dial, because "active" and
 * "allowed to call" are different things here (PRD 17.3).
 */
export default async function CampaignsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Campaigns</h1>
        <p className="page-sub">Scripts, qualification questions, scoring and calling windows.</p>
        <div className="empty">Select a client from the sidebar to see its campaigns.</div>
      </>
    );
  }

  const campaigns = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      name: string;
      domain: string | null;
      active: boolean;
      config_version: number;
      voice_provider: string;
      timezone: string;
      calling_config: { window_start?: string; window_end?: string };
      dial_allowlist: string[];
      questions: string;
      leads: string;
      queued: string;
    }>(
      `select c.id, c.name, c.domain, c.active, c.config_version,
              c.voice_provider, c.timezone,
              c.calling_config, c.dial_allowlist,
              (select count(*) from qualification_rules q where q.campaign_id = c.id) as questions,
              (select count(*) from leads l where l.campaign_id = c.id)               as leads,
              (select count(*) from leads l where l.campaign_id = c.id and l.status = 'queued') as queued
         from campaigns c
        order by c.name`,
    );
    return r.rows;
  });

  return (
    <>
      <h1 className="page-title">Campaigns</h1>
      <p className="page-sub">
        Each campaign carries its own script, questions and calling hours.
      </p>

      {campaigns.length === 0 ? (
        <div className="empty">No campaigns yet for this client.</div>
      ) : (
        <div className="stack">
          {campaigns.map((c) => {
            const dialable = c.active;
            return (
              <div key={c.id} className="card stack" style={{ gap: 8 }}>
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <Link href={`/campaigns/${c.id}`} style={{ fontWeight: 600 }}>
                    {c.name}
                  </Link>
                  <span className={`pill ${dialable ? "ok" : "warn"}`}>
                    {dialable ? "calling" : "paused"}
                  </span>
                  <div className="spacer" />
                  <span className="pill">v{c.config_version}</span>
                </div>

                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {c.domain ? <span className="pill">{c.domain}</span> : null}
                  <span className="pill">{c.questions} questions</span>
                  <span className="pill">
                    {c.calling_config?.window_start ?? "?"}&ndash;{c.calling_config?.window_end ?? "?"}{" "}
                    {c.timezone}
                  </span>
                  <span className="pill">{c.voice_provider}</span>
                  <span className="pill">{c.leads} leads</span>
                  {Number(c.queued) > 0 ? <span className="pill">{c.queued} queued</span> : null}
                  {c.dial_allowlist.length > 0 ? (
                    <span className="pill warn">
                      allowlist: {c.dial_allowlist.length} number
                      {c.dial_allowlist.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>

              </div>
            );
          })}
        </div>
      )}

      {can(user.role, "campaign:write") ? (
        <div style={{ marginTop: 20 }}>
          <NewCampaignForm tenantId={user.activeTenantId} />
        </div>
      ) : null}
    </>
  );
}

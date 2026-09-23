import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { LeadsTable, type LeadRow } from "./leads-table";

export const dynamic = "force-dynamic";

/**
 * Lead list.
 *
 * Phone and email are masked in list views and unmasked only on an explicit
 * detail-view action, so this query never selects the encrypted
 * columns at all - only `phone_last4`, which is stored separately for exactly
 * this purpose. A reveal is a separate, audited request.
 */
export default async function LeadsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Leads</h1>
        <p className="page-sub">Contact identity, status and call history.</p>
        <div className="empty">Select a client from the sidebar to see its leads.</div>
      </>
    );
  }

  const leads = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      status: string;
      status_reason: string | null;
      phone_last4: string | null;
      source: string | null;
      dnc: boolean;
      call_attempt_count: number;
      next_call_at: Date | null;
      created_at: Date;
      campaign_name: string | null;
      has_consent: boolean;
      latest_intent: string | null;
      latest_score: number | null;
    }>(
      `select l.id, l.status, l.status_reason, l.phone_last4, l.source, l.dnc,
              l.call_attempt_count, l.next_call_at, l.created_at,
              c.name as campaign_name,
              exists (select 1 from consents co
                       where co.lead_id = l.id and co.status = 'active') as has_consent,
              an.intent as latest_intent, an.score as latest_score
         from leads l
         left join campaigns c on c.id = l.campaign_id
         left join lateral (
           select a.intent, a.score
             from call_analyses a
             join call_attempts ca on ca.id = a.call_id
            where ca.lead_id = l.id
            order by a.created_at desc
            limit 1
         ) an on true
        order by l.created_at desc
        limit 200`,
    );

    return r.rows.map<LeadRow>((row) => ({
      id: row.id,
      status: row.status,
      statusReason: row.status_reason,
      phoneLast4: row.phone_last4,
      source: row.source,
      dnc: row.dnc,
      attempts: row.call_attempt_count,
      nextCallAt: row.next_call_at ? row.next_call_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
      campaignName: row.campaign_name,
      hasConsent: row.has_consent,
      intent: row.latest_intent,
      score: row.latest_score,
    }));
  });

  return (
    <>
      <h1 className="page-title">Leads</h1>
      <p className="page-sub">
        {leads.length} lead{leads.length === 1 ? "" : "s"}. Phone numbers are masked until explicitly
        revealed, and every reveal is logged.
      </p>

      {leads.length === 0 ? (
        <div className="empty">
          No leads yet. Post one to <code>/api/webhooks/leads</code> with a service token.
        </div>
      ) : (
        <LeadsTable
          leads={leads}
          tenantId={user.activeTenantId}
          canReveal={can(user.role, "pii:reveal")}
        />
      )}
    </>
  );
}

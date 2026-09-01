import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { ReviewList, type ReviewItem } from "./review-list";

export const dynamic = "force-dynamic";

/**
 * The human-review queue (PRD 26.3).
 *
 * Everything listed here is excluded from HubSpot and Sheets until an operator
 * resolves it. PRD 26.3: the agency's Operations Manager "is the only
 * checkpoint between an AI qualification call and the client's sales
 * pipeline - there is no client-side review to catch a bad result
 * downstream."
 */
export default async function ReviewPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Review Queue</h1>
        <p className="page-sub">Low-confidence qualifications held from CRM sync.</p>
        <div className="empty">Select a client from the sidebar to see its review queue.</div>
      </>
    );
  }

  const items = await withTenant(user, user.activeTenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      call_id: string;
      lead_id: string;
      intent: string;
      score: number | null;
      confidence: string | null;
      review_reason: string | null;
      created_at: Date;
      structured_payload: Record<string, unknown>;
      phone_last4: string | null;
      campaign_name: string | null;
      duration_sec: number | null;
    }>(
      `select an.id, an.call_id, ca.lead_id, an.intent, an.score, an.confidence,
              an.review_reason, an.created_at, an.structured_payload,
              l.phone_last4, c.name as campaign_name, ca.duration_sec
         from call_analyses an
         join call_attempts ca on ca.id = an.call_id
         join leads l on l.id = ca.lead_id
         left join campaigns c on c.id = ca.campaign_id
        where an.review_status = 'pending_review'
        order by
          -- PRD 26.3: "hot-intent items in the backlog escalate first"
          case when an.intent in ('hot','interested') then 0 else 1 end,
          an.created_at
        limit 100`,
    );

    return r.rows.map<ReviewItem>((row) => ({
      id: row.id,
      callId: row.call_id,
      leadId: row.lead_id,
      intent: row.intent,
      score: row.score ?? 0,
      confidence: row.confidence === null ? null : Number(row.confidence),
      reviewReason: row.review_reason,
      createdAt: row.created_at.toISOString(),
      summary: String(row.structured_payload.summary ?? ""),
      reason: String(row.structured_payload.reason ?? ""),
      phoneLast4: row.phone_last4,
      campaignName: row.campaign_name,
      durationSec: row.duration_sec,
      payload: row.structured_payload,
    }));
  });

  return (
    <>
      <h1 className="page-title">Review Queue</h1>
      <p className="page-sub">
        {items.length === 0
          ? "Nothing held for review."
          : `${items.length} result${items.length === 1 ? "" : "s"} held from HubSpot and Google Sheets until resolved.`}
      </p>

      {items.length === 0 ? (
        <div className="empty">
          Results below the campaign confidence threshold, missing required answers, or scoring near a
          routing boundary land here instead of syncing automatically.
        </div>
      ) : (
        <ReviewList
          items={items}
          tenantId={user.activeTenantId}
          canResolve={can(user.role, "review:resolve")}
        />
      )}
    </>
  );
}

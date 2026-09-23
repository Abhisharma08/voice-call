import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { withGlobalScope, withTenant } from "@/lib/auth/tenant";
import { hasGlobalScope } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

/**
 * Dashboard: the five numbers an operator checks first, each linking to the
 * page that acts on it.
 *
 * Note the query path: every read goes through withTenant/withGlobalScope, so
 * the RLS predicate - not a WHERE clause someone might forget - is what keeps
 * one client's numbers out of another's dashboard.
 */

interface Counts {
  leads: number;
  campaigns: number;
  pendingReview: number;
  callbacksDue: number;
  syncBacklog: number;
}

const COUNT_SQL = `
  select
    (select count(*) from leads)                                              as leads,
    (select count(*) from campaigns where active)                             as campaigns,
    (select count(*) from call_analyses where review_status = 'pending_review') as pending_review,
    (select count(*) from callbacks
      where status = 'scheduled' and scheduled_for < now() + interval '1 day') as callbacks_due,
    (select count(*) from sync_outbox where status in ('pending','failed'))    as sync_backlog`;

export default async function DashboardPage() {
  const user = await requireUser();

  let counts: Counts | null = null;
  let scopeLabel: string;

  if (user.activeTenantId) {
    scopeLabel = "Scoped to the selected client";
    counts = await withTenant(user, user.activeTenantId, async (tx) => {
      const r = await tx.query(COUNT_SQL);
      const row = r.rows[0];
      return {
        leads: Number(row.leads),
        campaigns: Number(row.campaigns),
        pendingReview: Number(row.pending_review),
        callbacksDue: Number(row.callbacks_due),
        syncBacklog: Number(row.sync_backlog),
      };
    });
  } else if (hasGlobalScope(user.role)) {
    scopeLabel = "All clients";
    counts = await withGlobalScope(user, async (tx) => {
      const r = await tx.query(COUNT_SQL);
      const row = r.rows[0];
      return {
        leads: Number(row.leads),
        campaigns: Number(row.campaigns),
        pendingReview: Number(row.pending_review),
        callbacksDue: Number(row.callbacks_due),
        syncBacklog: Number(row.sync_backlog),
      };
    });
  } else {
    scopeLabel = "No client selected";
  }

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">{scopeLabel}</p>

      {counts ? (
        <div className="grid">
          <Stat title="Leads" value={counts.leads} note="All statuses" href="/leads" />
          <Stat title="Active campaigns" value={counts.campaigns} note="Calling now" href="/campaigns" />
          <Stat
            title="Pending review"
            value={counts.pendingReview}
            note="Waiting on a person"
            href="/review"
          />
          <Stat title="Callbacks due" value={counts.callbacksDue} note="Next 24 hours" href="/callbacks" />
          <Stat
            title="Sync backlog"
            value={counts.syncBacklog}
            note="Not yet in HubSpot or Sheets"
            href="/integrations"
          />
        </div>
      ) : (
        <div className="empty">
          Select a client from the sidebar to see its queue, calls and review backlog.
        </div>
      )}
    </>
  );
}

function Stat({
  title,
  value,
  note,
  href,
}: {
  title: string;
  value: number;
  note: string;
  href: string;
}) {
  return (
    <Link href={href} className="card">
      <h3>{title}</h3>
      <div className="value">{value.toLocaleString()}</div>
      <div className="note">{note}</div>
    </Link>
  );
}

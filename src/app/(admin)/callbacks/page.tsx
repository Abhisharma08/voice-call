import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { listOutstanding, listResolved, type CallbackRow } from "@/lib/calling/callbacks";
import { AccessDenied } from "../access-denied";
import { CallbackList, type CallbackItem } from "./callback-list";

export const dynamic = "force-dynamic";

/**
 * The callback worklist.
 *
 * A callback is the one promise this platform makes on the client's behalf
 * during a call: we will ring you back at that time. The queue keeps it by
 * itself in the ordinary case - the requested time lands on the lead's
 * `next_call_at` and the sweep dials it - so what belongs on this page is the
 * exceptions: what is overdue, what the dialler could not keep, and what an
 * operator has to close by hand.
 */
export default async function CallbacksPage() {
  const user = await requireUser();

  if (!can(user.role, "call:read")) {
    return <AccessDenied title="Callbacks" needs="call:read" />;
  }

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Callbacks</h1>
        <p className="page-sub">Calls a lead asked us to make at a particular time.</p>
        <div className="empty">Select a client from the sidebar to see its callbacks.</div>
      </>
    );
  }

  const tenantId = user.activeTenantId;

  const { outstanding, resolved } = await withTenant(user, tenantId, async (tx) => ({
    outstanding: await listOutstanding(tx),
    resolved: await listResolved(tx, 30),
  }));

  const now = Date.now();
  const overdue = outstanding.filter((c) => c.scheduledFor.getTime() < now).length;

  return (
    <>
      <h1 className="page-title">Callbacks</h1>
      <p className="page-sub">
        {outstanding.length === 0
          ? "Nothing outstanding. A callback appears here the moment a lead asks for one."
          : `${outstanding.length} outstanding${overdue > 0 ? `, ${overdue} past its time` : ""}. ` +
            "The dialler places these automatically; this is where the ones it could not are picked up."}
      </p>

      <CallbackList
        outstanding={outstanding.map(toItem)}
        resolved={resolved.map(toItem)}
        tenantId={tenantId}
        canWrite={can(user.role, "callback:write")}
      />
    </>
  );
}

function toItem(row: CallbackRow): CallbackItem {
  return {
    id: row.id,
    leadId: row.leadId,
    scheduledFor: row.scheduledFor.toISOString(),
    requestedAt: row.requestedAt.toISOString(),
    status: row.status,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByEmail: row.resolvedByEmail,
    note: row.note,
    phoneLast4: row.phoneLast4,
    campaignName: row.campaignName,
    leadStatus: row.leadStatus,
    leadNextCallAt: row.leadNextCallAt ? row.leadNextCallAt.toISOString() : null,
    attempts: row.attempts,
    intent: row.intent,
    summary: row.summary,
  };
}

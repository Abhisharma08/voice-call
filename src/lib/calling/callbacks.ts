import type { PoolClient } from "pg";
import { auditInTx } from "@/lib/audit";

/**
 * Callbacks as work (FR-043).
 *
 * A callback row is created when a lead asks to be called at a particular
 * time. Two separate things then have to happen, and keeping them apart is the
 * whole design here:
 *
 *   - The *call* is driven by `leads.next_call_at`, which `applyRetryDecision`
 *     already sets from the requested time. The queue knows nothing about this
 *     table.
 *   - The *promise* is this row. It stays outstanding until a call actually
 *     goes out after the requested time, or an operator resolves it, or the
 *     sweep decides it was missed.
 *
 * Tying the two together would mean the queue reading a second table on every
 * claim, and an operator's "mark done" silently cancelling a real queued call.
 * Instead the row follows what the dialler did.
 */

/** How long after the requested time a callback is still merely late, not missed. */
export const MISSED_GRACE_MINUTES = 120;

export const RESOLUTIONS = ["completed", "missed", "canceled"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface CallbackRow {
  id: string;
  leadId: string;
  callId: string | null;
  scheduledFor: Date;
  requestedAt: Date;
  status: string;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
  note: string | null;
  phoneLast4: string | null;
  campaignName: string | null;
  leadStatus: string;
  leadNextCallAt: Date | null;
  attempts: number;
  intent: string | null;
  summary: string | null;
}

const SELECT = `
  select cb.id, cb.lead_id, cb.call_id, cb.scheduled_for, cb.requested_at, cb.status,
         cb.resolved_at, cb.note,
         u.email as resolved_by_email,
         l.phone_last4, l.status as lead_status, l.next_call_at as lead_next_call_at,
         l.call_attempt_count as attempts,
         c.name as campaign_name,
         an.intent, an.structured_payload ->> 'summary' as summary
    from callbacks cb
    join leads l on l.id = cb.lead_id
    left join users u on u.id = cb.resolved_by
    left join campaigns c on c.id = l.campaign_id
    left join call_analyses an on an.call_id = cb.call_id`;

interface RawRow {
  id: string;
  lead_id: string;
  call_id: string | null;
  scheduled_for: Date;
  requested_at: Date;
  status: string;
  resolved_at: Date | null;
  resolved_by_email: string | null;
  note: string | null;
  phone_last4: string | null;
  campaign_name: string | null;
  lead_status: string;
  lead_next_call_at: Date | null;
  attempts: number;
  intent: string | null;
  summary: string | null;
}

function toRow(row: RawRow): CallbackRow {
  return {
    id: row.id,
    leadId: row.lead_id,
    callId: row.call_id,
    scheduledFor: row.scheduled_for,
    requestedAt: row.requested_at,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolvedByEmail: row.resolved_by_email,
    note: row.note,
    phoneLast4: row.phone_last4,
    campaignName: row.campaign_name,
    leadStatus: row.lead_status,
    leadNextCallAt: row.lead_next_call_at,
    attempts: row.attempts,
    intent: row.intent,
    summary: row.summary,
  };
}

/** Everything still owed: overdue first, then soonest. */
export async function listOutstanding(tx: PoolClient, limit = 200): Promise<CallbackRow[]> {
  const r = await tx.query<RawRow>(
    `${SELECT} where cb.status = 'scheduled' order by cb.scheduled_for limit $1`,
    [limit],
  );
  return r.rows.map(toRow);
}

/** Recently closed, whichever way it went. */
export async function listResolved(tx: PoolClient, limit = 50): Promise<CallbackRow[]> {
  const r = await tx.query<RawRow>(
    `${SELECT} where cb.status <> 'scheduled'
      order by coalesce(cb.resolved_at, cb.scheduled_for) desc limit $1`,
    [limit],
  );
  return r.rows.map(toRow);
}

/**
 * Close a callback by hand.
 *
 * Deliberately does not touch the lead. An operator saying "I called them" is
 * a statement about the promise, not an instruction to the dialler, and
 * cancelling a queued call from here would be a surprise. Cancelling the call
 * too is `stopCalling`, which the UI offers as its own choice.
 */
export async function resolveCallback(
  tx: PoolClient,
  args: {
    tenantId: string;
    callbackId: string;
    resolution: Resolution;
    userId: string;
    userEmail: string;
    note: string | null;
  },
): Promise<boolean> {
  const r = await tx.query<{ id: string; lead_id: string; status: string }>(
    `update callbacks
        set status = $2::callback_status, resolved_at = now(), resolved_by = $3, note = $4
      where id = $1 and status = 'scheduled'
      returning id, lead_id, status`,
    [args.callbackId, args.resolution, args.userId, args.note],
  );

  const row = r.rows[0];
  if (!row) return false;

  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "user",
    actorId: args.userId,
    actorLabel: args.userEmail,
    action: "callback.resolved",
    entityType: "callback",
    entityId: row.id,
    metadata: { lead_id: row.lead_id, resolution: args.resolution, note: args.note },
  });

  return true;
}

/**
 * Move a callback, and move the call with it.
 *
 * This one *does* write to the lead, because a requested time that the dialler
 * does not honour is not a reschedule - it is a note. The lead only goes back
 * on the queue if it is in a state the queue will look at; a suppressed or
 * closed lead keeps its status and the caller is told, rather than being
 * quietly resurrected past a DNC.
 */
export async function rescheduleCallback(
  tx: PoolClient,
  args: {
    tenantId: string;
    callbackId: string;
    scheduledFor: Date;
    userId: string;
    userEmail: string;
  },
): Promise<{ ok: false } | { ok: true; leadRequeued: boolean; leadStatus: string }> {
  const r = await tx.query<{ id: string; lead_id: string }>(
    `update callbacks set scheduled_for = $2
      where id = $1 and status = 'scheduled'
      returning id, lead_id`,
    [args.callbackId, args.scheduledFor],
  );

  const row = r.rows[0];
  if (!row) return { ok: false };

  const lead = await tx.query<{ status: string }>(
    `update leads
        set next_call_at = $2, status = 'queued', status_reason = 'callback_rescheduled',
            locked_by = null, locked_at = null, lock_expires_at = null
      where id = $1
        and status in ('queued', 'new', 'closed', 'failed', 'qualified')
      returning status`,
    [row.lead_id, args.scheduledFor],
  );

  const requeued = (lead.rowCount ?? 0) > 0;

  const current = requeued
    ? "queued"
    : (
        await tx.query<{ status: string }>(`select status from leads where id = $1`, [row.lead_id])
      ).rows[0]?.status ?? "unknown";

  await auditInTx(tx, {
    tenantId: args.tenantId,
    actorType: "user",
    actorId: args.userId,
    actorLabel: args.userEmail,
    action: "callback.rescheduled",
    entityType: "callback",
    entityId: row.id,
    metadata: {
      lead_id: row.lead_id,
      scheduled_for: args.scheduledFor.toISOString(),
      lead_requeued: requeued,
      lead_status: current,
    },
  });

  return { ok: true, leadRequeued: requeued, leadStatus: current };
}

/**
 * A call went out. Any callback it satisfies is now kept.
 *
 * Called from the dialler rather than from the result webhook: the promise was
 * "we will call you back", and we did. Whether they answered is the retry
 * ladder's problem, and a no-answer that re-queues the lead does not leave the
 * operator with a callback to chase by hand.
 *
 * A callback already swept to 'missed' is revived to 'completed' here - the
 * call was late, not absent, and the row should say what happened rather than
 * what the sweep predicted.
 */
export async function fulfilCallbacksForLead(
  tx: PoolClient,
  args: { tenantId: string; leadId: string; callId: string; now?: Date },
): Promise<number> {
  const now = args.now ?? new Date();

  const r = await tx.query<{ id: string }>(
    `update callbacks
        set status = 'completed', resolved_at = now(), fulfilled_call_id = $2,
            resolved_by = null
      where lead_id = $1
        and status in ('scheduled', 'missed')
        and scheduled_for <= $3
      returning id`,
    [args.leadId, args.callId, now],
  );

  for (const row of r.rows) {
    await auditInTx(tx, {
      tenantId: args.tenantId,
      actorType: "service",
      action: "callback.fulfilled",
      entityType: "callback",
      entityId: row.id,
      metadata: { lead_id: args.leadId, call_id: args.callId },
    });
  }

  return r.rowCount ?? 0;
}

/**
 * The sweep's verdict on callbacks nobody kept.
 *
 * Two conditions, both necessary. The grace period stops a callback being
 * called missed while the pass that would place its call is still minutes
 * away. The "no attempt since it was due" check stops a call that *did* go out
 * - and was already counted by `fulfilCallbacksForLead` - from being
 * contradicted by a later sweep.
 *
 * Runs under global scope from the cron sweep, so it names the tenant on every
 * row it writes rather than relying on a scoped connection. `tenantId` narrows
 * it to one client - which the sweep does not need, but a test running against
 * a shared database does, since a global pass would otherwise resolve rows the
 * test never created.
 */
export async function markMissedCallbacks(
  tx: PoolClient,
  args: { graceMinutes?: number; limit?: number; tenantId?: string } = {},
): Promise<Array<{ id: string; tenantId: string; leadId: string }>> {
  const grace = args.graceMinutes ?? MISSED_GRACE_MINUTES;

  const r = await tx.query<{ id: string; tenant_id: string; lead_id: string }>(
    `update callbacks cb
        set status = 'missed', resolved_at = now()
      where cb.id in (
        select c2.id from callbacks c2
         where c2.status = 'scheduled'
           and c2.scheduled_for < now() - ($1 || ' minutes')::interval
           and ($3::uuid is null or c2.tenant_id = $3)
           and not exists (
             select 1 from call_attempts ca
              where ca.lead_id = c2.lead_id and ca.started_at >= c2.scheduled_for
           )
         order by c2.scheduled_for
         limit $2
      )
      returning cb.id, cb.tenant_id, cb.lead_id`,
    [String(grace), args.limit ?? 200, args.tenantId ?? null],
  );

  for (const row of r.rows) {
    await auditInTx(tx, {
      tenantId: row.tenant_id,
      actorType: "service",
      actorLabel: "cron",
      action: "callback.missed",
      entityType: "callback",
      entityId: row.id,
      metadata: { lead_id: row.lead_id, grace_minutes: grace },
    });
  }

  return r.rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, leadId: row.lead_id }));
}

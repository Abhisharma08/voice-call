import type { PoolClient } from "pg";
import { backoffDelayMs } from "@/lib/calling/retry";
import { auditInTx } from "@/lib/audit";

/**
 * Transactional outbox for downstream syncs.
 *
 * A Sheets or CRM outage is survivable: the pending sync is stored in the
 * database and retried, rather than lost with the request that produced it.
 *
 * Rows are written in the same transaction as the analysis they describe, so a
 * committed result always has its sync work queued - the two cannot diverge.
 * A worker then drains them with backoff. The dedupe key
 * (call_id for Sheets), enforced by a unique index rather than by the caller
 * remembering.
 */

export type SyncTarget = "hubspot" | "google_sheets" | "notification";

export const MAX_SYNC_ATTEMPTS = 8;

export async function enqueueSync(
  tx: PoolClient,
  args: {
    tenantId: string;
    target: SyncTarget;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `insert into sync_outbox (tenant_id, target, dedupe_key, payload)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, target, dedupe_key) do nothing`,
    [args.tenantId, args.target, args.dedupeKey, JSON.stringify(args.payload)],
  );
}

export interface OutboxItem {
  id: string;
  tenantId: string;
  target: SyncTarget;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Claim due work, skipping rows another worker already holds. */
export async function claimDueSyncs(
  tx: PoolClient,
  limit = 20,
): Promise<OutboxItem[]> {
  const r = await tx.query<{
    id: string;
    tenant_id: string;
    target: SyncTarget;
    dedupe_key: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `update sync_outbox
        set status = 'in_flight', attempts = attempts + 1
      where id in (
        select id from sync_outbox
         where status in ('pending', 'failed')
           and next_attempt_at <= now()
         order by next_attempt_at
         limit $1
         for update skip locked
      )
      returning id, tenant_id, target, dedupe_key, payload, attempts`,
    [limit],
  );

  return r.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    target: row.target,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

export async function markSyncSucceeded(tx: PoolClient, id: string): Promise<void> {
  await tx.query(
    `update sync_outbox set status = 'succeeded', completed_at = now(), last_error = null
      where id = $1`,
    [id],
  );
}

export async function markSyncFailed(
  tx: PoolClient,
  args: { id: string; tenantId: string; attempts: number; error: string; retryable: boolean },
): Promise<void> {
  // An auth failure is not retryable - retrying it just burns the
  // rate limit and delays the alert. It goes straight to dead-letter.
  const exhausted = !args.retryable || args.attempts >= MAX_SYNC_ATTEMPTS;

  await tx.query(
    `update sync_outbox
        set status = $2,
            last_error = $3,
            next_attempt_at = now() + make_interval(secs => $4)
      where id = $1`,
    [
      args.id,
      exhausted ? "dead_letter" : "failed",
      args.error.slice(0, 1000),
      exhausted ? 0 : backoffDelayMs(args.attempts) / 1000,
    ],
  );

  if (exhausted) {
    // Dead-letter state exists for records requiring manual replay,
    // and it must be visible rather than silent.
    await auditInTx(tx, {
      tenantId: args.tenantId,
      actorType: "system",
      action: "sync.dead_lettered",
      entityType: "sync_outbox",
      entityId: args.id,
      metadata: { attempts: args.attempts, error: args.error.slice(0, 500), retryable: args.retryable },
    });
  }
}

/** Operator action: put a dead-lettered row back in the queue. */
export async function replaySync(tx: PoolClient, id: string): Promise<boolean> {
  const r = await tx.query(
    `update sync_outbox
        set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
      where id = $1 and status = 'dead_letter'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

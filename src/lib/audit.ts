import type { PoolClient } from "pg";
import { withScope, withoutScope } from "@/db/client";
import { logger } from "@/lib/observability/log";

/**
 * Audit trail (PRD 17.1, 26.2).
 *
 * PRD 17.1 requires configuration changes, manual suppression, routing changes
 * and data exports to be audited. PRD 26.2 goes further for sensitive reads:
 * "every read logged to audit_events" for transcripts and recordings.
 *
 * audit_events is append-only for runtime roles - migration 0002 grants
 * SELECT and INSERT but no UPDATE or DELETE - so an operator cannot erase
 * their own trail.
 */

export interface AuditEntry {
  tenantId: string | null;
  actorType: "user" | "service" | "system";
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

const INSERT = `
  insert into audit_events
    (tenant_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, metadata, ip)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

function params(entry: AuditEntry) {
  return [
    entry.tenantId,
    entry.actorType,
    entry.actorId ?? null,
    entry.actorLabel ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    JSON.stringify(entry.metadata ?? {}),
    entry.ip ?? null,
  ];
}

/**
 * Write inside an existing transaction. Prefer this: the audit row then commits
 * or rolls back with the action it describes, so the log cannot claim something
 * that never happened.
 */
export async function auditInTx(tx: PoolClient, entry: AuditEntry): Promise<void> {
  await tx.query(INSERT, params(entry));
}

/** Standalone write, for events that have no surrounding transaction (denied access, login). */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const scope =
    entry.tenantId === null
      ? { tenantId: null, globalScope: true, actorId: entry.actorId ?? null, actorType: entry.actorType }
      : {
          tenantId: entry.tenantId,
          globalScope: false,
          actorId: entry.actorId ?? null,
          actorType: entry.actorType,
        };

  try {
    await withScope(scope, (tx) => auditInTx(tx, entry));
  } catch (err) {
    // Never let an audit failure mask the original outcome, but make it loud.
    logger.error("audit write failed", {
      action: entry.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PRD 26.2: reading a phone number, transcript or recording is itself an
 * auditable event. Wrap those reads in this so the log cannot be forgotten.
 */
export async function auditedReveal<T>(
  tx: PoolClient,
  entry: Omit<AuditEntry, "action"> & { action: `pii.reveal` | `transcript.read` | `recording.read` },
  read: () => Promise<T>,
): Promise<T> {
  const value = await read();
  await auditInTx(tx, entry);
  return value;
}

/** Login and other pre-tenant events, written outside any tenant scope. */
export async function recordUnscopedAudit(entry: AuditEntry): Promise<void> {
  try {
    await withoutScope(async (tx) => {
      await tx.query(
        `select set_config('app.global_scope', 'on', true),
                set_config('app.actor_id', $1, true),
                set_config('app.actor_type', $2, true)`,
        [entry.actorId ?? "", entry.actorType],
      );
      await auditInTx(tx, entry);
    });
  } catch (err) {
    logger.error("audit write failed", {
      action: entry.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

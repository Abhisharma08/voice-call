import type { PoolClient } from "pg";
import { decryptPiiOrNull, maskPhone } from "@/lib/crypto/pii";
import type { SealedSecret } from "@/lib/crypto/kms";
import {
  claimDueSyncs,
  markSyncFailed,
  markSyncSucceeded,
  type OutboxItem,
} from "@/lib/integrations/outbox";
import { HubSpotClient, IntegrationError } from "@/lib/integrations/hubspot";
import { GoogleSheetsClient, type SheetRow } from "@/lib/integrations/google-sheets";
import { auditInTx } from "@/lib/audit";

/**
 * Drains sync_outbox (workflow W03 steps 7-9).
 *
 * One deliberate constraint runs through this file: a row is only ever built
 * from a *committed* analysis. PRD 26.3 holds pending_review results back from
 * Sheets and HubSpot, and the SQL below re-checks review_status rather than
 * trusting that the enqueue side got it right - the outbox row and the review
 * decision are written in the same transaction, but an operator can still
 * reject a result between enqueue and drain.
 */

export interface SyncDeps {
  /** Injected so tests can drive the workers without network access. */
  hubspotFactory?: (sealed: SealedSecret) => HubSpotClient;
  sheetsFactory?: (sealed: SealedSecret) => GoogleSheetsClient;
  notifier?: (payload: NotificationPayload) => Promise<void>;
}

export interface NotificationPayload {
  tenantName: string;
  campaignName: string;
  leadName: string | null;
  maskedPhone: string | null;
  intent: string;
  score: number;
  summary: string;
  callId: string;
  durationSec: number | null;
}

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function drainSyncOutbox(
  tx: PoolClient,
  deps: SyncDeps = {},
  limit = 20,
): Promise<DrainResult> {
  const items = await claimDueSyncs(tx, limit);
  const result: DrainResult = { processed: items.length, succeeded: 0, failed: 0, skipped: 0 };

  for (const item of items) {
    try {
      const handled = await dispatch(tx, item, deps);
      if (handled === "skipped") {
        result.skipped += 1;
        // Not an error: the result is held for review, so there is nothing to
        // send yet. It stays pending until the operator resolves it.
        await tx.query(
          `update sync_outbox set status = 'pending', next_attempt_at = now() + interval '5 minutes'
            where id = $1`,
          [item.id],
        );
        continue;
      }
      await markSyncSucceeded(tx, item.id);
      result.succeeded += 1;
    } catch (err) {
      const retryable = err instanceof IntegrationError ? err.retryable : true;
      await markSyncFailed(tx, {
        id: item.id,
        tenantId: item.tenantId,
        attempts: item.attempts,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      });
      result.failed += 1;

      if (err instanceof IntegrationError && !err.retryable && err.status === 401) {
        // PRD 18.2: "Auth failure - No - Alert + integration disabled."
        await disableIntegration(tx, item, err.message);
      }
    }
  }

  return result;
}

async function dispatch(
  tx: PoolClient,
  item: OutboxItem,
  deps: SyncDeps,
): Promise<"done" | "skipped"> {
  switch (item.target) {
    case "google_sheets":
      return syncSheets(tx, item, deps);
    case "hubspot":
      return syncHubSpot(tx, item, deps);
    case "notification":
      return notify(tx, item, deps);
  }
}

interface SyncContext {
  call_id: string;
  lead_id: string;
  hubspot_record_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  tenant_name: string;
  name_enc: Buffer | null;
  phone_enc: Buffer | null;
  call_status: string;
  duration_sec: number | null;
  recording_ref: string | null;
  ended_at: Date | null;
  intent: string;
  score: number | null;
  qualification: string | null;
  review_status: string;
  structured_payload: Record<string, unknown>;
  callback_requested: boolean;
  human_followup: boolean;
  do_not_call: boolean;
  next_call_at: Date | null;
  google_sheet_id: string | null;
  google_sheet_tab: string | null;
  hubspot_integration_id: string | null;
}

async function loadContext(tx: PoolClient, callId: string): Promise<SyncContext | null> {
  const r = await tx.query<SyncContext>(
    `select ca.id as call_id, ca.lead_id, l.hubspot_record_id, ca.campaign_id,
            c.name as campaign_name, t.name as tenant_name,
            l.name_enc, l.phone_enc, l.next_call_at,
            ca.status as call_status, ca.duration_sec, ca.recording_ref, ca.ended_at,
            an.intent, an.score, an.qualification, an.review_status,
            an.structured_payload, an.callback_requested, an.human_followup, an.do_not_call,
            c.google_sheet_id, c.google_sheet_tab, c.hubspot_integration_id
       from call_attempts ca
       join leads l on l.id = ca.lead_id
       join tenants t on t.id = ca.tenant_id
       left join campaigns c on c.id = ca.campaign_id
       join call_analyses an on an.call_id = ca.id
      where ca.id = $1`,
    [callId],
  );
  return r.rows[0] ?? null;
}

/** PRD 26.3: nothing leaves the platform while a result is held for review. */
function committed(ctx: SyncContext): boolean {
  return ["auto_approved", "confirmed", "corrected"].includes(ctx.review_status);
}

async function syncSheets(tx: PoolClient, item: OutboxItem, deps: SyncDeps): Promise<"done" | "skipped"> {
  const ctx = await loadContext(tx, String(item.payload.call_id));
  if (!ctx) throw new IntegrationError("Call context missing for sheets sync", false);
  if (!committed(ctx)) return "skipped";

  if (!ctx.google_sheet_id) {
    throw new IntegrationError("Campaign has no Google Sheet destination configured", false);
  }

  const payload = ctx.structured_payload as Record<string, unknown>;
  const row: SheetRow = {
    call_id: ctx.call_id,
    client_id: ctx.tenant_name,
    campaign: ctx.campaign_name ?? "",
    lead_id: ctx.lead_id,
    hubspot_record_id: ctx.hubspot_record_id ?? "",
    // PRD 26.2: the sheet lives outside the platform's access-control layer
    // once data leaves PostgreSQL, so the full number is never written there.
    name: decryptPiiOrNull(ctx.name_enc) ?? "",
    phone: maskedPhone(ctx.phone_enc) ?? "",
    call_date: (ctx.ended_at ?? new Date()).toISOString().slice(0, 10),
    duration_sec: String(ctx.duration_sec ?? 0),
    call_status: ctx.call_status,
    intent: ctx.intent,
    score: String(ctx.score ?? 0),
    qualification: ctx.qualification ?? "",
    timeline: String(payload.timeline ?? ""),
    budget: String(payload.budget ?? ""),
    location: String(payload.location ?? ""),
    callback_requested: String(ctx.callback_requested),
    human_followup: String(ctx.human_followup),
    dnc: String(ctx.do_not_call),
    summary: String(payload.summary ?? ""),
    recording_ref: ctx.recording_ref ?? "",
    sync_status: "success",
  };

  const sealed = await loadCredential(tx, ctx.campaign_id, "google_sheets");
  const client = deps.sheetsFactory
    ? deps.sheetsFactory(sealed)
    : buildClient("google_sheets", () => GoogleSheetsClient.fromSealedSecret(sealed));

  await client.appendRow({
    spreadsheetId: ctx.google_sheet_id,
    range: ctx.google_sheet_tab ?? "Call Log!A:V",
    row,
  });

  await auditInTx(tx, {
    tenantId: item.tenantId,
    actorType: "service",
    action: "sync.sheets_appended",
    entityType: "call",
    entityId: ctx.call_id,
    metadata: { spreadsheet_id: ctx.google_sheet_id },
  });

  return "done";
}

async function syncHubSpot(tx: PoolClient, item: OutboxItem, deps: SyncDeps): Promise<"done" | "skipped"> {
  const ctx = await loadContext(tx, String(item.payload.call_id));
  if (!ctx) throw new IntegrationError("Call context missing for HubSpot sync", false);
  if (!committed(ctx)) return "skipped";

  if (!ctx.hubspot_record_id) {
    throw new IntegrationError("Lead has no HubSpot record id", false);
  }

  const payload = ctx.structured_payload as Record<string, unknown>;
  const sealed = await loadCredential(tx, ctx.campaign_id, "hubspot");
  const client = deps.hubspotFactory
    ? deps.hubspotFactory(sealed)
    : buildClient("hubspot", () => HubSpotClient.fromSealedSecret(sealed));

  await client.updateContact(ctx.hubspot_record_id, {
    lastCallStatus: ctx.call_status,
    lastCallAt: (ctx.ended_at ?? new Date()).toISOString(),
    intent: ctx.intent,
    score: ctx.score ?? 0,
    qualification: ctx.qualification ?? "",
    summary: String(payload.summary ?? ""),
    callbackRequested: ctx.callback_requested,
    nextCallAt: ctx.next_call_at ? ctx.next_call_at.toISOString() : null,
    humanFollowup: ctx.human_followup,
    dnc: ctx.do_not_call,
  });

  // FR-043: a follow-up task with the call context, for the human who picks
  // this lead up.
  if (ctx.human_followup || ctx.callback_requested) {
    await client.createTask({
      contactId: ctx.hubspot_record_id,
      subject: `AI call: ${ctx.intent} (score ${ctx.score ?? 0})`,
      body: String(payload.summary ?? ""),
      dueAt: ctx.next_call_at ?? new Date(Date.now() + 3600_000),
    });
  }

  await auditInTx(tx, {
    tenantId: item.tenantId,
    actorType: "service",
    action: "sync.hubspot_updated",
    entityType: "call",
    entityId: ctx.call_id,
    metadata: { hubspot_record_id: ctx.hubspot_record_id },
  });

  return "done";
}

async function notify(tx: PoolClient, item: OutboxItem, deps: SyncDeps): Promise<"done" | "skipped"> {
  const ctx = await loadContext(tx, String(item.payload.call_id));
  if (!ctx) throw new IntegrationError("Call context missing for notification", false);
  if (!committed(ctx)) return "skipped";

  const payload = ctx.structured_payload as Record<string, unknown>;

  // PRD 16's hot-lead notification. The recipient is a client sales contact
  // outside the platform, so the phone number is masked here too.
  const message: NotificationPayload = {
    tenantName: ctx.tenant_name,
    campaignName: ctx.campaign_name ?? "",
    leadName: decryptPiiOrNull(ctx.name_enc),
    maskedPhone: maskedPhone(ctx.phone_enc),
    intent: ctx.intent,
    score: ctx.score ?? 0,
    summary: String(payload.summary ?? ""),
    callId: ctx.call_id,
    durationSec: ctx.duration_sec,
  };

  if (deps.notifier) {
    await deps.notifier(message);
  } else {
    // Phase 1 ships the routing event and the payload; the email/Slack
    // transport is PRD 16's "Notification Layer", configured in a later phase.
    console.log(JSON.stringify({ level: "info", msg: "hot_lead_notification", ...message }));
  }

  await tx.query(
    `update routing_events set status = 'notified' where call_id = $1 and status = 'pending'`,
    [ctx.call_id],
  );

  return "done";
}

/**
 * Unwrapping a credential can fail on malformed key material - a truncated
 * service-account key, a placeholder that was never replaced. That is a
 * configuration error, not a transient one: retrying it eight times just
 * delays the alert, so it is classified non-retryable and dead-letters at once.
 */
function buildClient<T>(type: string, construct: () => T): T {
  try {
    return construct();
  } catch (err) {
    throw new IntegrationError(
      `Cannot build ${type} client from stored credential: ${
        err instanceof Error ? err.message : String(err)
      }`,
      false,
    );
  }
}

function maskedPhone(enc: Buffer | null): string | null {
  const phone = decryptPiiOrNull(enc);
  return phone ? maskPhone(phone) : null;
}

async function loadCredential(
  tx: PoolClient,
  campaignId: string | null,
  type: "hubspot" | "google_sheets",
): Promise<SealedSecret> {
  const r = await tx.query<{
    key_id: string;
    wrapped_dek: Buffer;
    iv: Buffer;
    ciphertext: Buffer;
    auth_tag: Buffer;
  }>(
    `select s.key_id, s.wrapped_dek, s.iv, s.ciphertext, s.auth_tag
       from integrations i
       join secrets s on s.id = i.credential_ref
      where i.type = $1 and i.status = 'active'
        and ($2::uuid is null or i.id = (select hubspot_integration_id from campaigns where id = $2)
             or i.type <> 'hubspot')
      order by i.created_at
      limit 1`,
    [type, campaignId],
  );

  const row = r.rows[0];
  if (!row) throw new IntegrationError(`No active ${type} integration for this tenant`, false);

  return {
    keyId: row.key_id,
    wrappedDek: row.wrapped_dek,
    iv: row.iv,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
  };
}

async function disableIntegration(tx: PoolClient, item: OutboxItem, reason: string): Promise<void> {
  const type = item.target === "google_sheets" ? "google_sheets" : "hubspot";
  await tx.query(
    `update integrations set status = 'error', last_error = $2 where type = $1 and status = 'active'`,
    [type, reason.slice(0, 500)],
  );
  await auditInTx(tx, {
    tenantId: item.tenantId,
    actorType: "system",
    action: "integration.disabled",
    entityType: "integration",
    entityId: type,
    metadata: { reason: reason.slice(0, 500) },
  });
}

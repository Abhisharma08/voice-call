import type { PoolClient } from "pg";
import { withScope } from "@/db/client";
import { decryptPiiOrNull, maskPhone } from "@/lib/crypto/pii";
import type { SealedSecret } from "@/lib/crypto/kms";
import {
  claimDueSyncs,
  markSyncFailed,
  markSyncSucceeded,
  type OutboxItem,
} from "@/lib/integrations/outbox";
import { HubSpotClient, IntegrationError } from "@/lib/integrations/hubspot";
import {
  DEFAULT_SHEET_RANGE,
  GoogleSheetsClient,
  type SheetRow,
} from "@/lib/integrations/google-sheets";
import { SlackNotifier } from "@/lib/integrations/slack";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/observability/log";

/**
 * Drains sync_outbox (workflow W03 steps 7-9).
 *
 * One deliberate constraint runs through this file: a row is only ever built
 * from a *committed* analysis. A pending_review result is held back from
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

/**
 * Drain one tenant's outbox now, in its own scope, without letting a failure
 * reach the caller.
 *
 * The scheduled sweep drains the outbox once a minute, which is a fine floor
 * but a poor ceiling: a call that ends at 10:00:01 had its result sitting in
 * `sync_outbox` until 10:01:00 before it reached the client's Google Sheet.
 * The row is already committed by the time this runs, so calling it from
 * `after()` on the voice webhook just moves the delivery forward - it is not
 * the only path, and the cron pass still picks up anything this misses.
 *
 * Errors are logged and swallowed for exactly that reason. A HubSpot outage
 * must not turn into a failed response to a provider callback whose real work
 * - recording the call - has already committed.
 */
export async function flushTenantOutbox(
  tenantId: string,
  deps: SyncDeps = {},
  limit = 25,
): Promise<DrainResult> {
  try {
    return await withScope(
      { tenantId, globalScope: false, actorId: null, actorType: "service" },
      (tx) => drainSyncOutbox(tx, deps, limit),
      "service",
    );
  } catch (err) {
    logger.error("immediate outbox flush failed; the scheduled sweep will retry", {
      tenant_id: tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
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
        // "Auth failure - No - Alert + integration disabled."
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
  email_enc: Buffer | null;
  enquiry_enc: Buffer | null;
  lead_source: string | null;
  lead_created_at: Date | null;
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
            l.name_enc, l.phone_enc, l.email_enc, l.enquiry_enc, l.next_call_at,
            l.source as lead_source, l.created_at as lead_created_at,
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

/** Nothing leaves the platform while a result is held for review. */
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
    source: ctx.lead_source ?? "",
    name: decryptPiiOrNull(ctx.name_enc) ?? "",
    // The full number, at the operator's explicit choice. It is masked
    // because a sheet sits outside this platform's access control and audit
    // log - which is still true, and is now a property of the spreadsheet's
    // own sharing rather than of this row. A call log nobody can call from
    // was the greater cost here.
    phone: decryptPiiOrNull(ctx.phone_enc) ?? "",
    email: decryptPiiOrNull(ctx.email_enc) ?? "",
    // What the lead actually asked for, in their words.
    enquiry: decryptPiiOrNull(ctx.enquiry_enc) ?? "",
    lead_created: ctx.lead_created_at ? ctx.lead_created_at.toISOString().slice(0, 10) : "",
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
    range: ctx.google_sheet_tab ?? DEFAULT_SHEET_RANGE,
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

  // A follow-up task with the call context, for the human who picks
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

  // the hot-lead notification. The recipient is a client sales contact
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
    const sealed = await loadCredentialOrNull(tx, "notification");

    if (sealed) {
      await buildClient("notification", () => SlackNotifier.fromSealedSecret(sealed)).send(message);

      await auditInTx(tx, {
        tenantId: item.tenantId,
        actorType: "service",
        action: "sync.notification_sent",
        entityType: "call",
        entityId: ctx.call_id,
        // The lead's name and number do not go in the audit metadata; the
        // audit log answers "was this sent", not "what did it say".
        metadata: { channel: "slack", intent: ctx.intent, score: ctx.score ?? 0 },
      });
    } else {
      /**
       * No notification integration for this client. Logged and treated as
       * done rather than failed: a client who has not connected a channel has
       * not misconfigured anything, and dead-lettering every hot lead for them
       * after eight retries would bury the rows that represent real delivery
       * failures. The routing event is still stamped below, so the hot lead is
       * visible in the platform either way.
       */
      logger.info("hot_lead_notification_undelivered", {
        reason: "no notification integration configured for this client",
        tenant: message.tenantName,
        call_id: message.callId,
        score: message.score,
      });
    }
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

/**
 * The tenant's active integration of `type`, or null if they have none.
 *
 * Separate from `loadCredential` because the two callers want opposite things
 * from a missing integration. A Sheets or HubSpot sync with no credential is a
 * broken destination and should fail loudly; a client with no notification
 * channel connected has simply not connected one.
 *
 * No campaign argument: notification routing is per client, not per campaign.
 */
async function loadCredentialOrNull(
  tx: PoolClient,
  type: "notification",
): Promise<SealedSecret | null> {
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
      order by i.created_at
      limit 1`,
    [type],
  );

  const row = r.rows[0];
  if (!row) return null;

  return {
    keyId: row.key_id,
    wrappedDek: row.wrapped_dek,
    iv: row.iv,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
  };
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
  // Map the target to its own integration type. This was a two-way choice
  // while `notification` had no transport; now that it does, defaulting
  // anything-that-is-not-Sheets to `hubspot` would answer a revoked Slack
  // webhook by disabling the client's CRM sync - stopping every result from
  // reaching HubSpot because a chat notification failed.
  const type = item.target;
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

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, success, tenantAction, type ActionResult } from "@/lib/actions";
import { sealSecret, type SealedSecret } from "@/lib/crypto/kms";
import { derivePortalId, validateCredentialShape } from "@/lib/integrations/credentials";
import { HubSpotClient, IntegrationError } from "@/lib/integrations/hubspot";
import {
  DEFAULT_SHEET_RANGE,
  GoogleSheetsClient,
  splitRange,
} from "@/lib/integrations/google-sheets";
import { SlackNotifier } from "@/lib/integrations/slack";

/**
 * Verify a stored credential, and bootstrap whatever the far end needs.
 *
 * Both of these exist because the same two failures account for nearly every
 * "the sync isn't working" report:
 *
 *   HubSpot rejects a PATCH naming a property that does not exist, and this
 *   platform writes ten custom ones. A fresh portal fails every CRM sync until
 *   they are created.
 *
 *   A Google service account is a separate principal. A spreadsheet nobody
 *   shared with it returns 404 regardless of how valid the key is.
 *
 * Finding either during the first live campaign is expensive. Finding them
 * from a button is not.
 */

const Replace = z.object({
  tenantId: z.string().uuid(),
  integrationId: z.string().uuid(),
  credential: z.string().min(1).max(20000),
});

/**
 * Replace an integration's secret in place.
 *
 * Adding a second credential is not the same thing and is sometimes worse:
 * `app.hubspot_portal_lookup` takes `limit 1` with no ordering, so two
 * integrations for one portal make which credential verifies an inbound
 * webhook a coin toss. Rotation has to keep the integration row - and the id
 * every campaign points at - and swap what it references.
 *
 * The old secret is deleted once nothing references it. `credential_ref` is
 * ON DELETE RESTRICT, so the order matters: repoint first, then drop. Keeping
 * the row would leave an unwrappable copy of a credential that was very likely
 * rotated because it leaked.
 */
export async function replaceIntegrationCredential(
  formData: FormData,
): Promise<ActionResult<{ portalId: number | null }>> {
  const parsed = Replace.safeParse({
    tenantId: formData.get("tenantId"),
    integrationId: formData.get("integrationId"),
    credential: formData.get("credential"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(issue?.message ?? "Invalid input", issue?.path.join("."));
  }

  const { tenantId, integrationId, credential } = parsed.data;

  // The type is the integration's, never the caller's: a credential shape is
  // only meaningful against what the far end actually is.
  const existing = await tenantAction({ tenantId, permission: "secret:write" }, async (ctx) => {
    const r = await ctx.tx.query<{ type: string; credential_ref: string | null }>(
      `select type, credential_ref from integrations where id = $1 and tenant_id = $2`,
      [integrationId, tenantId],
    );
    const row = r.rows[0];
    return row ? success(row) : failure("Not found");
  });

  if (!existing.ok) return existing;
  const { type, credential_ref: previousSecretId } = existing.data;

  const shapeError = validateCredentialShape(type, credential);
  if (shapeError) return failure(shapeError, "credential");

  // Outside the transaction, for the reason addIntegration derives it there.
  const portalId = type === "hubspot" ? await derivePortalId(credential) : null;

  return tenantAction({ tenantId, permission: "secret:write" }, async (ctx) => {
    const sealed = sealSecret(credential, type);

    const secret = await ctx.tx.query<{ id: string }>(
      `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [tenantId, type, sealed.keyId, sealed.wrappedDek, sealed.iv, sealed.ciphertext, sealed.authTag, ctx.user.id],
    );

    // A rotation clears the previous failure and the previous verification:
    // both described the credential that just went away.
    await ctx.tx.query(
      `update integrations
          set credential_ref = $3,
              status = 'active',
              last_error = null,
              last_verified_at = null,
              hubspot_portal_id = coalesce($4, hubspot_portal_id),
              updated_at = now()
        where id = $1 and tenant_id = $2`,
      [integrationId, tenantId, secret.rows[0]!.id, portalId],
    );

    if (previousSecretId) {
      await ctx.tx.query(`delete from secrets where id = $1 and tenant_id = $2`, [
        previousSecretId,
        tenantId,
      ]);
    }

    await ctx.audit({
      action: "integration.credential_replaced",
      entityType: "integration",
      entityId: integrationId,
      // The credential itself never reaches the audit log.
      metadata: { type, hubspot_portal_id: portalId },
    });

    revalidatePath("/integrations");
    revalidatePath("/clients");
    return success({ portalId });
  });
}

const Test = z.object({
  tenantId: z.string().uuid(),
  integrationId: z.string().uuid(),
  spreadsheetId: z.string().max(200).nullable().optional(),
  sheetRange: z.string().max(200).nullable().optional(),
});

export interface ConnectionReport {
  ok: boolean;
  summary: string;
  details: string[];
  /**
   * HubSpot's own account id, learned from the test rather than typed in.
   *
   * It is how an inbound private-app webhook finds this client: the payload
   * carries `portalId` and nothing else identifying, so without this mapping a
   * free-tier portal has no way to deliver a lead. Capturing it here means one
   * fewer field to copy by hand, and one fewer to copy wrongly.
   */
  portalId?: number;
}

export async function testIntegration(formData: FormData): Promise<ActionResult<ConnectionReport>> {
  const parsed = Test.safeParse({
    tenantId: formData.get("tenantId"),
    integrationId: formData.get("integrationId"),
    spreadsheetId: formData.get("spreadsheetId") || null,
    sheetRange: formData.get("sheetRange") || null,
  });
  if (!parsed.success) return failure("Invalid request");

  const { tenantId, integrationId, spreadsheetId, sheetRange } = parsed.data;

  return tenantAction({ tenantId, permission: "integration:write" }, async (ctx) => {
    const row = await ctx.tx.query<{
      type: string;
      key_id: string;
      wrapped_dek: Buffer;
      iv: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(
      `select i.type, s.key_id, s.wrapped_dek, s.iv, s.ciphertext, s.auth_tag
         from integrations i join secrets s on s.id = i.credential_ref
        where i.id = $1`,
      [integrationId],
    );

    const record = row.rows[0];
    if (!record) return failure("Not found");

    const sealed: SealedSecret = {
      keyId: record.key_id,
      wrappedDek: record.wrapped_dek,
      iv: record.iv,
      ciphertext: record.ciphertext,
      authTag: record.auth_tag,
    };

    let report: ConnectionReport;
    try {
      report =
        record.type === "hubspot"
          ? await testHubSpot(sealed)
          : record.type === "google_sheets"
            ? await testSheets(sealed, spreadsheetId, sheetRange)
            : record.type === "notification"
              ? await testSlack(sealed)
              : { ok: false, summary: `No connection test for ${record.type} yet`, details: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await ctx.tx.query(`update integrations set status = 'error', last_error = $2 where id = $1`, [
        integrationId,
        message.slice(0, 500),
      ]);
      await ctx.audit({
        action: "integration.test_failed",
        entityType: "integration",
        entityId: integrationId,
        metadata: { type: record.type, error: message.slice(0, 300) },
      });

      revalidatePath("/integrations");
      return success({ ok: false, summary: message, details: [] });
    }

    // A passing test clears a previous failure, which is how an integration
    // disabled by PRD 18.2's auth-failure rule gets back into service.
    if (report.ok) {
      await ctx.tx.query(
        `update integrations set status = 'active', last_error = null, last_verified_at = now(),
                hubspot_portal_id = coalesce($2, hubspot_portal_id)
          where id = $1`,
        [integrationId, report.portalId ?? null],
      );
    }

    await ctx.audit({
      action: "integration.tested",
      entityType: "integration",
      entityId: integrationId,
      metadata: { type: record.type, ok: report.ok, summary: report.summary },
    });

    revalidatePath("/integrations");
    return success(report);
  });
}

async function testHubSpot(sealed: SealedSecret): Promise<ConnectionReport> {
  const client = HubSpotClient.fromSealedSecret(sealed);

  const account = await client.verifyConnection();
  const details = [`Connected to portal ${account.portalId} (${account.timeZone}).`];

  // Create the custom properties the CRM sync writes, if they are missing.
  const properties = await client.ensureProperties();
  if (properties.created.length > 0) {
    details.push(`Created ${properties.created.length} custom contact properties.`);
  }
  if (properties.existing.length > 0) {
    details.push(`${properties.existing.length} properties already present.`);
  }

  return {
    ok: true,
    summary: `HubSpot portal ${account.portalId} reachable`,
    details,
    portalId: account.portalId,
  };
}

/**
 * Slack has no way to validate an incoming webhook without using it - there is
 * no endpoint that reports whether a URL is live. So this posts a real message
 * and says so, rather than reporting a success it has not actually observed.
 * What it proves is worth the visible message: that the URL still resolves,
 * the channel still exists, and the app has not been uninstalled - the three
 * ways a webhook configured months ago is silently dead by the time a hot lead
 * needs it.
 */
async function testSlack(sealed: SealedSecret): Promise<ConnectionReport> {
  await SlackNotifier.fromSealedSecret(sealed).verifyConnection();

  return {
    ok: true,
    summary: "Slack webhook accepted a test message",
    details: [
      "A test message was posted to the connected channel - it is visible to the client.",
      "Hot leads scoring above the campaign's threshold will be delivered here.",
    ],
  };
}

async function testSheets(
  sealed: SealedSecret,
  spreadsheetId: string | null | undefined,
  sheetRange: string | null | undefined,
): Promise<ConnectionReport> {
  const client = GoogleSheetsClient.fromSealedSecret(sealed);

  if (!spreadsheetId) {
    // Without a spreadsheet id all we can prove is that the key signs a JWT
    // Google accepts - useful, but say so rather than implying more.
    throw new IntegrationError(
      "Set the campaign's Google Sheet ID first, so the test can check the service account can reach it.",
      false,
    );
  }

  // Use the campaign's configured range. Testing a hardcoded one proves
  // nothing about the destination the sync will actually write to.
  const range = sheetRange ?? DEFAULT_SHEET_RANGE;
  const { tab } = splitRange(range);

  const info = await client.verifyConnection(spreadsheetId);
  const before = info.tabs.slice();
  const header = await client.ensureHeaderRow(spreadsheetId, range);

  const details = [`Tabs: ${before.join(", ")}`];
  if (!before.includes(tab)) details.push(`Created the "${tab}" tab.`);
  details.push(
    header === "written" ? `Wrote the header row to "${tab}".` : `Header row already present in "${tab}".`,
  );

  return { ok: true, summary: `Spreadsheet "${info.title}" reachable`, details };
}

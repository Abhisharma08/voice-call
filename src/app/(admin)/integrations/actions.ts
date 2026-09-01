"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, success, tenantAction, type ActionResult } from "@/lib/actions";
import type { SealedSecret } from "@/lib/crypto/kms";
import { HubSpotClient, IntegrationError } from "@/lib/integrations/hubspot";
import { GoogleSheetsClient } from "@/lib/integrations/google-sheets";

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

const Test = z.object({
  tenantId: z.string().uuid(),
  integrationId: z.string().uuid(),
  spreadsheetId: z.string().max(200).nullable().optional(),
});

export interface ConnectionReport {
  ok: boolean;
  summary: string;
  details: string[];
}

export async function testIntegration(formData: FormData): Promise<ActionResult<ConnectionReport>> {
  const parsed = Test.safeParse({
    tenantId: formData.get("tenantId"),
    integrationId: formData.get("integrationId"),
    spreadsheetId: formData.get("spreadsheetId") || null,
  });
  if (!parsed.success) return failure("Invalid request");

  const { tenantId, integrationId, spreadsheetId } = parsed.data;

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
            ? await testSheets(sealed, spreadsheetId)
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
        `update integrations set status = 'active', last_error = null, last_verified_at = now()
          where id = $1`,
        [integrationId],
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

  return { ok: true, summary: `HubSpot portal ${account.portalId} reachable`, details };
}

async function testSheets(
  sealed: SealedSecret,
  spreadsheetId: string | null | undefined,
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

  const info = await client.verifyConnection(spreadsheetId);
  const header = await client.ensureHeaderRow(spreadsheetId, "Call Log!A:V");

  return {
    ok: true,
    summary: `Spreadsheet "${info.title}" reachable`,
    details: [
      `Tabs: ${info.tabs.join(", ")}`,
      header === "written" ? "Wrote the Call Log header row." : "Header row already present.",
    ],
  };
}

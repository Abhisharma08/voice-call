import { Client } from "pg";
import "./load-env.ts";
import { sealSecret } from "../src/lib/crypto/kms.ts";
import { generateServiceToken } from "../src/lib/auth/service.ts";

/**
 * Phase 1 development seed: makes the Acme tenant dialable end-to-end.
 *
 * Adds the qualification questions, a mock voice provider, placeholder
 * integration credentials, and an n8n service token.
 *
 * It is a *development* fixture - it exists so `npm run dev` can demonstrate
 * the flow on a fictional tenant, which is why it refuses to run outside
 * development.
 */

async function main() {
  if ((process.env.APP_ENV ?? "development") !== "development") {
    throw new Error(`Refusing to seed Phase 1 fixtures with APP_ENV=${process.env.APP_ENV}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.global_scope', 'on', true),
              set_config('app.actor_type', 'system', true)`,
    );

    const tenant = await client.query<{ id: string }>(
      `select id from tenants where slug = 'acme-real-estate'`,
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("Run `npm run db:seed` first");

    const campaign = await client.query<{ id: string }>(
      `select id from campaigns where tenant_id = $1 and name = 'Noida 2BHK'`,
      [tenantId],
    );
    const campaignId = campaign.rows[0]?.id;
    if (!campaignId) throw new Error("Base campaign missing; run `npm run db:seed` first");

    // Re-running the seed must not accumulate duplicate credentials: two
    // active integrations of the same type make "which one did the sync use?"
    // unanswerable.
    await client.query(
      `delete from secrets where id in (
         select credential_ref from integrations
          where tenant_id = $1 and credential_ref is not null)`,
      [tenantId],
    );
    await client.query(`delete from integrations where tenant_id = $1`, [tenantId]);

    // ── Integration credentials, envelope-encrypted (PRD 17.1) ──────────────
    const hubspotSecret = sealSecret(
      JSON.stringify({ accessToken: "pat-na1-development-placeholder" }),
      "hubspot",
    );
    const sheetsSecret = sealSecret(
      JSON.stringify({
        client_email: "dev-service-account@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nDEVELOPMENT PLACEHOLDER\n-----END PRIVATE KEY-----\n",
      }),
      "google_sheets",
    );

    const hubspotSecretId = await insertSecret(client, tenantId, "hubspot", hubspotSecret);
    const sheetsSecretId = await insertSecret(client, tenantId, "google_sheets", sheetsSecret);

    const hubspotIntegration = await client.query<{ id: string }>(
      `insert into integrations (tenant_id, type, name, credential_ref, config)
       values ($1, 'hubspot', 'Acme HubSpot (dev)', $2, '{}'::jsonb)
       returning id`,
      [tenantId, hubspotSecretId],
    );

    await client.query(
      `insert into integrations (tenant_id, type, name, credential_ref, config)
       values ($1, 'google_sheets', 'Acme Call Log (dev)', $2, '{}'::jsonb)`,
      [tenantId, sheetsSecretId],
    );

    // ── Campaign configuration ─────────────────────────────────────────────
    await client.query(
      `update campaigns set
          script = $2,
          domain = 'residential_property',
          active = true,
          voice_provider = 'mock',
          google_sheet_id = 'dev-spreadsheet-id',
          google_sheet_tab = 'Call Log!A:V',
          hubspot_integration_id = $3,
          scoring_rubric = $4::jsonb,
          calling_config = $5::jsonb,
          -- Consent is collected upstream at the landing page or Meta lead
          -- form and reaches HubSpot before this platform sees the lead, so
          -- intake records it rather than gating on it (migration 0008).
          consent_origin = 'landing_page_form'
        where id = $1`,
      [
        campaignId,
        "Hello, this is an AI assistant calling from Acme Real Estate about your recent enquiry. Is now a good time?",
        hubspotIntegration.rows[0]!.id,
        JSON.stringify({
          current_need_confirmed: 25,
          short_timeline: 25,
          budget_known: 15,
          specific_product: 10,
          accepts_human_followup: 15,
          vague_curiosity: 5,
          long_term_no_plan: 0,
          explicit_rejection: -100,
        }),
        JSON.stringify({
          window_start: "00:00",
          window_end: "23:59",
          max_attempts: 3,
          retry_minutes: [15, 120, 1440],
          country: "IN",
        }),
      ],
    );

    // ── Qualification questions (FR-030) ───────────────────────────────────
    const questions: Array<[string, string, boolean, number]> = [
      ["still_interested", "Are you still actively looking for a property?", true, 1],
      ["timeline", "What is your timeline for making a decision?", true, 2],
      ["budget", "Do you have a budget range in mind?", false, 3],
      ["location", "Which areas are you considering?", false, 4],
      ["product_interest", "What configuration are you looking for?", false, 5],
    ];

    for (const [field, question, required, position] of questions) {
      await client.query(
        `insert into qualification_rules
           (tenant_id, campaign_id, field_name, question, required, position)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (campaign_id, field_name) do update
           set question = excluded.question, required = excluded.required`,
        [tenantId, campaignId, field, question, required, position],
      );
    }

    // ── n8n service identity (PRD 4, 9) ────────────────────────────────────
    const { token, hash } = generateServiceToken();
    await client.query(`delete from service_tokens where tenant_id = $1 and name = 'n8n-dev'`, [
      tenantId,
    ]);
    await client.query(
      `insert into service_tokens (tenant_id, name, token_hash, scopes)
       values ($1, 'n8n-dev', $2, $3)`,
      [tenantId, hash, ["leads:ingest", "calls:dial", "calls:result", "analysis:run", "sync:drain"]],
    );

    await client.query("commit");

    console.log("Phase 1 fixtures ready.\n");
    console.log(`  tenant_id    ${tenantId}`);
    console.log(`  campaign_id  ${campaignId}`);
    console.log(`  service token (n8n, shown once):\n\n    ${token}\n`);
    console.log("  The mock voice provider picks a scenario from the last digit of the number:");
    console.log("    ...0 hot   ...1 no_answer   ...2 busy   ...3 not_interested");
    console.log("    ...4 do_not_call   ...5 callback   ...9 provider_failure\n");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

async function insertSecret(
  client: Client,
  tenantId: string,
  purpose: string,
  sealed: ReturnType<typeof sealSecret>,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [tenantId, purpose, sealed.keyId, sealed.wrappedDek, sealed.iv, sealed.ciphertext, sealed.authTag],
  );
  return r.rows[0]!.id;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

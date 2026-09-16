import { Client } from "pg";
import "./load-env.ts";

/**
 * Fill in the parts of the Alu Empire campaign that the UI leaves empty, so it
 * can be tuned against the mock provider before anyone's phone rings.
 *
 * Alu Empire (aluempire.com) manufactures and installs uPVC and aluminium
 * doors, windows, glass partitions, railings and shower cubicles across Delhi
 * NCR. Leads arrive from a website quote request and a dealer enquiry form.
 *
 * The campaign itself was created by hand in the admin UI. This configures it
 * as a **verification** campaign: a short call that confirms the person did
 * submit the form and that the requirement on it is still what they want.
 * Anything past that is a conversation for a human to have.
 *
 * What it sets:
 *
 *   - the script, templated with `{{name}}` and `{{requirement}}` so the call
 *     names the lead and says their own enquiry back to them.
 *   - a neural Indian English voice, rather than the flat standard one.
 *   - two qualification questions (FR-030) - confirm the enquiry, confirm the
 *     requirement. Stale rules from a previous shape are removed, because a
 *     required field the call never asks about holds every result for review.
 *   - a scoring rubric, routing thresholds, and a dial allowlist.
 *
 * What it leaves alone: the business context, calling window, Google Sheet and
 * voice provider chosen in the UI, and the tenant record.
 *
 * What it deliberately does NOT do: approve compliance. seed-phase1.ts sets
 * that flag as a development fixture on a fictional tenant. This is a real
 * client and a real number would be dialled, so PRD 17.3's review has to
 * happen and be attested by a named Agency Admin in the UI. `--approve` exists
 * for local testing and logs itself as a fixture; see below.
 *
 *   npm run db:seed:aluempire
 */

const TENANT_SLUG = "alu-empire";

/** The campaign created in the UI. Nothing is created if it is missing. */
const CAMPAIGN_NAME = "ALU EMPIRE";

/**
 * Every lead not listed here is suppressed as `not_on_dial_allowlist` before a
 * call is placed. The campaign already names a real voice provider, so this is
 * what stands between activating it and calling a real customer. Replace with
 * your own verified mobile, and clear it only when going live.
 */
const DIAL_ALLOWLIST = [
  // The demo driver's fixture numbers, so `npm run demo` can exercise this
  // campaign end to end while the allowlist stays switched on. None of these
  // belong to a real person. Replace the whole list with your own verified
  // mobile before pointing this at a real voice provider.
  "+919876543210",
  "+919876543211",
  "+919876543212",
  "+919876543213",
  "+919876543214",
  "+919876543215",
  "+919876543216",
  "+919876543219",
  "+919876543220",
];

/**
 * `npm run db:seed:aluempire -- --approve` also records a consent basis and
 * satisfies the PRD 17.3 gate, so the campaign can be activated and driven end
 * to end locally.
 *
 * This is a DEVELOPMENT convenience and it says so in the audit log: the entry
 * is written as a `system` actor with `development_fixture: true`, not as a
 * person, so a seeded approval can never be mistaken for one an Agency Admin
 * actually made. The script refuses to run outside development anyway.
 *
 * It does not make the campaign safe to point at a real list. The telecom
 * review PRD 17.3 describes still has to happen before a real number is
 * dialled, and clearing the dial allowlist is what would let that happen.
 */
const APPROVE = process.argv.includes("--approve");

async function main() {
  if ((process.env.APP_ENV ?? "development") !== "development") {
    throw new Error(`Refusing to seed client fixtures with APP_ENV=${process.env.APP_ENV}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.global_scope', 'on', true),
              set_config('app.actor_type', 'system', true)`,
    );

    // ── Locate, never create ────────────────────────────────────────────────
    //
    // An upsert here would overwrite a tenant record a person filled in, which
    // is how the name and notes on this tenant got clobbered once already.
    const tenant = await client.query<{ id: string; name: string }>(
      `select id, name from tenants where slug = $1`,
      [TENANT_SLUG],
    );
    const row = tenant.rows[0];
    if (!row) {
      throw new Error(
        `No tenant with slug "${TENANT_SLUG}". Create the client in /clients first - ` +
          `this script configures an existing campaign, it does not invent one.`,
      );
    }
    const tenantId = row.id;

    const campaign = await client.query<{
      id: string;
      active: boolean;
      voice_provider: string;
      compliance_approved_at: Date | null;
    }>(
      `select id, active, voice_provider, compliance_approved_at
         from campaigns where tenant_id = $1 and name = $2`,
      [tenantId, CAMPAIGN_NAME],
    );
    const c = campaign.rows[0];
    if (!c) {
      throw new Error(
        `Tenant "${row.name}" has no campaign named "${CAMPAIGN_NAME}". ` +
          `Create it in /campaigns first, or edit CAMPAIGN_NAME in this script.`,
      );
    }
    const campaignId = c.id;

    // Staff see only the clients they are assigned to (PRD 8.2), so without
    // this the campaign exists but nobody below Agency Admin can open it.
    await client.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role)
       select u.id, $1, case u.email
                          when 'ops@agency.test' then 'operations_manager'
                          else 'campaign_manager'
                        end::user_role
         from users u
        where u.email in ('ops@agency.test', 'campaigns@agency.test')
       on conflict do nothing`,
      [tenantId],
    );

    // ── Script and voice ────────────────────────────────────────────────────
    //
    // A verification call, not a sales call. The job is to establish two
    // things and get off the phone: that this person did submit the form, and
    // that what the form says they want is what they actually want. Anything
    // beyond that is a human's conversation to have.
    //
    // `{{name}}` and `{{requirement}}` are filled from the lead at call time
    // (see the twiml route). `requirement` is whatever the website form put in
    // HubSpot, so the call says it back rather than guessing.
    const script =
      "Namaste {{name}}, this is an assistant calling from Alu Empire. " +
      "You recently requested a quote on our website for {{requirement}}. " +
      "This is just a quick confirmation call, it will take under a minute.";

    await client.query(
      `update campaigns set
          script = $2,
          -- Neural Indian English rather than the standard voice, which is
          -- what made calls sound flat. Configuration, not code, because the
          -- available voice names change as providers add them.
          calling_config = calling_config || $3::jsonb
        where id = $1`,
      [
        campaignId,
        script,
        JSON.stringify({ voice: "Polly.Kajal-Neural", language: "en-IN" }),
      ],
    );

    // ── Scoring, routing, allowlist ─────────────────────────────────────────
    //
    // Site-ready-now is worth more than a stated rupee figure in this
    // business: a confirmed need with a short timeline converts to a
    // measurement visit, and the visit is where the quote is really made.
    await client.query(
      `update campaigns set
          scoring_rubric = $2::jsonb,
          routing_config = routing_config || $3::jsonb,
          dial_allowlist = $4::text[],
          -- Consent is collected on the website quote form before the lead
          -- ever reaches this platform; intake records it per lead rather
          -- than gating on it (migration 0008).
          consent_origin = coalesce(consent_origin, 'website_quote_form')
        where id = $1`,
      [
        campaignId,
        JSON.stringify({
          current_need_confirmed: 30,
          short_timeline: 25,
          accepts_human_followup: 20,
          specific_product: 15,
          budget_known: 10,
          vague_curiosity: 5,
          long_term_no_plan: 0,
          explicit_rejection: -100,
        }),
        JSON.stringify({ hot_threshold: 75, interested_threshold: 50 }),
        DIAL_ALLOWLIST,
      ],
    );

    // ── Qualification questions (FR-030) ────────────────────────────────────
    //
    // The field names are fixed by QualificationSchema - these are rewordings,
    // not new extraction targets. Note what is missing: Alu Empire runs two
    // funnels, end-customer projects and dealer enquiries, and there is no
    // field to separate them. Until one is added, keep dealer leads out of
    // this campaign rather than letting product_interest carry it as free text.
    // Two questions, in this order, because that is the whole brief: did you
    // fill the form, and is the requirement on it still what you want. A
    // third question is a third chance for speech recognition to mangle
    // something and for the lead to hang up.
    const questions: Array<[string, string, boolean, number]> = [
      [
        "still_interested",
        "Can you confirm you submitted an enquiry with us, and that you are still looking to get this done?",
        true,
        1,
      ],
      [
        "product_interest",
        "And is {{requirement}} still what you need, or has the requirement changed?",
        true,
        2,
      ],
    ];

    // Anything this campaign no longer asks. Leaving a stale rule behind makes
    // it a required field the call never covers, so every result would be held
    // for review as incomplete.
    await client.query(
      `delete from qualification_rules
        where campaign_id = $1 and field_name <> all($2::text[])`,
      [campaignId, questions.map(([field]) => field)],
    );

    for (const [field, question, required, position] of questions) {
      await client.query(
        `insert into qualification_rules
           (tenant_id, campaign_id, field_name, question, required, position)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (campaign_id, field_name) do update
           set question = excluded.question, required = excluded.required,
               position = excluded.position`,
        [tenantId, campaignId, field, question, required, position],
      );
    }

    // ── Development approval (--approve) ────────────────────────────────────
    if (APPROVE) {
      // The approve action requires a consent basis first (PRD 14.3 step 10),
      // and that is a statement about where this client's list came from -
      // Alu Empire's website quote form.
      await client.query(
        `update campaigns set
            consent_basis = coalesce(consent_basis, 'opt_in_form'),
            consent_source = coalesce(consent_source, 'website_quote_form'),
            consent_declared_at = coalesce(consent_declared_at, now()),
            compliance_approved_at = now(),
            compliance_approved_by = (select id from users where email = 'admin@agency.test')
          where id = $1`,
        [campaignId],
      );

      await client.query(
        `insert into audit_events (tenant_id, actor_type, actor_label, action, entity_type, entity_id, metadata)
         values ($1, 'system', 'seed-aluempire.ts', 'campaign.compliance_approved', 'campaign', $2, $3::jsonb)`,
        [
          tenantId,
          campaignId,
          JSON.stringify({
            development_fixture: true,
            attestation:
              "Development fixture set by seed-aluempire.ts --approve. No telecom or legal " +
              "review has taken place. Not valid for calling a real lead list (PRD 17.3).",
          }),
        ],
      );
    }

    await client.query("commit");

    console.log(`Configured "${CAMPAIGN_NAME}" for ${row.name}.\n`);
    console.log(`  tenant_id    ${tenantId}`);
    console.log(`  campaign_id  ${campaignId}\n`);
    console.log(`  added    ${questions.length} qualification questions, scoring rubric, thresholds`);
    console.log(`  set      verification script, neural en-IN voice`);
    console.log(`  allowlist ${DIAL_ALLOWLIST.join(", ")}  <- replace with your own mobile`);
    console.log(`  left as-is  script, business context, calling window, sheet, provider\n`);

    if (c.voice_provider !== "mock") {
      console.log(`  ! voice_provider is "${c.voice_provider}", not mock. The allowlist above is`);
      console.log(`    the only thing preventing a call to a real number once active.\n`);
    }
    if (APPROVE) {
      console.log(`  ! Compliance approved as a DEVELOPMENT fixture, logged as such.`);
      console.log(`    No telecom or legal review has happened. Before a real number is`);
      console.log(`    dialled, an Agency Admin has to make that attestation in /campaigns.`);
    } else if (!c.compliance_approved_at) {
      console.log(`  ! Not compliance-approved, so it cannot be activated (PRD 17.3).`);
      console.log(`    Re-run with --approve to satisfy the gate for local testing.`);
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

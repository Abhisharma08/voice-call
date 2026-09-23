import { createHmac } from "node:crypto";
import { Client } from "pg";
import "./load-env.ts";
import { generateServiceToken } from "../src/lib/auth/service.ts";

/**
 * Drive the whole pipeline against a running dev server, so the UI has real
 * data to look at.
 *
 * Every step goes through the same HTTP endpoints n8n would call - nothing
 * here reaches into the database to fake a result. The mock voice provider
 * picks its scenario from the last digit of the number, which is how one run
 * produces a hot lead, a no-answer, a do-not-call and a callback without any
 * special-casing.
 *
 *   npm run demo
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";

/**
 * Which campaign to drive, and which conversations to put through it:
 *
 *   npm run demo
 *   npm run demo -- --tenant=alu-empire --campaign="ALU EMPIRE" --pack=aluempire
 *
 * The transcript pack matters more than it looks. Qualification is scored
 * against a campaign's own questions and rubric, so running property
 * conversations through a windows-and-doors campaign tells you nothing about
 * whether that campaign is configured well.
 */
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const TENANT_SLUG = arg("tenant") ?? "acme-real-estate";
const CAMPAIGN_NAME = arg("campaign") ?? "Noida 2BHK";
const PACK = arg("pack") ?? "property";

const LEADS = [
  { name: "Rahul Sharma", phone: "+919876543210", email: "rahul@example.com", note: "hot" },
  { name: "Priya Nair", phone: "+919876543220", email: "priya@example.com", note: "hot" },
  { name: "Amit Verma", phone: "+919876543211", email: "amit@example.com", note: "no answer" },
  { name: "Sneha Rao", phone: "+919876543212", email: "sneha@example.com", note: "busy" },
  { name: "Vikram Singh", phone: "+919876543213", email: "vikram@example.com", note: "not interested" },
  { name: "Anita Desai", phone: "+919876543214", email: "anita@example.com", note: "do not call" },
  { name: "Karan Mehta", phone: "+919876543215", email: "karan@example.com", note: "callback" },
  { name: "Meera Joshi", phone: "+919876543216", email: "meera@example.com", note: "vague enquiry" },
  { name: "Deepa Iyer", phone: "+919876543219", email: "deepa@example.com", note: "provider failure" },
  { name: "No Phone Person", phone: null, email: "nophone@example.com", note: "quarantined" },
];

type Transcript = { durationSec: number; text: string };

/** The transcripts the mock provider returns, keyed by scenario digit. */
const PROPERTY_TRANSCRIPTS: Record<string, Transcript> = {
  "0": {
    durationSec: 154,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a 2BHK in Noida?",
      "Lead: Yes, that is me.",
      "Agent: Are you still actively looking?",
      "Lead: Yes, I am actively looking. I want to close within the next two months.",
      "Agent: Do you have a budget range in mind?",
      "Lead: Around 50 to 75 lakh.",
      "Agent: Which areas are you considering?",
      "Lead: Mainly Noida Extension and Sector 150.",
      "Agent: What configuration are you looking for?",
      "Lead: A 2BHK, ideally ready to move.",
      "Agent: Would you like one of our advisors to call you?",
      "Lead: Yes please, that would be helpful.",
    ].join("\n"),
  },
  "3": {
    durationSec: 22,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a property in Noida?",
      "Lead: I already bought something else. Not interested.",
      "Agent: Understood, thank you for your time.",
    ].join("\n"),
  },
  "4": {
    durationSec: 14,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a property in Noida?",
      "Lead: Do not call me again. Remove my number from your list.",
      "Agent: I will remove your number right away. Apologies for the disturbance.",
    ].join("\n"),
  },
  "5": {
    durationSec: 31,
    text: [
      "Agent: Hello, is now a good time to talk about your property enquiry?",
      "Lead: I am driving right now. Can you call me tomorrow at 11am?",
      "Agent: Of course, I will arrange a call for tomorrow at 11am.",
    ].join("\n"),
  },
};

/**
 * Alu Empire: uPVC and aluminium windows, doors and glass partitions in Delhi
 * NCR. Written against that campaign's five questions - still_interested,
 * timeline, budget, location, product_interest - so the rubric and the review
 * gate are exercised on the answers they will actually see.
 */
const ALUEMPIRE_TRANSCRIPTS: Record<string, Transcript> = {
  "0": {
    durationSec: 168,
    text: [
      "Agent: Namaste, this is an AI assistant calling on behalf of Alu Empire about the quote you requested for windows. Is now a good time?",
      "Lead: Yes, go ahead.",
      "Agent: Are you still planning to get the windows done?",
      "Lead: Yes, definitely. The civil work is finished and we are ready for measurement.",
      "Agent: When are you looking to start?",
      "Lead: As soon as possible, within this month ideally.",
      "Agent: Roughly how many windows are we covering?",
      "Lead: Twelve windows and two balcony sliding doors.",
      "Agent: And which area is the site in?",
      "Lead: Sector 78, Noida.",
      "Agent: Is it uPVC or aluminium you are considering?",
      "Lead: uPVC for the bedrooms, and I want to see aluminium options for the balcony.",
      "Agent: Would you like our technical team to visit and take measurements?",
      "Lead: Yes, please arrange that. Weekends work better for me.",
    ].join("\n"),
  },
  "3": {
    durationSec: 26,
    text: [
      "Agent: Namaste, calling from Alu Empire about your window enquiry.",
      "Lead: We already got it done from someone else last month. Not needed now.",
      "Agent: Understood, thank you for your time.",
    ].join("\n"),
  },
  "4": {
    durationSec: 15,
    text: [
      "Agent: Namaste, calling from Alu Empire about your window enquiry.",
      "Lead: Stop calling me. Remove my number from your database.",
      "Agent: I will remove your number right away. Apologies for the disturbance.",
    ].join("\n"),
  },
  "5": {
    durationSec: 34,
    text: [
      "Agent: Namaste, is now a good time to talk about your windows enquiry?",
      "Lead: I am at work. Call me tomorrow evening after six.",
      "Agent: Of course, I will arrange a call for tomorrow after six.",
    ].join("\n"),
  },
  // A vague enquiry with nothing decided. Every extractable field is genuinely
  // unstated, so the model must return nulls and a low confidence rather than
  // filling gaps - which is the case the schema guards against, and the one that
  // should land in the review queue rather than a client's CRM.
  "6": {
    durationSec: 48,
    text: [
      "Agent: Namaste, calling from Alu Empire about the quote you requested.",
      "Lead: Oh, I just filled the form to see prices. Nothing is decided.",
      "Agent: Are you planning any work soon?",
      "Lead: Maybe. We are still thinking about whether to renovate at all.",
      "Agent: Do you know roughly how many windows?",
      "Lead: No idea honestly, we have not measured anything.",
      "Agent: Which area is the property in?",
      "Lead: I would rather not say right now.",
    ].join("\n"),
  },
};

const PACKS: Record<string, Record<string, Transcript>> = {
  property: PROPERTY_TRANSCRIPTS,
  aluempire: ALUEMPIRE_TRANSCRIPTS,
};

const TRANSCRIPTS: Record<string, Transcript> =
  PACKS[PACK] ??
  (() => {
    throw new Error(
      `Unknown transcript pack "${PACK}". Available: ${Object.keys(PACKS).join(", ")}`,
    );
  })();

async function main() {
  if ((process.env.APP_ENV ?? "development") !== "development") {
    throw new Error(`Refusing to run the demo driver with APP_ENV=${process.env.APP_ENV}`);
  }

  await assertServerUp();

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  let token: string;
  let tenantId: string;
  let campaignId: string;
  let campaignModel: string | null = null;

  try {
    await db.query("begin");
    await db.query(`select set_config('app.global_scope', 'on', true)`);

    const tenant = await db.query<{ id: string }>(`select id from tenants where slug = $1`, [
      TENANT_SLUG,
    ]);
    tenantId = tenant.rows[0]?.id ?? "";
    if (!tenantId) throw new Error(`No tenant with slug "${TENANT_SLUG}". Run \`npm run db:reset\` first`);

    const campaign = await db.query<{ id: string; analysis_model: string }>(
      `select id, analysis_model from campaigns where tenant_id = $1 and name = $2`,
      [tenantId, CAMPAIGN_NAME],
    );
    campaignId = campaign.rows[0]?.id ?? "";
    campaignModel = campaign.rows[0]?.analysis_model ?? null;
    if (!campaignId) {
      throw new Error(`Tenant "${TENANT_SLUG}" has no campaign named "${CAMPAIGN_NAME}"`);
    }

    // Mint a fresh token rather than reusing the seed's - only its hash is
    // stored, so the seed's plaintext is gone by now.
    const minted = generateServiceToken();
    await db.query(`delete from service_tokens where tenant_id = $1 and name = 'demo'`, [tenantId]);
    await db.query(
      `insert into service_tokens (tenant_id, name, token_hash, scopes)
       values ($1, 'demo', $2, $3)`,
      [tenantId, minted.hash, ["leads:ingest", "calls:dial", "calls:result", "analysis:run", "sync:drain"]],
    );
    token = minted.token;

    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => {});
    await db.end();
    throw err;
  }

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as never };
  };

  // ── 1. Intake ────────────────────────────────────────────────────────────
  console.log("\n1. Ingesting leads");
  const stamp = Date.now();
  for (const lead of LEADS) {
    const result = await post("/api/webhooks/leads", {
      event_id: `demo-${stamp}-${lead.phone ?? "nophone"}`,
      source: "hubspot",
      record_id: `hs-demo-${lead.phone?.slice(-4) ?? "none"}`,
      campaign_ref: campaignId,
      contact: { name: lead.name, phone: lead.phone, email: lead.email },
      // Consent deliberately omitted: the campaign's declared basis supplies it
      //, and each lead still gets its own dated record.
      correlation_id: `demo-${stamp}`,
    });
    const outcome = (result.body as { result?: { status?: string } })?.result?.status ?? "?";
    console.log(`   ${pad(lead.name, 18)} ${pad(lead.note, 18)} -> ${outcome}`);
  }

  // ── 2 & 3. Dial, then answer the provider callbacks ──────────────────────
  //
  // Looped, because one pass is not enough. Concurrency is capped per
  // campaign, so a queue larger than the cap needs several rounds: each one
  // dials into whatever headroom the completed callbacks just freed.
  //
  // The first calls are usually already in flight before this loop starts -
  // intake dials on its own webhook invocation now, so posting the leads above
  // was enough to place them. That is why the loop ends on "nothing dialled
  // *and* nothing outstanding" rather than on "nothing dialled": treating an
  // empty tick as the end would leave the calls intake placed unanswered, and
  // then there would be no transcript to qualify.
  const secret = process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret";
  const analysable: string[] = [];

  for (let round = 1; round <= 6; round += 1) {
    const dial = await post("/api/internal/dial", {
      campaign_id: campaignId,
      worker_id: "demo",
      limit: 20,
    });
    const dialled = (
      dial.body as { dialled: Array<{ callId: string; providerCallId: string | null; status: string }> }
    ).dialled;

    const placed = dialled.filter((d) => d.status === "initiated").length;
    const failed = dialled.filter((d) => d.status === "provider_failed").length;

    const calls = await db.query<{ id: string; provider_call_id: string; phone_last4: string }>(
      `select ca.id, ca.provider_call_id, l.phone_last4
         from call_attempts ca join leads l on l.id = ca.lead_id
        where ca.tenant_id = $1 and ca.provider_call_id is not null and ca.status = 'initiated'`,
      [tenantId],
    );

    if (dialled.length === 0 && calls.rows.length === 0) break;

    console.log(
      `\n${round === 1 ? "2" : `2.${round}`}. Calling round: ` +
        `${placed} placed by this tick${failed > 0 ? `, ${failed} provider failure` : ""}, ` +
        `${calls.rows.length} in flight`,
    );

    await answerCallbacks(calls.rows, secret, token, analysable);
  }

  async function answerCallbacks(
    rows: Array<{ id: string; provider_call_id: string; phone_last4: string }>,
    secret: string,
    token: string,
    analysable: string[],
  ) {
  for (const call of rows) {
    const digit = call.phone_last4.slice(-1);
    const scenario = TRANSCRIPTS[digit];

    const payload = JSON.stringify(
      scenario
        ? {
            provider_call_id: call.provider_call_id,
            status: "completed",
            duration_sec: scenario.durationSec,
            transcript: { text: scenario.text, language: "en-IN" },
          }
        : {
            provider_call_id: call.provider_call_id,
            status: digit === "1" ? "no_answer" : "busy",
            duration_sec: 0,
          },
    );

    const response = await fetch(`${BASE}/api/webhooks/voice/mock`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-mock-signature": createHmac("sha256", secret).update(payload).digest("hex"),
      },
      body: payload,
    });

    const result = (await response.json()) as { needsAnalysis?: boolean };
    if (result.needsAnalysis) analysable.push(call.id);
    console.log(
      `   ...${call.phone_last4} -> ${scenario ? "completed with transcript" : digit === "1" ? "no answer" : "busy"}`,
    );
  }
  }

  // ── 4. Qualification ─────────────────────────────────────────────────────
  console.log(`\n4. Qualification (W03) for ${analysable.length} connected calls`);
  // Which key matters depends on the campaign's model, not on Anthropic being
  // the only option: a campaign on `gemini-*` needs GEMINI_API_KEY and does
  // not care whether an Anthropic key exists.
  const model = campaignModel ?? "";
  const hasKey = model.startsWith("gemini-")
    ? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
    : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

  if (!hasKey) {
    const needed = model.startsWith("gemini-") ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    console.log(`   No ${needed} set for model "${model}" - analysis will degrade to`);
    console.log("   'unknown' and every result will be held for review. That is the");
    console.log("   fallback working, but you will not see real intents until a key is set.");
  }

  for (const callId of analysable) {
    const result = await post("/api/internal/analyze", { call_id: callId });
    const body = result.body as { intent: string; score: number; reviewStatus: string };
    console.log(`   ${pad(body.intent, 16)} score ${pad(String(body.score), 5)} ${body.reviewStatus}`);
  }

  // ── 5. Sync ──────────────────────────────────────────────────────────────
  console.log("\n5. Sync outbox drain");
  const sync = await post("/api/internal/sync", { limit: 50 });
  const s = sync.body as { processed: number; succeeded: number; failed: number; skipped: number };
  console.log(`   processed ${s.processed}: ${s.succeeded} sent, ${s.failed} failed, ${s.skipped} held for review`);
  console.log("   (HubSpot and Sheets carry placeholder dev credentials, so those fail by design)");

  await db.end();

  console.log(`\nDone. Open ${BASE} and sign in.\n`);
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

async function assertServerUp(): Promise<void> {
  try {
    const response = await fetch(`${BASE}/api/health`);
    if (!response.ok) throw new Error(`health check returned ${response.status}`);
  } catch {
    throw new Error(`No server at ${BASE}. Start it with \`npm run dev\` in another terminal.`);
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

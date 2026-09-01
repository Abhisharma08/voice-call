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

const LEADS = [
  { name: "Rahul Sharma", phone: "+919876543210", email: "rahul@example.com", note: "hot" },
  { name: "Priya Nair", phone: "+919876543220", email: "priya@example.com", note: "hot" },
  { name: "Amit Verma", phone: "+919876543211", email: "amit@example.com", note: "no answer" },
  { name: "Sneha Rao", phone: "+919876543212", email: "sneha@example.com", note: "busy" },
  { name: "Vikram Singh", phone: "+919876543213", email: "vikram@example.com", note: "not interested" },
  { name: "Anita Desai", phone: "+919876543214", email: "anita@example.com", note: "do not call" },
  { name: "Karan Mehta", phone: "+919876543215", email: "karan@example.com", note: "callback" },
  { name: "Deepa Iyer", phone: "+919876543219", email: "deepa@example.com", note: "provider failure" },
  { name: "No Phone Person", phone: null, email: "nophone@example.com", note: "quarantined" },
];

/** The transcripts the mock provider returns, keyed by scenario digit. */
const TRANSCRIPTS: Record<string, { durationSec: number; text: string }> = {
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

  try {
    await db.query("begin");
    await db.query(`select set_config('app.global_scope', 'on', true)`);

    const tenant = await db.query<{ id: string }>(
      `select id from tenants where slug = 'acme-real-estate'`,
    );
    tenantId = tenant.rows[0]?.id ?? "";
    if (!tenantId) throw new Error("Run `npm run db:reset` first");

    const campaign = await db.query<{ id: string; compliance_approved_at: Date | null }>(
      `select id, compliance_approved_at from campaigns where tenant_id = $1 and name = 'Noida 2BHK'`,
      [tenantId],
    );
    campaignId = campaign.rows[0]?.id ?? "";
    if (!campaignId) throw new Error("Run `npm run db:reset` first");

    if (!campaign.rows[0]?.compliance_approved_at) {
      throw new Error(
        "The demo campaign has not passed the compliance gate. Run `npm run db:reset`, or approve it in the UI.",
      );
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
      // (PRD 14.3 step 10), and each lead still gets its own dated record.
      correlation_id: `demo-${stamp}`,
    });
    const outcome = (result.body as { result?: { status?: string } })?.result?.status ?? "?";
    console.log(`   ${pad(lead.name, 18)} ${pad(lead.note, 18)} -> ${outcome}`);
  }

  // ── 2 & 3. Dial, then answer the provider callbacks ──────────────────────
  //
  // Looped, because that is what n8n does. FR-022 caps concurrent calls per
  // campaign, so a queue larger than the cap needs several ticks - the first
  // one here fills the cap, and each subsequent one picks up whatever the
  // completed callbacks freed.
  const secret = process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret";
  const analysable: string[] = [];

  for (let tick = 1; tick <= 4; tick += 1) {
    const dial = await post("/api/internal/dial", {
      campaign_id: campaignId,
      worker_id: "demo",
      limit: 20,
    });
    const dialled = (
      dial.body as { dialled: Array<{ callId: string; providerCallId: string | null; status: string }> }
    ).dialled;

    if (dialled.length === 0) break;

    const placed = dialled.filter((d) => d.status === "initiated").length;
    const failed = dialled.filter((d) => d.status === "provider_failed").length;
    console.log(
      `\n${tick === 1 ? "2" : `2.${tick}`}. Calling worker tick (W02): ` +
        `${placed} placed${failed > 0 ? `, ${failed} provider failure` : ""}`,
    );

    const calls = await db.query<{ id: string; provider_call_id: string; phone_last4: string }>(
      `select ca.id, ca.provider_call_id, l.phone_last4
         from call_attempts ca join leads l on l.id = ca.lead_id
        where ca.tenant_id = $1 and ca.provider_call_id is not null and ca.status = 'initiated'`,
      [tenantId],
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
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasKey) {
    console.log("   No ANTHROPIC_API_KEY set - analysis will degrade to 'unknown' and every");
    console.log("   result will be held for review. That is the PRD 18.2 fallback working,");
    console.log("   but you will not see real intents until a key is available.");
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

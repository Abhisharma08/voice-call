import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import { ingestLead } from "@/lib/leads/intake";
import { runCallingTick } from "@/lib/calling/worker";
import { recordCallResult } from "@/lib/calling/results";
import { qualifyCall } from "@/lib/qualification/pipeline";
import { resolveReview } from "@/lib/qualification/resolve";
import { drainSyncOutbox } from "@/lib/integrations/sync-worker";
import { resolveProvider } from "@/lib/providers/voice";
import { MockVoiceProvider, resetMockProvider } from "@/lib/providers/voice/mock";
import { __setAnthropicClient } from "@/lib/qualification/analyze";
import { QualificationSchema, unknownResult, type QualificationResult } from "@/lib/qualification/schema";
import { blindIndex } from "@/lib/crypto/pii";
import { sealSecret } from "@/lib/crypto/kms";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The Phase 1 vertical slice, end to end: HubSpot-shaped event -> intake ->
 * queue -> call -> provider webhook -> qualification -> review gate -> sync.
 *
 * The Anthropic client is stubbed so the suite is deterministic and free to
 * run in CI. Everything else - the queue, the locks, the RLS scope, the
 * outbox - is the real implementation against a real PostgreSQL.
 */

const TENANT = "a1a1a1a1-0000-4000-8000-000000000001";
const OTHER_TENANT = "b2b2b2b2-0000-4000-8000-000000000002";
const CAMPAIGN = "c3c3c3c3-0000-4000-8000-000000000003";
const OPERATOR = "d4d4d4d4-0000-4000-8000-000000000004";

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: null,
  actorType: "service",
};

/** Stub the model so tests assert the pipeline, not Claude's judgement. */
function stubAnthropic(next: () => QualificationResult) {
  __setAnthropicClient({
    messages: {
      parse: vi.fn(async () => ({
        parsed_output: QualificationSchema.parse(next()),
        model: "stub-model",
        usage: { input_tokens: 900, output_tokens: 120 },
      })),
    },
  } as unknown as Anthropic);
}

async function asGlobal<T>(fn: () => Promise<T>): Promise<T> {
  await owner.query("begin");
  await owner.query(`select set_config('app.global_scope', 'on', true)`);
  try {
    const out = await fn();
    await owner.query("commit");
    return out;
  } catch (err) {
    await owner.query("rollback").catch(() => {});
    throw err;
  }
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  await asGlobal(async () => {
    await owner.query(
      `insert into tenants (id, name, slug, timezone) values
         ($1, 'Slice Test Co', 'slice-test-co', 'Asia/Kolkata'),
         ($2, 'Other Co', 'slice-other-co', 'Asia/Kolkata')
       on conflict (id) do nothing`,
      [TENANT, OTHER_TENANT],
    );

    await owner.query(
      `insert into users (id, email, name, role) values ($1, 'slice-ops@agency.test', 'Slice Ops', 'operations_manager')
       on conflict (id) do nothing`,
      [OPERATOR],
    );

    await owner.query(
      `insert into campaigns
         (id, tenant_id, name, domain, business_context, script, timezone, active,
          voice_provider, calling_config, routing_config, scoring_rubric,
          compliance_approved_at, google_sheet_id, google_sheet_tab,
          review_confidence_threshold, review_boundary_band,
          consent_basis, consent_source)
       values ($1, $2, 'Slice Campaign', 'residential_property', 'Test context', 'Hello', 'Asia/Kolkata', true,
               'mock', $3::jsonb, $4::jsonb, '{}'::jsonb, now(), 'sheet-1', 'Call Log!A:V', 0.750, 5,
               -- Migration 0005 forbids a compliance approval without a
               -- recorded consent basis for the list (PRD 14.3 step 10).
               'opt_in_form', 'slice_test_list')
       on conflict (id) do nothing`,
      [
        CAMPAIGN,
        TENANT,
        JSON.stringify({
          window_start: "00:00",
          window_end: "23:59",
          max_attempts: 3,
          retry_minutes: [15, 120, 1440],
          country: "IN",
        }),
        JSON.stringify({ hot_threshold: 75, interested_threshold: 50 }),
      ],
    );

    await owner.query(
      `insert into qualification_rules (tenant_id, campaign_id, field_name, question, required, position)
       values ($1, $2, 'still_interested', 'Still looking?', true, 1)
       on conflict (campaign_id, field_name) do nothing`,
      [TENANT, CAMPAIGN],
    );

    // Real envelope-encrypted credentials, so the sync worker exercises the
    // actual secret-loading path and only the HTTP client is stubbed.
    for (const purpose of ["hubspot", "google_sheets"] as const) {
      const sealed = sealSecret(JSON.stringify({ accessToken: "test", client_email: "t@t", private_key: "k" }), purpose);
      const secret = await owner.query<{ id: string }>(
        `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [TENANT, purpose, sealed.keyId, sealed.wrappedDek, sealed.iv, sealed.ciphertext, sealed.authTag],
      );
      await owner.query(
        `insert into integrations (tenant_id, type, name, credential_ref)
         values ($1, $2, $3, $4)`,
        [TENANT, purpose, `slice ${purpose}`, secret.rows[0]!.id],
      );
    }
  });
});

beforeEach(async () => {
  resetMockProvider();
  await asGlobal(async () => {
    await owner.query(`delete from leads where tenant_id = any($1::uuid[])`, [[TENANT, OTHER_TENANT]]);
    await owner.query(`delete from dnc_entries where tenant_id = $1`, [TENANT]);
    await owner.query(`delete from sync_outbox where tenant_id = $1`, [TENANT]);
    await owner.query(`delete from webhook_events where tenant_id = $1`, [TENANT]);
  });
});

afterAll(async () => {
  __setAnthropicClient(null);
  await asGlobal(async () => {
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT, OTHER_TENANT]]);
    await owner.query(`delete from users where id = $1`, [OPERATOR]);
  });
  await owner.end();
  await closePools();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONSENT = {
  basis: "opt_in_form" as const,
  source: "landing_page_form",
  evidenceRef: "form-sub-123",
  capturedAt: null,
};

function leadEvent(phone: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    campaignId: CAMPAIGN,
    source: "hubspot",
    recordId: `hs-${phone.slice(-6)}`,
    contact: { name: "Rahul Sharma", phone, email: `lead${phone.slice(-4)}@example.com` },
    consent: CONSENT,
    correlationId: "corr-1",
    ...overrides,
  };
}

/** Drive one lead all the way to a persisted analysis. */
async function runToAnalysis(phone: string): Promise<{ leadId: string; callId: string }> {
  const leadId = await withScope(scope, async (tx) => {
    const outcome = await ingestLead(tx, leadEvent(phone));
    return outcome.leadId;
  });

  const callId = await withScope(scope, async (tx) => {
    const tick = await runCallingTick(tx, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      workerId: "test-worker",
      webhookBaseUrl: "http://localhost:3000",
    });
    return tick.dialled[0]?.callId ?? null;
  });

  if (!callId) throw new Error("No call was placed");

  const providerCallId = await withScope(scope, async (tx) => {
    const r = await tx.query<{ provider_call_id: string }>(
      `select provider_call_id from call_attempts where id = $1`,
      [callId],
    );
    return r.rows[0]!.provider_call_id;
  });

  const provider = resolveProvider("mock") as MockVoiceProvider;
  const body = provider.buildWebhookPayload(providerCallId);
  const { signWebhook } = await import("@/lib/providers/voice/mock");
  const webhook = provider.handleWebhook(body, {
    "x-mock-signature": signWebhook(body, process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret"),
  });

  await withScope(scope, (tx) =>
    recordCallResult(tx, { tenantId: TENANT, provider: "mock", webhook }),
  );

  await withScope(scope, (tx) => qualifyCall(tx, { tenantId: TENANT, callId }));

  return { leadId, callId };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("intake (FR-010 to FR-014)", () => {
  it("queues an eligible lead with consent", async () => {
    const outcome = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    expect(outcome.status).toBe("queued");

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; phone_last4: string; phone_enc: Buffer }>(
          `select status, phone_last4, phone_enc from leads where id = $1`,
          [outcome.leadId],
        )
      ).rows[0],
    );

    expect(lead?.status).toBe("queued");
    expect(lead?.phone_last4).toBe("3210");
    // PRD 26.2: the number is ciphertext in the column, not plaintext.
    expect(lead?.phone_enc.toString("utf8")).not.toContain("9876543210");
  });

  it("quarantines a lead with no callable number and records why (FR-012)", async () => {
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, leadEvent("+919876543210", { contact: { name: "No Phone", phone: null } })),
    );

    expect(outcome.status).toBe("quarantined");
    const reason = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status_reason: string }>(`select status_reason from leads where id = $1`, [
          outcome.leadId,
        ])
      ).rows[0]?.status_reason,
    );
    expect(reason).toMatch(/missing/);
  });

  it("suppresses a lead with no consent anywhere (PRD 26.1)", async () => {
    // Phase 2 added a campaign-level consent declaration, and intake mints a
    // per-lead consents row from it. So "no consent" now means neither the
    // event nor the campaign carries a basis - which is what this clears.
    // "No consent anywhere" now means: nothing on the event, nothing declared
    // on the campaign, and the campaign set to require an explicit record
    // rather than inherit from the funnel (migration 0006).
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_basis = null, consent_source = null,
                consent_mode = 'require_record'
          where id = $1`,
        [CAMPAIGN],
      ),
    );

    try {
      const outcome = await withScope(scope, (tx) =>
        ingestLead(tx, leadEvent("+919876543210", { consent: null })),
      );

      expect(outcome.status).toBe("suppressed");

      // checkEligibility reports the most serious reason, and an unapproved
      // campaign outranks a missing consent. The claim under test is that
      // nothing was minted on the lead's behalf.
      const consents = await withScope(scope, async (tx) =>
        (await tx.query(`select 1 from consents where lead_id = $1`, [outcome.leadId])).rowCount,
      );
      expect(consents).toBe(0);
    } finally {
      await asGlobal(() =>
        owner.query(
          `update campaigns set consent_basis = 'opt_in_form', consent_source = 'slice_test_list',
                  consent_mode = 'require_record', compliance_approved_at = now()
            where id = $1`,
          [CAMPAIGN],
        ),
      );
    }
  });

  it("queues a lead with no event consent when the campaign declares a basis", async () => {
    // PRD 14.3 step 10: the Campaign Manager records the basis for the
    // client's list once, and every lead from that list cites it.
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, leadEvent("+919876543210", { consent: null })),
    );

    expect(outcome.status).toBe("queued");

    const consent = await withScope(scope, async (tx) =>
      (
        await tx.query<{ captured_by: string }>(
          `select captured_by from consents where lead_id = $1`,
          [outcome.leadId],
        )
      ).rows[0],
    );
    expect(consent?.captured_by).toBe("campaign_declaration");
  });

  it("deduplicates a repeated event rather than creating a second lead (FR-013)", async () => {
    const first = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    const second = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));

    expect(second.leadId).toBe(first.leadId);
    const count = await withScope(scope, async (tx) =>
      (await tx.query(`select 1 from leads`)).rowCount,
    );
    expect(count).toBe(1);
  });

  it("deduplicates on phone even when the CRM record id differs", async () => {
    const first = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    const second = await withScope(scope, (tx) =>
      ingestLead(tx, leadEvent("+919876543210", { recordId: "hs-different" })),
    );
    expect(second.leadId).toBe(first.leadId);
  });

  it("normalises variant spellings to the same lead", async () => {
    const first = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    const second = await withScope(scope, (tx) =>
      ingestLead(tx, leadEvent("098765 43210", { recordId: null })),
    );
    expect(second.leadId).toBe(first.leadId);
  });

  it("suppresses a lead already on the tenant DNC list (PRD 17.4)", async () => {
    await asGlobal(async () => {
      await owner.query(
        `insert into dnc_entries (tenant_id, scope, phone_bidx, source)
         values ($1, 'tenant', $2, 'import')`,
        [TENANT, blindIndex(TENANT, "+919876543210")],
      );
    });

    const outcome = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    expect(outcome.status).toBe("suppressed");
    if (outcome.status === "suppressed") expect(outcome.reason).toBe("dnc_tenant");
  });

  it("refuses to queue for a campaign that has not passed compliance review (PRD 17.3)", async () => {
    await asGlobal(() => owner.query(`update campaigns set compliance_approved_at = null where id = $1`, [CAMPAIGN]));

    const outcome = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    expect(outcome.status).toBe("suppressed");
    if (outcome.status === "suppressed") {
      expect(outcome.reason).toBe("campaign_not_compliance_approved");
    }

    await asGlobal(() => owner.query(`update campaigns set compliance_approved_at = now() where id = $1`, [CAMPAIGN]));
  });
});

describe("calling worker (FR-020 to FR-025)", () => {
  it("places a call and writes a durable record before dialling", async () => {
    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));

    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "test-worker",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    expect(tick.dialled).toHaveLength(1);
    expect(tick.dialled[0]?.status).toBe("initiated");

    const call = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; consent_basis: string; attempt_no: number }>(
          `select status, consent_basis, attempt_no from call_attempts`,
        )
      ).rows[0],
    );

    // PRD 26.1: the consent basis is stamped at call time.
    expect(call?.consent_basis).toBe("opt_in_form");
    expect(call?.attempt_no).toBe(1);
  });

  it("does not dial twice for the same lead in one tick", async () => {
    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));

    await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );
    const second = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w2",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    expect(second.dialled).toHaveLength(0);
  });

  it("respects the campaign concurrency cap (FR-022)", async () => {
    await asGlobal(() => owner.query(`update campaigns set concurrency_limit = 2 where id = $1`, [CAMPAIGN]));

    for (const phone of ["+919876543210", "+919876543310", "+919876543410"]) {
      await withScope(scope, (tx) => ingestLead(tx, leadEvent(phone)));
    }

    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    expect(tick.dialled.length).toBeLessThanOrEqual(2);
    await asGlobal(() => owner.query(`update campaigns set concurrency_limit = 5 where id = $1`, [CAMPAIGN]));
  });

  it("defers the queue outside the calling window (FR-021)", async () => {
    await asGlobal(() =>
      owner.query(
        `update campaigns set calling_config = jsonb_set(
           jsonb_set(calling_config, '{window_start}', '"09:30"'), '{window_end}', '"09:31"')
          where id = $1`,
        [CAMPAIGN],
      ),
    );

    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));

    // 20:00 IST is outside a 09:30-09:31 window.
    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
        now: new Date("2026-09-01T14:30:00Z"),
      }),
    );

    expect(tick.dialled).toHaveLength(0);
    expect(tick.skipped[0]?.reason).toBe("outside_calling_window");

    await asGlobal(() =>
      owner.query(
        `update campaigns set calling_config = jsonb_set(
           jsonb_set(calling_config, '{window_start}', '"00:00"'), '{window_end}', '"23:59"')
          where id = $1`,
        [CAMPAIGN],
      ),
    );
  });

  it("requeues with backoff when the provider fails transiently (PRD 18.2)", async () => {
    // The mock treats a number ending in 9 as a transient provider failure.
    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543219")));

    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    expect(tick.dialled[0]?.status).toBe("provider_failed");

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; next_call_at: Date | null }>(
          `select status, next_call_at from leads`,
        )
      ).rows[0],
    );
    expect(lead?.status).toBe("queued");
    expect(lead?.next_call_at).not.toBeNull();
  });
});

describe("call results and retries (FR-023, FR-024, PRD 18.1)", () => {
  it("ignores a duplicate terminal webhook", async () => {
    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    const callId = tick.dialled[0]!.callId!;
    const providerCallId = tick.dialled[0]!.providerCallId!;
    const provider = resolveProvider("mock") as MockVoiceProvider;
    const { signWebhook } = await import("@/lib/providers/voice/mock");
    const body = provider.buildWebhookPayload(providerCallId);
    const webhook = provider.handleWebhook(body, {
      "x-mock-signature": signWebhook(body, process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret"),
    });

    const first = await withScope(scope, (tx) =>
      recordCallResult(tx, { tenantId: TENANT, provider: "mock", webhook }),
    );
    const second = await withScope(scope, (tx) =>
      recordCallResult(tx, { tenantId: TENANT, provider: "mock", webhook }),
    );

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("duplicate");

    const transcripts = await withScope(scope, async (tx) =>
      (await tx.query(`select 1 from call_transcripts where call_id = $1`, [callId])).rowCount,
    );
    expect(transcripts).toBe(1);
  });

  it("permanently suppresses a lead the carrier reports as NDNC-registered", async () => {
    // The Sarvam adapter classifies "registered under TRAI NDNC" as a legal
    // suppression rather than a failed call. This asserts the platform half:
    // the lead goes on the tenant DNC list and cannot be re-queued.
    await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    const tick = await withScope(scope, (tx) =>
      runCallingTick(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        workerId: "w1",
        webhookBaseUrl: "http://localhost:3000",
      }),
    );

    const leadId = tick.dialled[0]!.leadId;
    const providerCallId = tick.dialled[0]!.providerCallId!;

    await withScope(scope, (tx) =>
      recordCallResult(tx, {
        tenantId: TENANT,
        provider: "mock",
        webhook: {
          providerCallId,
          status: "failed",
          failureReason: "exotel: Phone number is registered under TRAI NDNC",
          suppress: { reason: "trai_ndnc_registered", permanent: true },
        },
      }),
    );

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; dnc: boolean; next_call_at: Date | null }>(
          `select status, dnc, next_call_at from leads where id = $1`,
          [leadId],
        )
      ).rows[0],
    );

    expect(lead?.status).toBe("suppressed");
    expect(lead?.dnc).toBe(true);
    expect(lead?.next_call_at).toBeNull();

    // A fresh inbound event must not resurrect it.
    const requeue = await withScope(scope, (tx) =>
      ingestLead(tx, leadEvent("+919876543210", { recordId: "hs-retry" })),
    );
    expect(requeue.status).not.toBe("queued");

    const audit = await withScope(scope, async (tx) =>
      (
        await tx.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_events
            where action = 'lead.carrier_suppressed' and entity_id = $1`,
          [leadId],
        )
      ).rows[0],
    );
    expect(audit?.metadata.reason).toBe("trai_ndnc_registered");
  });

  it("schedules a retry after a no-answer", async () => {
    stubAnthropic(() => unknownResult("unused"));
    // Numbers ending in 1 produce a no-answer from the mock provider.
    await runToAnalysis("+919876543211").catch(() => undefined);

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; next_call_at: Date | null; call_attempt_count: number }>(
          `select status, next_call_at, call_attempt_count from leads`,
        )
      ).rows[0],
    );

    expect(lead?.status).toBe("queued");
    expect(lead?.call_attempt_count).toBe(1);
    expect(lead?.next_call_at).not.toBeNull();
  });
});

describe("qualification and the review gate (FR-030 to FR-035, PRD 26.3)", () => {
  it("auto-approves a confident hot result and enqueues the syncs", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.95,
      reason: "Lead is actively looking and asked for an advisor",
      summary: "Actively searching; requests advisor",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50-75 lakh",
      location: "Noida",
      product_interest: "2BHK",
      human_followup: true,
    }));

    const { callId } = await runToAnalysis("+919876543210");

    const analysis = await withScope(scope, async (tx) =>
      (
        await tx.query<{ intent: string; score: number; review_status: string }>(
          `select intent, score, review_status from call_analyses where call_id = $1`,
          [callId],
        )
      ).rows[0],
    );

    expect(analysis?.intent).toBe("hot");
    expect(analysis?.score).toBe(90);
    expect(analysis?.review_status).toBe("auto_approved");

    const outbox = await withScope(scope, async (tx) =>
      (await tx.query<{ target: string }>(`select target from sync_outbox`)).rows,
    );
    // Sorted here rather than in SQL: `target` is an enum, so ORDER BY uses
    // the enum's declaration order, not alphabetical.
    expect(outbox.map((o) => o.target).sort()).toEqual([
      "google_sheets",
      "hubspot",
      "notification",
    ]);
  });

  it("holds a low-confidence result and enqueues nothing (FR-035)", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.4,
      reason: "Ambiguous",
      summary: "Hard to tell",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50-75 lakh",
      product_interest: "2BHK",
      human_followup: true,
    }));

    const { callId, leadId } = await runToAnalysis("+919876543210");

    const analysis = await withScope(scope, async (tx) =>
      (
        await tx.query<{ review_status: string; review_reason: string }>(
          `select review_status, review_reason from call_analyses where call_id = $1`,
          [callId],
        )
      ).rows[0],
    );

    expect(analysis?.review_status).toBe("pending_review");
    expect(analysis?.review_reason).toMatch(/confidence/);

    // PRD 26.3: excluded from auto-sync until an operator resolves it.
    const outbox = await withScope(scope, async (tx) =>
      (await tx.query(`select 1 from sync_outbox`)).rowCount,
    );
    expect(outbox).toBe(0);

    const lead = await withScope(scope, async (tx) =>
      (await tx.query<{ status: string }>(`select status from leads where id = $1`, [leadId])).rows[0],
    );
    expect(lead?.status).toBe("pending_review");
  });

  it("holds a result missing a required qualification field", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "interested",
      confidence: 0.95,
      reason: "Interested",
      summary: "Interested but did not confirm",
      // still_interested is required by the campaign fixture and is null here.
      still_interested: null,
      timeline: "3-6_months",
      budget: "50 lakh",
      product_interest: "2BHK",
    }));

    const { callId } = await runToAnalysis("+919876543210");
    const analysis = await withScope(scope, async (tx) =>
      (
        await tx.query<{ review_status: string; review_reason: string }>(
          `select review_status, review_reason from call_analyses where call_id = $1`,
          [callId],
        )
      ).rows[0],
    );

    expect(analysis?.review_status).toBe("pending_review");
    expect(analysis?.review_reason).toMatch(/still_interested/);
  });

  it("suppresses permanently on a confident do-not-call (FR-025, PRD 7.4)", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "do_not_call",
      confidence: 0.99,
      reason: "Lead asked to be removed",
      summary: "Do not call again",
      do_not_call: true,
    }));

    const { leadId } = await runToAnalysis("+919876543210");

    const lead = await withScope(scope, async (tx) =>
      (
        await tx.query<{ status: string; dnc: boolean; next_call_at: Date | null }>(
          `select status, dnc, next_call_at from leads where id = $1`,
          [leadId],
        )
      ).rows[0],
    );

    expect(lead?.status).toBe("suppressed");
    expect(lead?.dnc).toBe(true);
    expect(lead?.next_call_at).toBeNull();

    // The number is on the tenant DNC list, so a fresh event cannot re-queue it.
    const requeue = await withScope(scope, (tx) => ingestLead(tx, leadEvent("+919876543210")));
    expect(requeue.status).not.toBe("queued");
  });

  it("creates a callback when the lead asks for one", async () => {
    const when = new Date(Date.now() + 3 * 3600_000).toISOString();
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "follow_up",
      confidence: 0.95,
      reason: "Asked for a callback",
      summary: "Driving; call back later",
      still_interested: true,
      callback_requested: true,
      callback_time_iso: when,
    }));

    const { leadId } = await runToAnalysis("+919876543210");

    const callback = await withScope(scope, async (tx) =>
      (
        await tx.query<{ scheduled_for: Date; status: string }>(
          `select scheduled_for, status from callbacks where lead_id = $1`,
          [leadId],
        )
      ).rows[0],
    );

    expect(callback?.status).toBe("scheduled");
    expect(callback?.scheduled_for.toISOString()).toBe(when);
  });

  it("holds the result and does not call the model when analysis degrades", async () => {
    __setAnthropicClient({
      messages: { parse: vi.fn(async () => ({ parsed_output: null, model: "stub", usage: { input_tokens: 1, output_tokens: 1 } })) },
    } as unknown as Anthropic);

    const { callId } = await runToAnalysis("+919876543210");
    const analysis = await withScope(scope, async (tx) =>
      (
        await tx.query<{ intent: string; review_status: string }>(
          `select intent, review_status from call_analyses where call_id = $1`,
          [callId],
        )
      ).rows[0],
    );

    // PRD 18.2: "LLM schema failure -> Fallback to manual review."
    expect(analysis?.intent).toBe("unknown");
    expect(analysis?.review_status).toBe("pending_review");
  });

  it("does not analyse the same call twice", async () => {
    stubAnthropic(() => ({ ...unknownResult(""), intent: "hot", confidence: 0.95, still_interested: true }));
    const { callId } = await runToAnalysis("+919876543210");

    await withScope(scope, (tx) => qualifyCall(tx, { tenantId: TENANT, callId }));

    const count = await withScope(scope, async (tx) =>
      (await tx.query(`select 1 from call_analyses where call_id = $1`, [callId])).rowCount,
    );
    expect(count).toBe(1);
  });
});

describe("review resolution (PRD 26.3)", () => {
  it("releases a confirmed result to the sync queue", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.4,
      reason: "Ambiguous",
      summary: "Maybe hot",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50 lakh",
      product_interest: "2BHK",
      human_followup: true,
    }));

    const { callId } = await runToAnalysis("+919876543210");
    const analysisId = await withScope(scope, async (tx) =>
      (await tx.query<{ id: string }>(`select id from call_analyses where call_id = $1`, [callId]))
        .rows[0]!.id,
    );

    const userScope: TenantScope = { ...scope, actorId: OPERATOR, actorType: "user" };
    const resolved = await withScope(userScope, (tx) =>
      resolveReview(tx, {
        tenantId: TENANT,
        analysisId,
        action: "confirm",
        reviewerId: OPERATOR,
        reviewerLabel: "slice-ops@agency.test",
      }),
    );

    expect(resolved.reviewStatus).toBe("confirmed");

    const outbox = await withScope(scope, async (tx) =>
      (await tx.query(`select 1 from sync_outbox`)).rowCount,
    );
    expect(outbox).toBeGreaterThan(0);
  });

  it("re-scores from the campaign rubric when an operator corrects the intent", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.4,
      reason: "Ambiguous",
      summary: "Maybe hot",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50 lakh",
      product_interest: "2BHK",
      human_followup: true,
    }));

    const { callId } = await runToAnalysis("+919876543210");
    const analysisId = await withScope(scope, async (tx) =>
      (await tx.query<{ id: string }>(`select id from call_analyses where call_id = $1`, [callId]))
        .rows[0]!.id,
    );

    const userScope: TenantScope = { ...scope, actorId: OPERATOR, actorType: "user" };
    const resolved = await withScope(userScope, (tx) =>
      resolveReview(tx, {
        tenantId: TENANT,
        analysisId,
        action: "correct",
        corrections: { intent: "not_interested" },
        reviewerId: OPERATOR,
        reviewerLabel: "slice-ops@agency.test",
        note: "Lead actually declined",
      }),
    );

    // The operator changed the intent; the score follows the rubric, not the UI.
    expect(resolved.reviewStatus).toBe("corrected");
    expect(resolved.score).toBe(-100);
    expect(resolved.routingAction).toBe("stop_campaign");

    const audit = await withScope(scope, async (tx) =>
      (
        await tx.query<{ actor_type: string; metadata: Record<string, unknown> }>(
          `select actor_type, metadata from audit_events
            where action = 'review.corrected' and entity_id = $1`,
          [analysisId],
        )
      ).rows[0],
    );

    // PRD 26.3: "correction logged to audit_events with actor_type=human".
    expect(audit?.actor_type).toBe("user");
    expect(audit?.metadata.changed_fields).toContain("intent");
  });

  it("refuses to resolve the same analysis twice", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.4,
      reason: "x",
      summary: "x",
      still_interested: true,
    }));

    const { callId } = await runToAnalysis("+919876543210");
    const analysisId = await withScope(scope, async (tx) =>
      (await tx.query<{ id: string }>(`select id from call_analyses where call_id = $1`, [callId]))
        .rows[0]!.id,
    );

    const userScope: TenantScope = { ...scope, actorId: OPERATOR, actorType: "user" };
    const args = {
      tenantId: TENANT,
      analysisId,
      action: "confirm" as const,
      reviewerId: OPERATOR,
      reviewerLabel: "slice-ops@agency.test",
    };

    await withScope(userScope, (tx) => resolveReview(tx, args));
    await expect(withScope(userScope, (tx) => resolveReview(tx, args))).rejects.toThrow(
      /not pending review/,
    );
  });
});

describe("sync outbox (PRD 18.2)", () => {
  it("does not send a held result even if a row is enqueued", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.4,
      reason: "x",
      summary: "x",
      still_interested: true,
    }));

    const { callId } = await runToAnalysis("+919876543210");

    // Force a row in, as a stale enqueue or a manual replay might.
    await withScope(scope, async (tx) => {
      await tx.query(
        `insert into sync_outbox (tenant_id, target, dedupe_key, payload)
         values ($1, 'google_sheets', $2, $3)`,
        [TENANT, callId, JSON.stringify({ call_id: callId })],
      );
    });

    const appendRow = vi.fn(async () => undefined);
    const result = await withScope(scope, (tx) =>
      drainSyncOutbox(tx, {
        sheetsFactory: () => ({ appendRow }) as never,
      }),
    );

    expect(result.skipped).toBe(1);
    expect(appendRow).not.toHaveBeenCalled();
  });

  it("appends a masked phone number to the sheet, never the full one (PRD 26.2)", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.95,
      reason: "Ready",
      summary: "Actively searching",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50 lakh",
      product_interest: "2BHK",
      human_followup: true,
    }));

    await runToAnalysis("+919876543210");

    const appendRow = vi.fn(async () => undefined);
    await withScope(scope, (tx) =>
      drainSyncOutbox(tx, {
        sheetsFactory: () => ({ appendRow }) as never,
        hubspotFactory: () => ({ updateContact: async () => undefined, createTask: async () => undefined }) as never,
        notifier: async () => undefined,
      }),
    );

    expect(appendRow).toHaveBeenCalled();
    const args = appendRow.mock.calls[0] as unknown as [{ row: Record<string, string> }];
    const row = args[0].row;
    expect(row.phone).toBe("******3210");
    expect(JSON.stringify(row)).not.toContain("9876543210");
  });

  it("retries a transient failure and dead-letters a permanent one", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.95,
      reason: "x",
      summary: "x",
      still_interested: true,
      timeline: "0-3_months",
      budget: "50 lakh",
      product_interest: "2BHK",
      human_followup: true,
    }));

    await runToAnalysis("+919876543210");

    const { IntegrationError } = await import("@/lib/integrations/hubspot");

    await withScope(scope, (tx) =>
      drainSyncOutbox(tx, {
        sheetsFactory: () =>
          ({
            appendRow: async () => {
              throw new IntegrationError("Sheets transient error 503", true, 503);
            },
          }) as never,
        hubspotFactory: () =>
          ({
            updateContact: async () => {
              throw new IntegrationError("HubSpot record not found", false, 404);
            },
            createTask: async () => undefined,
          }) as never,
        notifier: async () => undefined,
      }),
    );

    const rows = await withScope(scope, async (tx) =>
      (
        await tx.query<{ target: string; status: string; attempts: number }>(
          `select target, status, attempts from sync_outbox order by target`,
        )
      ).rows,
    );

    const sheets = rows.find((r) => r.target === "google_sheets");
    const hubspot = rows.find((r) => r.target === "hubspot");

    expect(sheets?.status).toBe("failed");
    expect(hubspot?.status).toBe("dead_letter");
  });
});

describe("tenant isolation across the pipeline (PRD 8.2)", () => {
  it("does not let another tenant's scope see these leads or calls", async () => {
    stubAnthropic(() => ({
      ...unknownResult(""),
      intent: "hot",
      confidence: 0.95,
      reason: "x",
      summary: "x",
      still_interested: true,
    }));

    await runToAnalysis("+919876543210");

    const otherScope: TenantScope = {
      tenantId: OTHER_TENANT,
      globalScope: false,
      actorId: null,
      actorType: "service",
    };

    const counts = await withScope(otherScope, async (tx) => ({
      leads: (await tx.query(`select 1 from leads`)).rowCount,
      calls: (await tx.query(`select 1 from call_attempts`)).rowCount,
      analyses: (await tx.query(`select 1 from call_analyses`)).rowCount,
      transcripts: (await tx.query(`select 1 from call_transcripts`)).rowCount,
      outbox: (await tx.query(`select 1 from sync_outbox`)).rowCount,
    }));

    expect(counts).toEqual({ leads: 0, calls: 0, analyses: 0, transcripts: 0, outbox: 0 });
  });

  it("refuses to dial a campaign belonging to another tenant", async () => {
    const otherScope: TenantScope = {
      tenantId: OTHER_TENANT,
      globalScope: false,
      actorId: null,
      actorType: "service",
    };

    await expect(
      withScope(otherScope, (tx) =>
        runCallingTick(tx, {
          tenantId: OTHER_TENANT,
          campaignId: CAMPAIGN,
          workerId: "w1",
          webhookBaseUrl: "http://localhost:3000",
        }),
      ),
    ).rejects.toThrow(/Campaign not found/);
  });
});

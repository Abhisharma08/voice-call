import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import {
  CampaignConfigSchema,
  DEFAULT_CAMPAIGN_CONFIG,
  activationBlockers,
  loadCampaignConfig,
  saveCampaignConfig,
} from "@/lib/campaigns/config";
import { ingestLead } from "@/lib/leads/intake";
import { claimLeads } from "@/lib/calling/queue";

/**
 * Phase 2: configuration-driven multi-tenancy.
 *
 * The claim being tested is the PRD's opening design principle - "One reusable
 * calling platform; client-specific behavior comes from configuration and
 * tenant-scoped data, not duplicated workflows." So these tests change only
 * configuration and assert the behaviour changes with it.
 */

const TENANT = "f1f1f1f1-0000-4000-8000-000000000001";
const CAMPAIGN_A = "f2f2f2f2-0000-4000-8000-000000000002";
const CAMPAIGN_B = "f3f3f3f3-0000-4000-8000-000000000003";
const ADMIN = "f4f4f4f4-0000-4000-8000-000000000004";

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: ADMIN,
  actorType: "user",
};

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
      `insert into tenants (id, name, slug) values ($1, 'Config Test Co', 'config-test-co')
       on conflict (id) do nothing`,
      [TENANT],
    );
    await owner.query(
      `insert into users (id, email, name, role) values ($1, 'config-admin@agency.test', 'Cfg', 'agency_admin')
       on conflict (id) do nothing`,
      [ADMIN],
    );

    // Two campaigns under one client, differing only in configuration.
    for (const [id, name] of [
      [CAMPAIGN_A, "Campaign A"],
      [CAMPAIGN_B, "Campaign B"],
    ] as const) {
      await owner.query(
        `insert into campaigns (id, tenant_id, name, timezone, calling_config, routing_config, scoring_rubric)
         values ($1, $2, $3, 'Asia/Kolkata', $4::jsonb, $5::jsonb, '{}'::jsonb)
         on conflict (id) do nothing`,
        [
          id,
          TENANT,
          name,
          JSON.stringify(DEFAULT_CAMPAIGN_CONFIG.callingConfig),
          JSON.stringify(DEFAULT_CAMPAIGN_CONFIG.routingConfig),
        ],
      );
    }
  });
});

beforeEach(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from leads where tenant_id = $1`, [TENANT]);
    await owner.query(
      `update campaigns set compliance_approved_at = null, compliance_approved_by = null,
              consent_basis = null, consent_source = null, active = false,
              consent_origin = null, dial_allowlist = '{}'
        where tenant_id = $1`,
      [TENANT],
    );
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from tenants where id = $1`, [TENANT]);
    await owner.query(`delete from users where id = $1`, [ADMIN]);
  });
  await owner.end();
  await closePools();
});

const baseConfig = { ...DEFAULT_CAMPAIGN_CONFIG, name: "Campaign A" };

describe("campaign configuration schema", () => {
  it("accepts the defaults", () => {
    expect(CampaignConfigSchema.safeParse(baseConfig).success).toBe(true);
  });

  it("rejects a hot threshold at or below the interested threshold", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      routingConfig: { hot_threshold: 50, interested_threshold: 50 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a calling window that ends before it starts", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      callingConfig: { ...baseConfig.callingConfig, window_start: "18:00", window_end: "09:00" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed time of day", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      callingConfig: { ...baseConfig.callingConfig, window_start: "9:30" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unrecognised timezone", () => {
    // A bad timezone means calling people at the wrong hour, so it fails at
    // save time rather than at dial time.
    expect(CampaignConfigSchema.safeParse({ ...baseConfig, timezone: "Mars/Olympus" }).success).toBe(
      false,
    );
  });

  it("rejects a question field name the model could not return as a key", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      questions: [{ fieldName: "Budget Range", question: "?", required: false, position: 1 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate question field names", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      questions: [
        { fieldName: "budget", question: "a", required: false, position: 1 },
        { fieldName: "budget", question: "b", required: false, position: 2 },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("saving configuration", () => {
  it("bumps the version and snapshots it", async () => {
    const before = await withScope(scope, (tx) => loadCampaignConfig(tx, CAMPAIGN_A));
    expect(before).not.toBeNull();

    const version = await withScope(scope, (tx) =>
      saveCampaignConfig(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        config: { ...baseConfig, script: "Updated opening" },
        userId: ADMIN,
        changeNote: "tightened the opening",
      }),
    );

    expect(version).toBe(before!.configVersion + 1);

    const snapshot = await withScope(scope, async (tx) =>
      (
        await tx.query<{ snapshot: { script: string }; change_note: string }>(
          `select snapshot, change_note from campaign_versions
            where campaign_id = $1 and version = $2`,
          [CAMPAIGN_A, version],
        )
      ).rows[0],
    );

    expect(snapshot?.snapshot.script).toBe("Updated opening");
    expect(snapshot?.change_note).toBe("tightened the opening");
  });

  it("replaces the question set rather than merging it", async () => {
    await withScope(scope, (tx) =>
      saveCampaignConfig(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        config: {
          ...baseConfig,
          questions: [
            { fieldName: "budget", question: "Budget?", required: true, position: 1 },
            { fieldName: "timeline", question: "When?", required: true, position: 2 },
          ],
        },
        userId: ADMIN,
      }),
    );

    // Removing a required question must actually remove it: a lingering
    // required field would hold every later result for review.
    await withScope(scope, (tx) =>
      saveCampaignConfig(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        config: {
          ...baseConfig,
          questions: [{ fieldName: "budget", question: "Budget?", required: false, position: 1 }],
        },
        userId: ADMIN,
      }),
    );

    const after = await withScope(scope, (tx) => loadCampaignConfig(tx, CAMPAIGN_A));
    expect(after!.questions).toHaveLength(1);
    expect(after!.questions[0]!.required).toBe(false);
  });

  it("keeps two campaigns under one client independent", async () => {
    await withScope(scope, (tx) =>
      saveCampaignConfig(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        config: { ...baseConfig, name: "Campaign A", concurrencyLimit: 20 },
        userId: ADMIN,
      }),
    );

    const b = await withScope(scope, (tx) => loadCampaignConfig(tx, CAMPAIGN_B));
    expect(b!.concurrencyLimit).toBe(DEFAULT_CAMPAIGN_CONFIG.concurrencyLimit);
  });

  it("refuses to save into another tenant's campaign", async () => {
    const otherScope: TenantScope = { ...scope, tenantId: "00000000-0000-4000-8000-00000000aaaa" };
    await expect(
      withScope(otherScope, (tx) =>
        saveCampaignConfig(tx, {
          tenantId: otherScope.tenantId!,
          campaignId: CAMPAIGN_A,
          config: baseConfig,
          userId: ADMIN,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe("activation checklist", () => {
  it("still records an approval when one is written, though nothing reads it", async () => {
    // Migration 0006 dropped the precondition. Consent is collected upstream
    // at the form, so a declared basis here was standing in for something the
    // funnel already answers. The attestation below is the check that matters.
    await asGlobal(() =>
      owner.query(`update campaigns set compliance_approved_at = now() where id = $1`, [CAMPAIGN_A]),
    );

    const r = await withScope(scope, async (tx) =>
      (
        await tx.query<{ compliance_approved_at: Date | null; consent_basis: string | null }>(
          `select compliance_approved_at, consent_basis from campaigns where id = $1`,
          [CAMPAIGN_A],
        )
      ).rows[0],
    );
    expect(r?.compliance_approved_at).not.toBeNull();
    expect(r?.consent_basis).toBeNull();
  });

  it("still accepts an explicitly recorded consent basis", async () => {
    await asGlobal(async () => {
      await owner.query(
        `update campaigns set consent_basis = 'opt_in_form', consent_source = 'landing_page_form',
                consent_declared_by = $2, consent_declared_at = now()
          where id = $1`,
        [CAMPAIGN_A, ADMIN],
      );
      await owner.query(`update campaigns set compliance_approved_at = now() where id = $1`, [
        CAMPAIGN_A,
      ]);
    });

    const r = await withScope(scope, async (tx) =>
      (
        await tx.query<{ compliance_approved_at: Date | null }>(
          `select compliance_approved_at from campaigns where id = $1`,
          [CAMPAIGN_A],
        )
      ).rows[0],
    );
    expect(r?.compliance_approved_at).not.toBeNull();
  });

  it("blocks only on what would break a call, never on consent or sign-off", () => {
    const blockers = activationBlockers({
      script: "",
      questions: 0,
      googleSheetId: null,
      hubspotIntegrationId: null,
    });
    // Script, questions, a destination - and nothing about consent or a
    // compliance approval, neither of which gates calling any more.
    expect(blockers).toHaveLength(3);
    expect(blockers.join(" ")).not.toMatch(/consent|compliance/i);
  });

  it("accepts either destination on its own", () => {
    const sheetOnly = activationBlockers({
      script: "Hello",
      questions: 1,
      googleSheetId: "sheet-1",
      hubspotIntegrationId: null,
    });
    const hubspotOnly = activationBlockers({
      script: "Hello",
      questions: 1,
      googleSheetId: null,
      hubspotIntegrationId: "00000000-0000-4000-8000-00000000cccc",
    });
    expect(sheetOnly).toHaveLength(0);
    expect(hubspotOnly).toHaveLength(0);
  });

  it("reports no blockers for a fully configured campaign", () => {
    expect(
      activationBlockers({
        script: "Hello",
        questions: 2,
        googleSheetId: "sheet-1",
        hubspotIntegrationId: "00000000-0000-4000-8000-00000000cccc",
      }),
    ).toHaveLength(0);
  });
});

describe("campaign consent declaration drives intake (PRD 14.3 step 10, 26.1)", () => {
  const event = (campaignId: string) => ({
    tenantId: TENANT,
    campaignId,
    source: "hubspot",
    recordId: `hs-${campaignId.slice(0, 6)}`,
    contact: { name: "Test Lead", phone: "+919876543210" },
    consent: null,
    correlationId: null,
  });

  it("records consent even for a lead suppressed for another reason", async () => {
    await asGlobal(() =>
      owner.query(`update campaigns set active = false, consent_basis = null where id = $1`, [
        CAMPAIGN_A,
      ]),
    );

    const outcome = await withScope(scope, (tx) => ingestLead(tx, event(CAMPAIGN_A)));

    // An inactive campaign still stops the call...
    expect(outcome.status).toBe("suppressed");

    // ...but the consent the funnel collected is recorded regardless, so the
    // lead is dialable the moment the campaign is switched on, with no second
    // pass needed to backfill a row (migration 0008).
    const consent = await withScope(scope, async (tx) =>
      (
        await tx.query<{ captured_by: string }>(
          `select captured_by from consents where lead_id = $1`,
          [outcome.leadId],
        )
      ).rows[0],
    );
    expect(consent?.captured_by).toBe("inherited_upstream");
  });

  it("inherits consent from the lead source", async () => {
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_origin = 'meta_lead_form',
                compliance_approved_at = now(), active = true,
                calling_config = jsonb_set(
                  jsonb_set(calling_config, '{window_start}', '"00:00"'),
                  '{window_end}', '"23:59"')
          where id = $1`,
        [CAMPAIGN_A],
      ),
    );

    // No consent on the event, none declared on the campaign - and it still
    // queues, because the funnel upstream is where consent was collected.
    const outcome = await withScope(scope, (tx) => ingestLead(tx, event(CAMPAIGN_A)));
    expect(outcome.status).toBe("queued");

    const consent = await withScope(scope, async (tx) =>
      (
        await tx.query<{ basis: string; source: string; captured_by: string; evidence_ref: string }>(
          `select basis, source, captured_by, evidence_ref from consents where lead_id = $1`,
          [outcome.leadId],
        )
      ).rows[0],
    );

    // The record is honest about where it came from rather than overstating.
    expect(consent?.captured_by).toBe("inherited_upstream");
    expect(consent?.source).toBe("meta_lead_form");
    expect(consent?.evidence_ref).toContain("hubspot:");
  });

  it("still stops a lead whose consent was withdrawn", async () => {
    await asGlobal(() =>
      owner.query(
        `update campaigns set compliance_approved_at = now(), active = true,
                calling_config = jsonb_set(
                  jsonb_set(calling_config, '{window_start}', '"00:00"'),
                  '{window_end}', '"23:59"')
          where id = $1`,
        [CAMPAIGN_A],
      ),
    );

    const outcome = await withScope(scope, (tx) => ingestLead(tx, event(CAMPAIGN_A)));
    expect(outcome.status).toBe("queued");

    // Someone unsubscribing after the form is exactly what the record is for,
    // so a withdrawal is honoured under either mode.
    await asGlobal(() =>
      owner.query(`update consents set status = 'withdrawn', revoked_at = now() where lead_id = $1`, [
        outcome.leadId,
      ]),
    );

    const claim = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w" }),
    );
    expect(claim.claimed).toHaveLength(0);
    expect(claim.skipped[0]?.detail).toBe("consent_withdrawn");
  });

  it("stops a queued lead once its consent is withdrawn (PRD 17.4)", async () => {
    // A 24-hour window, so the assertion is about consent rather than about
    // what time of day the suite happens to run.
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_basis = 'opt_in_form', consent_source = 'list',
                compliance_approved_at = now(), active = true,
                calling_config = jsonb_set(
                  jsonb_set(calling_config, '{window_start}', '"00:00"'),
                  '{window_end}', '"23:59"')
          where id = $1`,
        [CAMPAIGN_A],
      ),
    );

    const outcome = await withScope(scope, (tx) => ingestLead(tx, event(CAMPAIGN_A)));
    expect(outcome.status).toBe("queued");

    // A lead can sit in the queue for hours. Withdrawal in that gap must stop
    // the call, which is why eligibility is re-checked at claim time and not
    // only at intake.
    await asGlobal(() =>
      owner.query(`update consents set status = 'withdrawn', revoked_at = now() where lead_id = $1`, [
        outcome.leadId,
      ]),
    );

    const claim = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w" }),
    );

    expect(claim.claimed).toHaveLength(0);
    expect(claim.skipped[0]?.detail).toBe("consent_withdrawn");

    const lead = await withScope(scope, async (tx) =>
      (await tx.query<{ status: string }>(`select status from leads where id = $1`, [outcome.leadId]))
        .rows[0],
    );
    expect(lead?.status).toBe("suppressed");
  });

  it("mints a per-lead consent record from the campaign declaration", async () => {
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_basis = 'opt_in_form', consent_source = 'client_list_2026_q3',
                consent_evidence_ref = 'contract-annex-B',
                compliance_approved_at = now(), active = true
          where id = $1`,
        [CAMPAIGN_A],
      ),
    );

    const outcome = await withScope(scope, (tx) => ingestLead(tx, event(CAMPAIGN_A)));
    expect(outcome.status).toBe("queued");

    const consent = await withScope(scope, async (tx) =>
      (
        await tx.query<{
          basis: string;
          source: string;
          evidence_ref: string;
          captured_by: string;
        }>(`select basis, source, evidence_ref, captured_by from consents where lead_id = $1`, [
          outcome.leadId,
        ])
      ).rows[0],
    );

    // The declaration produces a real, dated consents row rather than standing
    // in for one - so the call can cite a specific record later.
    expect(consent?.basis).toBe("opt_in_form");
    expect(consent?.source).toBe("client_list_2026_q3");
    expect(consent?.evidence_ref).toBe("contract-annex-B");
    expect(consent?.captured_by).toBe("campaign_declaration");
  });

  it("prefers consent supplied with the event over the campaign default", async () => {
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_basis = 'opt_in_form', consent_source = 'campaign_default',
                compliance_approved_at = now(), active = true
          where id = $1`,
        [CAMPAIGN_A],
      ),
    );

    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, {
        ...event(CAMPAIGN_A),
        consent: {
          basis: "existing_customer",
          source: "crm_import_2026",
          evidenceRef: "ticket-991",
          capturedAt: null,
        },
      }),
    );

    const consent = await withScope(scope, async (tx) =>
      (
        await tx.query<{ basis: string; source: string; captured_by: string }>(
          `select basis, source, captured_by from consents where lead_id = $1`,
          [outcome.leadId],
        )
      ).rows[0],
    );

    expect(consent?.basis).toBe("existing_customer");
    expect(consent?.captured_by).toBe("client_supplied");
  });
});

describe("dial allowlist (trial provider accounts)", () => {
  async function readyWithAllowlist(numbers: string[]) {
    await asGlobal(() =>
      owner.query(
        `update campaigns set compliance_approved_at = now(), active = true,
                dial_allowlist = $2,
                calling_config = jsonb_set(
                  jsonb_set(calling_config, '{window_start}', '"00:00"'),
                  '{window_end}', '"23:59"')
          where id = $1`,
        [CAMPAIGN_A, numbers],
      ),
    );
  }

  function lead(phone: string, recordId: string) {
    return {
      tenantId: TENANT,
      campaignId: CAMPAIGN_A,
      source: "hubspot",
      recordId,
      contact: { phone },
      consent: null,
      correlationId: null,
    };
  }

  it("queues a number that is on the allowlist", async () => {
    await readyWithAllowlist(["+919876543210"]);
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, lead("+919876543210", "hs-allowed")),
    );
    expect(outcome.status).toBe("queued");
  });

  it("suppresses a number that is not, before a call is placed", async () => {
    // A trial provider would fail this at the carrier and consume an attempt
    // from the lead's retry budget. Catching it here keeps the reason legible.
    await readyWithAllowlist(["+919876543210"]);
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, lead("+919999999999", "hs-blocked")),
    );

    expect(outcome.status).toBe("suppressed");
    if (outcome.status === "suppressed") {
      expect(outcome.reason).toBe("not_on_dial_allowlist");
    }
  });

  it("applies again at claim time, not only at intake", async () => {
    // The allowlist can be narrowed after a lead is already queued.
    await readyWithAllowlist([]);
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, lead("+919999999999", "hs-late")),
    );
    expect(outcome.status).toBe("queued");

    await readyWithAllowlist(["+919876543210"]);

    const claim = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w" }),
    );
    expect(claim.claimed).toHaveLength(0);
    expect(claim.skipped[0]?.detail).toBe("not_on_dial_allowlist");
  });

  it("does not restrict anything when empty", async () => {
    await readyWithAllowlist([]);
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, lead("+919999999999", "hs-open")),
    );
    expect(outcome.status).toBe("queued");
  });

  it("matches on the normalised E.164 form, not the raw input", async () => {
    // The lead arrives as "098765 43210"; the allowlist holds E.164.
    await readyWithAllowlist(["+919876543210"]);
    const outcome = await withScope(scope, (tx) =>
      ingestLead(tx, lead("098765 43210", "hs-normalised")),
    );
    expect(outcome.status).toBe("queued");
  });

  it("rejects a non-E.164 entry at save time", () => {
    const parsed = CampaignConfigSchema.safeParse({
      ...baseConfig,
      dialAllowlist: ["9876543210"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("configuration actually changes behaviour", () => {
  async function readyCampaign(campaignId: string, callingConfig: Record<string, unknown>) {
    await asGlobal(() =>
      owner.query(
        `update campaigns set consent_basis = 'opt_in_form', consent_source = 'list',
                compliance_approved_at = now(), active = true, calling_config = $2::jsonb
          where id = $1`,
        [campaignId, JSON.stringify(callingConfig)],
      ),
    );
  }

  it("changing the calling window changes whether the queue is claimable", async () => {
    // Same lead, same platform, two configurations.
    await readyCampaign(CAMPAIGN_A, {
      ...DEFAULT_CAMPAIGN_CONFIG.callingConfig,
      window_start: "00:00",
      window_end: "23:59",
    });

    await withScope(scope, (tx) =>
      ingestLead(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        source: "hubspot",
        recordId: "hs-window",
        contact: { phone: "+919876543210" },
        consent: null,
        correlationId: null,
      }),
    );

    // No fixed `now` here: the lead's next_call_at is real wall-clock, so a
    // pinned past instant would make it look not-yet-due rather than testing
    // the window. The 00:00-23:59 window is open whenever this runs.
    const open = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w" }),
    );
    expect(open.claimed).toHaveLength(1);

    // Put it back and narrow the window.
    await asGlobal(() =>
      owner.query(`update leads set status = 'queued', locked_by = null where campaign_id = $1`, [
        CAMPAIGN_A,
      ]),
    );
    await readyCampaign(CAMPAIGN_A, {
      ...DEFAULT_CAMPAIGN_CONFIG.callingConfig,
      window_start: "09:30",
      window_end: "09:31",
    });

    // A pinned instant is fine here: the window check runs before the
    // due-date query and returns early, so next_call_at never matters.
    const closed = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w", now: new Date("2026-09-01T14:30:00Z") }),
    );
    expect(closed.claimed).toHaveLength(0);
    expect(closed.skipped[0]?.reason).toBe("outside_calling_window");
  });

  it("deactivating a campaign stops it claiming without touching the leads", async () => {
    await readyCampaign(CAMPAIGN_A, DEFAULT_CAMPAIGN_CONFIG.callingConfig as never);
    await withScope(scope, (tx) =>
      ingestLead(tx, {
        tenantId: TENANT,
        campaignId: CAMPAIGN_A,
        source: "hubspot",
        recordId: "hs-active",
        contact: { phone: "+919876543210" },
        consent: null,
        correlationId: null,
      }),
    );

    await asGlobal(() => owner.query(`update campaigns set active = false where id = $1`, [CAMPAIGN_A]));

    const result = await withScope(scope, (tx) =>
      claimLeads(tx, { tenantId: TENANT, campaignId: CAMPAIGN_A, workerId: "w" }),
    );
    expect(result.claimed).toHaveLength(0);

    const lead = await withScope(scope, async (tx) =>
      (await tx.query<{ status: string }>(`select status from leads`)).rows[0],
    );
    expect(lead?.status).toBe("queued");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, withoutScope, type TenantScope } from "@/db/client";
import { sealSecret } from "@/lib/crypto/kms";
import { DEFAULT_CAMPAIGN_CONFIG } from "@/lib/campaigns/config";
import {
  resolveCampaignForContact,
  routingProperties,
} from "@/lib/leads/campaign-routing";
import { ingestSubscriptionEvents } from "@/lib/leads/hubspot-app-intake";

/**
 * Intake from a HubSpot private app - the path a free portal can use.
 *
 * Two things here have no equivalent anywhere else in the system and so are
 * worth testing against a real database rather than in isolation:
 *
 *   - resolving a portal id to a tenant *before* any tenant scope exists,
 *     through a SECURITY DEFINER function, because the signature cannot be
 *     checked until the client secret is in hand.
 *   - choosing a campaign from a contact property, because the request cannot
 *     name one.
 */

const TENANT = "aa000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "aa000000-0000-4000-8000-000000000002";
const WINDOWS = "ab000000-0000-4000-8000-000000000001";
const DOORS = "ab000000-0000-4000-8000-000000000002";
const PORTAL = 24681012;
const OTHER_PORTAL = 24681013;

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: null,
  actorType: "service",
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

async function seedIntegration(
  tenantId: string,
  portalId: number | null,
  credential: Record<string, string>,
): Promise<string> {
  const sealed = sealSecret(JSON.stringify(credential), "hubspot");
  const secret = await owner.query<{ id: string }>(
    `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag)
     values ($1, 'hubspot', $2, $3, $4, $5, $6) returning id`,
    [tenantId, sealed.keyId, sealed.wrappedDek, sealed.iv, sealed.ciphertext, sealed.authTag],
  );

  const integration = await owner.query<{ id: string }>(
    `insert into integrations (tenant_id, type, name, credential_ref, hubspot_portal_id, status)
     values ($1, 'hubspot', 'HubSpot', $2, $3, 'active') returning id`,
    [tenantId, secret.rows[0]!.id, portalId],
  );
  return integration.rows[0]!.id;
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  await asGlobal(async () => {
    for (const [id, name, slug] of [
      [TENANT, "Portal Test Co", "portal-test-co"],
      [OTHER_TENANT, "Other Portal Co", "other-portal-co"],
    ] as const) {
      await owner.query(
        `insert into tenants (id, name, slug) values ($1, $2, $3)
         on conflict (id) do nothing`,
        [id, name, slug],
      );
    }

    for (const [id, name] of [
      [WINDOWS, "Windows"],
      [DOORS, "Doors"],
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
    // Also by portal id, not only by tenant: the unique index is global, so a
    // row left behind by anything else in this database - a manual test, a
    // half-finished onboarding - would fail these inserts with a duplicate
    // key and read as a bug in the code under test.
    await owner.query(`delete from integrations where hubspot_portal_id = any($1)`, [
      [PORTAL, OTHER_PORTAL],
    ]);
    await owner.query(`delete from integrations where tenant_id = any($1)`, [
      [TENANT, OTHER_TENANT],
    ]);
    await owner.query(`delete from secrets where tenant_id = any($1)`, [[TENANT, OTHER_TENANT]]);
    await owner.query(
      `update campaigns set active = false, intake_property = null,
              intake_values = '{}', intake_default = false
        where tenant_id = $1`,
      [TENANT],
    );
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from tenants where id = any($1)`, [[TENANT, OTHER_TENANT]]);
  });
  await owner.end();
  await closePools();
});

describe("app.hubspot_portal_lookup", () => {
  it("resolves a portal to its tenant and sealed credential with no tenant scope set", async () => {
    await asGlobal(() =>
      seedIntegration(TENANT, PORTAL, { accessToken: "pat-na1-token", clientSecret: "s3cret" }),
    );

    // withoutScope, because this is the read that has to happen before a
    // tenant is known - exactly how the webhook route calls it.
    const row = await withoutScope(async (tx) => {
      const r = await tx.query<{ tenant_id: string; status: string }>(
        `select * from app.hubspot_portal_lookup($1)`,
        [PORTAL],
      );
      return r.rows[0] ?? null;
    }, "service");

    expect(row?.tenant_id).toBe(TENANT);
    expect(row?.status).toBe("active");
  });

  it("returns nothing for an unknown portal", async () => {
    const rows = await withoutScope(async (tx) => {
      const r = await tx.query(`select * from app.hubspot_portal_lookup($1)`, [99999999]);
      return r.rowCount;
    }, "service");

    expect(rows).toBe(0);
  });

  /**
   * A suspended client stops at the front door. Ingesting their leads and then
   * suppressing each one would leave a queue that looks live and a client
   * being billed for storage of leads nobody will call.
   */
  it("returns nothing once the tenant is not active", async () => {
    await asGlobal(async () => {
      await seedIntegration(TENANT, PORTAL, { accessToken: "pat", clientSecret: "s3cret" });
      await owner.query(`update tenants set status = 'suspended' where id = $1`, [TENANT]);
    });

    const rows = await withoutScope(async (tx) => {
      const r = await tx.query(`select * from app.hubspot_portal_lookup($1)`, [PORTAL]);
      return r.rowCount;
    }, "service");

    expect(rows).toBe(0);

    await asGlobal(() =>
      owner.query(`update tenants set status = 'active' where id = $1`, [TENANT]),
    );
  });

  /**
   * Two tenants claiming one portal would make the lookup order-dependent, and
   * resolving a lead to the wrong client is the worst failure this system has.
   * The database refuses it rather than leaving it to be noticed.
   */
  it("refuses to let two tenants claim the same portal", async () => {
    await asGlobal(() =>
      seedIntegration(TENANT, PORTAL, { accessToken: "pat", clientSecret: "s3cret" }),
    );

    await expect(
      asGlobal(() =>
        seedIntegration(OTHER_TENANT, PORTAL, { accessToken: "pat", clientSecret: "s3cret" }),
      ),
    ).rejects.toThrow(/integrations_hubspot_portal_uniq/);
  });

  it("allows several integrations with no portal id", async () => {
    await asGlobal(async () => {
      await seedIntegration(TENANT, null, { accessToken: "pat" });
      await seedIntegration(OTHER_TENANT, null, { accessToken: "pat" });
    });

    const rows = await withoutScope(async (tx) => {
      const r = await tx.query(`select * from app.hubspot_portal_lookup($1)`, [OTHER_PORTAL]);
      return r.rowCount;
    }, "service");
    expect(rows).toBe(0);
  });
});

describe("resolveCampaignForContact", () => {
  const activate = (ids: string[]) =>
    asGlobal(() =>
      owner.query(`update campaigns set active = true where id = any($1)`, [ids]),
    );

  it("routes on a matching contact property", async () => {
    await activate([WINDOWS, DOORS]);
    await asGlobal(async () => {
      await owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [WINDOWS, ["uPVC windows"]],
      );
      await owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [DOORS, ["aluminium doors"]],
      );
    });

    const outcome = await withScope(
      scope,
      (tx) =>
        resolveCampaignForContact(tx, {
          tenantId: TENANT,
          properties: { product_interest: "aluminium doors" },
        }),
      "service",
    );

    expect(outcome).toEqual({
      routed: true,
      route: {
        campaignId: DOORS,
        matchedOn: "property",
        detail: "product_interest=aluminium doors",
      },
    });
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    await activate([WINDOWS, DOORS]);
    await asGlobal(() =>
      owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [WINDOWS, ["uPVC Windows"]],
      ),
    );

    const outcome = await withScope(
      scope,
      (tx) =>
        resolveCampaignForContact(tx, {
          tenantId: TENANT,
          properties: { product_interest: "  upvc windows " },
        }),
      "service",
    );

    expect(outcome.routed && outcome.route.campaignId).toBe(WINDOWS);
  });

  it("falls back to the campaign marked default", async () => {
    await activate([WINDOWS, DOORS]);
    await asGlobal(async () => {
      await owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [WINDOWS, ["uPVC windows"]],
      );
      await owner.query(`update campaigns set intake_default = true where id = $1`, [DOORS]);
    });

    const outcome = await withScope(
      scope,
      (tx) =>
        resolveCampaignForContact(tx, {
          tenantId: TENANT,
          properties: { product_interest: "something else entirely" },
        }),
      "service",
    );

    expect(outcome).toEqual({
      routed: true,
      route: { campaignId: DOORS, matchedOn: "default", detail: null },
    });
  });

  /**
   * The common starting state: one client, one enquiry form, no routing
   * configured. Requiring configuration here would mean every new client had
   * to choose between one option before their first lead could be called.
   */
  it("uses the only active campaign when nothing is configured", async () => {
    await activate([WINDOWS]);

    const outcome = await withScope(
      scope,
      (tx) => resolveCampaignForContact(tx, { tenantId: TENANT, properties: {} }),
      "service",
    );

    expect(outcome).toEqual({
      routed: true,
      route: { campaignId: WINDOWS, matchedOn: "only_active_campaign", detail: null },
    });
  });

  it("refuses to guess between several active campaigns with no default", async () => {
    await activate([WINDOWS, DOORS]);

    const outcome = await withScope(
      scope,
      (tx) =>
        resolveCampaignForContact(tx, {
          tenantId: TENANT,
          properties: { product_interest: "unmapped" },
        }),
      "service",
    );

    expect(outcome.routed).toBe(false);
    expect(outcome.routed === false && outcome.reason).toMatch(/no campaign matched/);
  });

  it("reports when the client has no active campaign at all", async () => {
    const outcome = await withScope(
      scope,
      (tx) => resolveCampaignForContact(tx, { tenantId: TENANT, properties: {} }),
      "service",
    );

    expect(outcome.routed).toBe(false);
    expect(outcome.routed === false && outcome.reason).toMatch(/no active campaign/);
  });

  /** An inactive campaign is one somebody stopped; a lead routed there would never dial. */
  it("never routes to an inactive campaign", async () => {
    await activate([WINDOWS]);
    await asGlobal(() =>
      owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [DOORS, ["aluminium doors"]],
      ),
    );

    const outcome = await withScope(
      scope,
      (tx) =>
        resolveCampaignForContact(tx, {
          tenantId: TENANT,
          properties: { product_interest: "aluminium doors" },
        }),
      "service",
    );

    // Matched nothing active, so it lands on the single active campaign.
    expect(outcome.routed && outcome.route.campaignId).toBe(WINDOWS);
  });

  it("collects the properties HubSpot must be asked for", async () => {
    await asGlobal(async () => {
      await owner.query(`update campaigns set intake_property = 'product_interest' where id = $1`, [
        WINDOWS,
      ]);
      await owner.query(`update campaigns set intake_property = 'form_name' where id = $1`, [DOORS]);
    });

    const properties = await withScope(
      scope,
      (tx) => routingProperties(tx, TENANT),
      "service",
    );

    expect(properties.sort()).toEqual(["form_name", "product_interest"]);
  });
});

describe("ingestSubscriptionEvents", () => {
  /**
   * A stub in place of HubSpot's CRM. The point of injecting it is this test:
   * "a created contact became a queued lead" is the whole feature, and it
   * should not need a live portal to prove.
   */
  function contactSource(contacts: Record<string, Record<string, unknown> | null>) {
    const asked: Array<{ contactId: string; properties: string[] }> = [];
    return {
      asked,
      getContact: async (contactId: string, properties: string[]) => {
        asked.push({ contactId, properties });
        return contacts[contactId] ?? null;
      },
    };
  }

  const event = (eventId: number, objectId: number) => ({
    eventId,
    portalId: PORTAL,
    objectId,
    subscriptionType: "contact.creation",
  });

  beforeEach(async () => {
    await asGlobal(async () => {
      await owner.query(`delete from webhook_events where tenant_id = $1`, [TENANT]);
      await owner.query(`delete from leads where tenant_id = $1`, [TENANT]);
      await owner.query(
        `update campaigns set active = true, compliance_approved_at = now(),
                consent_basis = 'opt_in_form', consent_source = 'website_form'
          where id = $1`,
        [WINDOWS],
      );
    });
  });

  it("fetches the contact, maps it and queues a callable lead", async () => {
    const source = contactSource({
      "701": {
        firstname: "Rahul",
        lastname: "Sharma",
        phone: "98765 43210",
        email: "rahul@example.com",
        requirement: "12 windows, Sector 78 Noida",
      },
    });

    const results = await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1001, 701)],
        }),
      "service",
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      eventId: "1001",
      contactId: "701",
      queued: true,
      campaignId: WINDOWS,
      status: "queued",
    });

    // The properties have to be named explicitly or HubSpot returns its small
    // default set, and the phone would silently be missing.
    expect(source.asked[0]?.properties).toContain("phone");
    expect(source.asked[0]?.properties).toContain("requirement");

    const lead = await asGlobal(async () => {
      const r = await owner.query<{
        status: string;
        phone_last4: string | null;
        hubspot_record_id: string | null;
        campaign_id: string;
      }>(
        `select status, phone_last4, hubspot_record_id, campaign_id
           from leads where tenant_id = $1`,
        [TENANT],
      );
      return r.rows[0];
    });

    expect(lead?.status).toBe("queued");
    expect(lead?.phone_last4).toBe("3210");
    expect(lead?.hubspot_record_id).toBe("701");
    expect(lead?.campaign_id).toBe(WINDOWS);
  });

  /** Consent is recorded, never demanded (migration 0008). */
  it("records a consent row from the campaign's declaration", async () => {
    const source = contactSource({ "702": { firstname: "Priya", phone: "+919876543211" } });

    await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1002, 702)],
        }),
      "service",
    );

    const consent = await asGlobal(async () => {
      const r = await owner.query<{ basis: string; captured_by: string }>(
        `select basis, captured_by from consents where tenant_id = $1`,
        [TENANT],
      );
      return r.rows[0];
    });

    expect(consent?.basis).toBe("opt_in_form");
    expect(consent?.captured_by).toBe("campaign_declaration");
  });

  /**
   * HubSpot retries a delivery it did not see acknowledged. The second attempt
   * must cost a lookup, not a second call to the same person.
   */
  it("treats a redelivered event as a replay and does not create a second lead", async () => {
    const source = contactSource({ "703": { firstname: "Amit", phone: "+919876543212" } });
    const deliver = () =>
      withScope(
        scope,
        (tx) =>
          ingestSubscriptionEvents(tx, {
            tenantId: TENANT,
            contacts: source,
            events: [event(1003, 703)],
          }),
        "service",
      );

    expect((await deliver())[0]?.status).toBe("queued");
    expect((await deliver())[0]?.status).toBe("replay");

    // The replay never reached the CRM either: one fetch, not two.
    expect(source.asked).toHaveLength(1);

    const count = await asGlobal(async () => {
      const r = await owner.query<{ n: string }>(
        `select count(*) as n from leads where tenant_id = $1`,
        [TENANT],
      );
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(1);
  });

  it("records a contact deleted before it could be fetched, rather than failing the delivery", async () => {
    const source = contactSource({ "704": null });

    const results = await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1004, 704)],
        }),
      "service",
    );

    expect(results[0]?.status).toBe("contact_gone");
  });

  it("quarantines a contact with no callable number instead of dropping it", async () => {
    const source = contactSource({ "705": { firstname: "No", lastname: "Phone" } });

    const results = await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1005, 705)],
        }),
      "service",
    );

    expect(results[0]).toMatchObject({ status: "quarantined", queued: false });
  });

  /**
   * The failure that must not become a call: no campaign matched and no
   * default. Reading another campaign's script to this lead would be worse
   * than not calling them.
   */
  it("records an unroutable lead without ingesting it", async () => {
    await asGlobal(async () => {
      await owner.query(`update campaigns set active = true where id = $1`, [DOORS]);
      await owner.query(
        `update campaigns set intake_property = 'product_interest', intake_values = $2
          where id = $1`,
        [WINDOWS, ["uPVC windows"]],
      );
    });

    const source = contactSource({
      "706": { firstname: "Meera", phone: "+919876543216", product_interest: "something else" },
    });

    const results = await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1006, 706)],
        }),
      "service",
    );

    expect(results[0]).toMatchObject({ status: "unrouted", queued: false, campaignId: null });

    const leads = await asGlobal(async () => {
      const r = await owner.query<{ n: string }>(
        `select count(*) as n from leads where tenant_id = $1`,
        [TENANT],
      );
      return Number(r.rows[0]!.n);
    });
    expect(leads).toBe(0);
  });

  it("processes a batched delivery of several contacts", async () => {
    const source = contactSource({
      "707": { firstname: "A", phone: "+919876543217" },
      "708": { firstname: "B", phone: "+919876543218" },
    });

    const results = await withScope(
      scope,
      (tx) =>
        ingestSubscriptionEvents(tx, {
          tenantId: TENANT,
          contacts: source,
          events: [event(1007, 707), event(1008, 708)],
        }),
      "service",
    );

    expect(results.map((r) => r.status)).toEqual(["queued", "queued"]);
  });
});

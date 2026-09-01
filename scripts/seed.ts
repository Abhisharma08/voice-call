import { Client } from "pg";
import "./load-env.ts";
import { hashPassword } from "../src/lib/crypto/password.ts";

/**
 * Development seed: one agency admin, one ops manager, one campaign manager,
 * and two tenants - two so that tenant-isolation behaviour is visible the
 * moment you log in, not only in tests.
 *
 * Runs as the owner connection, and because migration 0002 forces RLS on the
 * owner too, it has to declare global scope like any other actor.
 */

const DEV_PASSWORD = "devpassword123";

async function main() {
  if ((process.env.APP_ENV ?? "development") !== "development") {
    throw new Error(`Refusing to seed with APP_ENV=${process.env.APP_ENV}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.global_scope', 'on', true),
              set_config('app.actor_type', 'system', true)`,
    );

    const tenants = await client.query<{ id: string; slug: string }>(
      `insert into tenants (name, slug, timezone) values
         ('Acme Real Estate', 'acme-real-estate', 'Asia/Kolkata'),
         ('Northwind Insurance', 'northwind-insurance', 'Asia/Kolkata')
       on conflict (slug) do update set name = excluded.name
       returning id, slug`,
    );

    const bySlug = new Map(tenants.rows.map((t) => [t.slug, t.id]));
    const acme = bySlug.get("acme-real-estate");
    const northwind = bySlug.get("northwind-insurance");
    if (!acme || !northwind) throw new Error("Tenant seed failed");

    const passwordHash = await hashPassword(DEV_PASSWORD);

    const users = await client.query<{ id: string; email: string }>(
      `insert into users (email, name, role, password_hash) values
         ('admin@agency.test',    'Agency Admin',        'agency_admin',       $1),
         ('ops@agency.test',      'Operations Manager',  'operations_manager', $1),
         ('campaigns@agency.test','Campaign Manager',    'campaign_manager',   $1),
         ('analyst@agency.test',  'Analyst',             'analyst',            $1)
       on conflict (email) do update set password_hash = excluded.password_hash
       returning id, email`,
      [passwordHash],
    );

    const byEmail = new Map(users.rows.map((u) => [u.email, u.id]));

    // PRD 8.2: non-admin staff are scoped to assignments. The Campaign Manager
    // gets one client, the Ops Manager gets both, the Analyst gets one - so a
    // fresh checkout can demonstrate a denied cross-tenant access immediately.
    await client.query(
      `insert into user_tenant_assignments (user_id, tenant_id, role) values
         ($1, $4, 'campaign_manager'),
         ($2, $4, 'operations_manager'),
         ($2, $5, 'operations_manager'),
         ($3, $4, 'analyst')
       on conflict (user_id, tenant_id) do nothing`,
      [
        byEmail.get("campaigns@agency.test"),
        byEmail.get("ops@agency.test"),
        byEmail.get("analyst@agency.test"),
        acme,
        northwind,
      ],
    );

    await client.query(
      `insert into campaigns (tenant_id, name, domain, business_context, timezone, calling_config, routing_config)
       values ($1, 'Noida 2BHK', 'real_estate',
               'Residential property enquiries for Noida projects.',
               'Asia/Kolkata',
               $2::jsonb, $3::jsonb)
       on conflict (tenant_id, name) do nothing`,
      [
        acme,
        JSON.stringify({
          window_start: "09:30",
          window_end: "18:30",
          max_attempts: 3,
          retry_minutes: [15, 120, 1440],
        }),
        JSON.stringify({ hot_threshold: 75, notify_channel: "sales_queue" }),
      ],
    );

    await client.query("commit");

    console.log("Seeded 2 tenants, 4 staff users, 1 campaign.");
    console.log(`Login with any of the *@agency.test emails / password: ${DEV_PASSWORD}`);
    console.log("Note: no campaign is compliance-approved, so none can be activated (PRD 17.3).");
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

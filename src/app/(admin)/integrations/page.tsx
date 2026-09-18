import { requireUser } from "@/lib/auth/current-user";
import { withTenant } from "@/lib/auth/tenant";
import { can } from "@/lib/auth/rbac";
import { providerDiagnostics } from "@/lib/providers/voice";
import { AddIntegrationForm } from "./add-integration-form";
import { TestConnection } from "./test-connection";
import { DeadLetters, type DeadLetter } from "./dead-letters";

export const dynamic = "force-dynamic";

/**
 * Per-tenant integration credentials (PRD 13, PRD 22 Phase 2).
 *
 * The credential itself is never selected here. PRD 17.1 says to store only
 * secret references, and the corollary is that the UI has nothing to show: a
 * credential is write-only from the moment it is sealed. What an operator
 * actually needs to know is whether it still works, which is what the status
 * and last error report.
 */
export default async function IntegrationsPage() {
  const user = await requireUser();

  if (!user.activeTenantId) {
    return (
      <>
        <h1 className="page-title">Integrations</h1>
        <p className="page-sub">Per-client HubSpot, Google Sheets and voice provider credentials.</p>
        <div className="empty">Select a client from the sidebar to see its integrations.</div>
      </>
    );
  }

  const tenantId = user.activeTenantId;

  const { integrations, spreadsheetId, sheetRange, deadLetters } = await withTenant(user, tenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      type: string;
      name: string;
      status: string;
      last_error: string | null;
      created_at: Date;
      key_id: string | null;
      created_by_email: string | null;
      used_by_campaigns: string;
      last_verified_at: Date | null;
      hubspot_portal_id: string | null;
    }>(
      `select i.id, i.type, i.name, i.status, i.last_error, i.created_at, i.last_verified_at,
              i.hubspot_portal_id,
              s.key_id, u.email as created_by_email,
              (select count(*) from campaigns c where c.hubspot_integration_id = i.id) as used_by_campaigns
         from integrations i
         left join secrets s on s.id = i.credential_ref
         left join users u on u.id = i.created_by
        order by i.type, i.name`,
    );

    // The Sheets test needs a real spreadsheet to reach for; take the first one
    // any campaign points at.
    const sheet = await tx.query<{ google_sheet_id: string; google_sheet_tab: string | null }>(
      `select google_sheet_id, google_sheet_tab from campaigns
        where google_sheet_id is not null order by created_at limit 1`,
    );

    /**
     * Deliveries that exhausted their retries (PRD 18.3). Joined out to the
     * call so a row reads as "this client's lead did not reach their CRM"
     * rather than as an opaque outbox id - which is the difference between a
     * panel an operator acts on and one they scroll past.
     *
     * `phone_last4` only: the full number is encrypted and requires an audited
     * reveal (PRD 26.2), and identifying a stuck row does not need it.
     */
    const dead = await tx.query<{
      id: string;
      target: DeadLetter["target"];
      attempts: number;
      last_error: string | null;
      dead_since: Date;
      call_id: string | null;
      phone_last4: string | null;
      campaign_name: string | null;
    }>(
      // next_attempt_at is not null and is stamped at the moment the row
      // dead-lettered, so it is the "since" without a coalesce.
      //
      // The cast to uuid is guarded rather than direct: an unparseable
      // payload->>'call_id' would raise and take the whole Integrations page
      // down with it, which is a poor way to find out one outbox row is
      // malformed. Guarded, that row simply lists with no call context.
      //
      // CASE rather than `cast ... and regex`: a boolean AND in a join
      // condition has no guaranteed evaluation order, so the planner is free
      // to attempt the cast before the test that was meant to protect it.
      // CASE is defined to evaluate only the branch it selects.
      `select o.id, o.target, o.attempts, o.last_error,
              o.next_attempt_at as dead_since,
              ca.id as call_id, l.phone_last4, c.name as campaign_name
         from sync_outbox o
         left join call_attempts ca
                on ca.id = (case
                              when o.payload->>'call_id' ~
                                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                              then (o.payload->>'call_id')::uuid
                            end)
         left join leads l on l.id = ca.lead_id
         left join campaigns c on c.id = ca.campaign_id
        where o.status = 'dead_letter'
        order by o.target, dead_since desc
        limit 200`,
    );

    return {
      integrations: r.rows,
      spreadsheetId: sheet.rows[0]?.google_sheet_id ?? null,
      sheetRange: sheet.rows[0]?.google_sheet_tab ?? null,
      deadLetters: dead.rows.map<DeadLetter>((row) => ({
        id: row.id,
        target: row.target,
        attempts: row.attempts,
        lastError: row.last_error,
        deadSince: row.dead_since.toISOString(),
        callId: row.call_id,
        leadPhoneLast4: row.phone_last4,
        campaignName: row.campaign_name,
      })),
    };
  });

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <p className="page-sub">
        Agency-managed credentials for this client. Secrets are sealed on entry and never displayed
        again.
      </p>

      {integrations.length === 0 ? (
        <div className="empty">No integrations configured for this client yet.</div>
      ) : (
        <div className="stack">
          {integrations.map((i) => (
            <div key={i.id} className="card stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{i.name}</strong>
                <span className="pill">{i.type}</span>
                <span className={`pill ${i.status === "active" ? "ok" : "warn"}`}>{i.status}</span>
                <div className="spacer" />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  key {i.key_id ?? "none"} · added by {i.created_by_email ?? "system"}
                  {i.last_verified_at
                    ? ` · verified ${i.last_verified_at.toLocaleDateString()}`
                    : " · never verified"}
                </span>
              </div>

              {Number(i.used_by_campaigns) > 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Used by {i.used_by_campaigns} campaign{Number(i.used_by_campaigns) === 1 ? "" : "s"}
                </div>
              ) : null}

              {/* Inbound intake needs two things this credential may not
                  carry, and neither failure is visible from the outside: an
                  event for an unknown portal, and one whose signature cannot
                  be checked, are both answered exactly like a forged one
                  (PRD 23.3). Said here instead, where it can be fixed. */}
              {i.type === "hubspot" && !i.hubspot_portal_id ? (
                <div style={{ fontSize: 12, color: "var(--warn, #d08b2c)" }}>
                  No portal id: HubSpot could not be asked which account this token belongs to, so
                  inbound leads from its private app are dropped as an unknown portal. Re-add the
                  credential once the token is valid.
                </div>
              ) : null}
              {i.type === "hubspot" && i.hubspot_portal_id ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Portal {i.hubspot_portal_id} &middot; inbound webhook:{" "}
                  <code>/api/webhooks/hubspot/events</code>
                </div>
              ) : null}

              {/* PRD 18.2: an auth failure disables the integration rather than
                  retrying into a rate limit. Surfacing the error is how it gets
                  fixed. */}
              {i.last_error ? (
                <div style={{ fontSize: 12, color: "var(--danger)" }}>{i.last_error}</div>
              ) : null}

              {can(user.role, "integration:write") ? (
                <TestConnection
                  tenantId={tenantId}
                  integrationId={i.id}
                  spreadsheetId={spreadsheetId}
                  sheetRange={sheetRange}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/*
        Undelivered results come before the voice-provider panel and before the
        add-credential form on purpose: every row is a qualification the client
        has not received, which is the most urgent thing this page can be
        telling an operator. When there are none, the section is absent rather
        than showing an encouraging empty state nobody needs to read.
      */}
      {deadLetters.length > 0 ? (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Undelivered results</h2>
          <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 10px" }}>
            These qualifications exhausted their retries and have not reached their destination.
          </p>

          <DeadLetters
            tenantId={tenantId}
            items={deadLetters}
            canReplay={can(user.role, "integration:write")}
          />
        </div>
      ) : null}

      {/*
        Voice providers are platform-wide, not per client: they register from
        environment variables at boot, and a campaign selects one by name. This
        panel exists because an unconfigured choice otherwise fails at claim
        time, in a worker log, minutes after someone thought they had set it up.
      */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Voice providers</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 10px" }}>
          Registered from the environment, shared by every client, selected per campaign.
        </p>

        <div className="stack">
          {providerDiagnostics().map((p) => (
            <div key={p.name} className="card stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{p.name}</strong>
                <span className={`pill ${p.registered ? "ok" : "warn"}`}>
                  {p.registered ? "selectable" : "not configured"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{p.note}</div>
              {p.missing.length > 0 ? (
                <div style={{ fontSize: 12 }}>
                  Set {p.missing.map((v) => <code key={v}>{v} </code>)} and restart to register it.
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {can(user.role, "secret:write") ? (
        <div style={{ marginTop: 20 }}>
          <AddIntegrationForm tenantId={tenantId} />
        </div>
      ) : (
        <p className="note" style={{ color: "var(--muted)", fontSize: 12, marginTop: 16 }}>
          Adding credentials is a Campaign Manager or Agency Admin action.
        </p>
      )}
    </>
  );
}

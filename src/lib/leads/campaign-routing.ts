import type { PoolClient } from "pg";

/**
 * Which campaign a lead belongs to, when nothing in the request says.
 *
 * The workflow-action endpoint takes the campaign as a query parameter, which
 * works because a paid account can have one workflow per campaign and put a
 * different URL in each. A private app has *one* webhook target for the whole
 * portal, so that answer is unavailable exactly where free-tier clients are.
 *
 * So the campaign is routed from a contact property - the client's own form
 * name, product line, or a routing field they already fill in. Configured per
 * campaign as `intake_property` plus the `intake_values` that select it, with
 * one campaign per tenant allowed to be `intake_default` for everything
 * unmatched.
 *
 * Deliberately not inferred from the enquiry text. That text is spoken back to
 * the lead and given to the model as context; parsing it to decide which
 * script to read would make a typo in a form field change which business the
 * caller claims to be from.
 */

export interface CampaignRoute {
  campaignId: string;
  /** Why this campaign was chosen, for the audit trail and for debugging. */
  matchedOn: "property" | "default" | "only_active_campaign";
  detail: string | null;
}

export type RoutingOutcome =
  | { routed: true; route: CampaignRoute }
  | { routed: false; reason: string };

interface RoutableCampaign {
  id: string;
  name: string;
  intake_property: string | null;
  intake_values: string[];
  intake_default: boolean;
}

/**
 * Resolve within the tenant's own scope - the caller has already established
 * it from the verified portal id, and RLS keeps this to that one client's
 * campaigns.
 *
 * Only `active` campaigns are considered. An inactive one is a campaign
 * somebody has deliberately stopped, and routing a lead into it would leave
 * that lead queued against something that will never dial.
 */
export async function resolveCampaignForContact(
  tx: PoolClient,
  args: { tenantId: string; properties: Record<string, unknown> },
): Promise<RoutingOutcome> {
  const campaigns = await tx.query<RoutableCampaign>(
    `select id, name, intake_property, intake_values, intake_default
       from campaigns
      where tenant_id = $1 and active
      order by created_at`,
    [args.tenantId],
  );

  const rows = campaigns.rows;

  if (rows.length === 0) {
    return {
      routed: false,
      reason:
        "no active campaign for this client - activate one before HubSpot sends leads",
    };
  }

  // 1. An explicit property match wins. Case-insensitive and trimmed, because
  //    "Windows" from a dropdown and "windows " from a hidden field are the
  //    same answer, and a client editing their form casing should not silently
  //    stop routing.
  for (const campaign of rows) {
    if (!campaign.intake_property || campaign.intake_values.length === 0) continue;

    const value = normalise(args.properties[campaign.intake_property]);
    if (value === null) continue;

    if (campaign.intake_values.some((candidate) => normalise(candidate) === value)) {
      return {
        routed: true,
        route: {
          campaignId: campaign.id,
          matchedOn: "property",
          detail: `${campaign.intake_property}=${value}`,
        },
      };
    }
  }

  // 2. The tenant's declared catch-all. A partial-unique index guarantees
  //    there is at most one, so this cannot depend on row order.
  const fallback = rows.find((c) => c.intake_default);
  if (fallback) {
    return {
      routed: true,
      route: { campaignId: fallback.id, matchedOn: "default", detail: null },
    };
  }

  // 3. One active campaign and no routing configured at all is the common
  //    starting state - a client with a single enquiry form. Treating that as
  //    unroutable would mean every new client had to configure routing before
  //    their first lead could be called, to choose between one option.
  if (rows.length === 1) {
    return {
      routed: true,
      route: { campaignId: rows[0]!.id, matchedOn: "only_active_campaign", detail: null },
    };
  }

  // Several active campaigns, none matched, no default. Guessing here would
  // read one client's script to another client's lead.
  return {
    routed: false,
    reason:
      `no campaign matched and no default is set (${rows.length} active: ` +
      `${rows.map((c) => c.name).join(", ")})`,
  };
}

/** The properties routing needs HubSpot to return, across all campaigns. */
export async function routingProperties(tx: PoolClient, tenantId: string): Promise<string[]> {
  const r = await tx.query<{ intake_property: string }>(
    `select distinct intake_property from campaigns
      where tenant_id = $1 and intake_property is not null`,
    [tenantId],
  );
  return r.rows.map((row) => row.intake_property);
}

function normalise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text === "" ? null : text;
}

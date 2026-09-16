import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_TEMPLATES,
  hubspotWebhookUrl,
  templateById,
} from "../../src/lib/onboarding/templates.ts";
import { CampaignConfigSchema, DEFAULT_CAMPAIGN_CONFIG } from "../../src/lib/campaigns/config.ts";
import { QualificationSchema } from "../../src/lib/qualification/schema.ts";
import { activationBlockers } from "../../src/lib/campaigns/config.ts";
import { campaignsToDial } from "../../src/lib/calling/dispatch.ts";

/**
 * A template that does not validate is worse than no template: onboarding
 * would create a campaign the editor then refuses to save, and the operator
 * would have to reverse-engineer which field was wrong.
 */
describe("campaign templates", () => {
  it("offers at least one", () => {
    expect(CAMPAIGN_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = CAMPAIGN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CAMPAIGN_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s validates against the campaign config schema",
    (_id, template) => {
      const parsed = CampaignConfigSchema.safeParse({
        ...DEFAULT_CAMPAIGN_CONFIG,
        name: "Test campaign",
        businessContext: template.businessContext,
        script: template.script,
        scoringRubric: template.scoringRubric,
        questions: template.questions,
      });

      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    },
  );

  /**
   * The field name is the key the model must return and the key the review
   * gate looks a required field up by. A template inventing one would produce
   * a question the model is asked but whose answer can never arrive, so every
   * result would be held for review as incomplete.
   */
  it.each(CAMPAIGN_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s only asks for fields the qualification schema extracts",
    (_id, template) => {
      const extractable = Object.keys(QualificationSchema.shape);
      for (const q of template.questions) {
        expect(extractable, `${q.fieldName} is not an extraction target`).toContain(q.fieldName);
      }
    },
  );

  it.each(CAMPAIGN_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s asks at least one required question, so a silent call cannot auto-qualify",
    (_id, template) => {
      expect(template.questions.some((q) => q.required)).toBe(true);
    },
  );

  it.each(CAMPAIGN_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s clears the activation blockers a template can clear",
    (_id, template) => {
      const blockers = activationBlockers({
        complianceApprovedAt: null,
        script: template.script,
        questions: template.questions.length,
        // Both are credentials someone has to paste in; a template cannot
        // supply them, and they must still be named as outstanding.
        googleSheetId: "sheet-id",
        hubspotIntegrationId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      });

      // Compliance approval is the one blocker left, and deliberately so:
      // PRD 17.3 wants a named person's attestation, not a default.
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain("Compliance");
    },
  );

  it("resolves by id, and refuses an unknown one", () => {
    expect(templateById(CAMPAIGN_TEMPLATES[0]!.id)?.id).toBe(CAMPAIGN_TEMPLATES[0]!.id);
    expect(templateById("no-such-template")).toBeNull();
  });
});

describe("hubspotWebhookUrl", () => {
  it("names the campaign as a query parameter", () => {
    expect(hubspotWebhookUrl("https://calls.example.com", "abc-123")).toBe(
      "https://calls.example.com/api/webhooks/hubspot/leads?campaign=abc-123",
    );
  });

  it("tolerates a trailing slash on APP_URL", () => {
    expect(hubspotWebhookUrl("https://calls.example.com/", "abc-123")).toBe(
      "https://calls.example.com/api/webhooks/hubspot/leads?campaign=abc-123",
    );
  });
});

/**
 * The rule that keeps a HubSpot retry from re-dialling: only a lead that
 * actually reached `queued` on a first delivery justifies a tick.
 */
describe("campaignsToDial", () => {
  it("dials a campaign whose lead queued", () => {
    expect(campaignsToDial([{ queued: true, campaignId: "c1" }])).toEqual(["c1"]);
  });

  it("dials nothing for a quarantined, suppressed or replayed event", () => {
    expect(campaignsToDial([{ queued: false, campaignId: "c1" }])).toEqual([]);
  });

  it("dials a campaign once for a batch that queued several leads", () => {
    expect(
      campaignsToDial([
        { queued: true, campaignId: "c1" },
        { queued: true, campaignId: "c1" },
        { queued: true, campaignId: "c2" },
      ]),
    ).toEqual(["c1", "c2"]);
  });

  it("ignores an outcome with no campaign", () => {
    expect(campaignsToDial([{ queued: true, campaignId: null }])).toEqual([]);
  });
});

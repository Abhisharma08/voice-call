import { DEFAULT_CAMPAIGN_CONFIG } from "@/lib/campaigns/config";

/**
 * Starting configurations for a new client's first campaign.
 *
 * Onboarding used to end with a campaign that had no script and no questions,
 * which is a campaign that cannot be activated: `activationBlockers()` names
 * both. Someone then wrote them by hand, or - twice now - a `scripts/seed-*.ts`
 * file was added to do it, which is how client configuration ended up in the
 * repository instead of the database.
 *
 * A template is a starting point, not a policy. Every value here is editable
 * in `/campaigns/[id]` afterwards, and two things are deliberately *not*
 * included:
 *
 *   - a destination for the results. A sheet id or a HubSpot integration is a
 *     credential someone has to paste in.
 *   - a voice provider that places real calls. Every template starts on
 *     `mock`, so a new client cannot dial anyone before someone has chosen to
 *     let it.
 *
 * The question `fieldName`s are not free text: they are the extraction targets
 * in `QualificationSchema`, and the review gate looks required fields up by
 * them. Rewording a question is safe; inventing a field name is not.
 */

export interface CampaignTemplate {
  id: string;
  label: string;
  /** Shown in the picker - what this template assumes about the business. */
  summary: string;
  businessContext: string;
  /**
   * The opening. `{{name}}` and `{{requirement}}` are filled from the lead at
   * call time, so the call names the person and says their own enquiry back to
   * them rather than reading a template aloud.
   */
  script: string;
  questions: Array<{ fieldName: string; question: string; required: boolean; position: number }>;
  scoringRubric: typeof DEFAULT_CAMPAIGN_CONFIG.scoringRubric;
  /** Where this client's leads consent, for the per-lead consent record. */
  consentOrigin: string;
}

/**
 * A verification call, in every template.
 *
 * The job is to establish two or three things and get off the phone: that this
 * person did submit the form, and that what the form says they want is still
 * what they want. A longer call is a longer chance for speech recognition to
 * mangle an answer and for the lead to hang up - and the human who calls back
 * is the one who should be selling.
 */
export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    id: "windows_doors",
    label: "Windows, doors and fabrication",
    summary:
      "uPVC/aluminium windows, doors, partitions. Leads from a website quote form. Site-readiness matters more than a stated budget.",
    businessContext:
      "We manufacture and install uPVC and aluminium windows, doors, glass partitions, railings " +
      "and shower cubicles. Leads come from a website quote request. The goal of this call is to " +
      "confirm the enquiry is genuine and the requirement is current, so a technical team can be " +
      "sent to measure. Pricing is never quoted on this call - a measurement visit is what " +
      "produces a quote.",
    script:
      "Namaste {{name}}, this is an assistant calling about the quote you requested for " +
      "{{requirement}}. This is just a quick confirmation call, it will take under a minute.",
    questions: [
      {
        fieldName: "still_interested",
        question:
          "Can you confirm you submitted an enquiry with us, and that you are still looking to get this done?",
        required: true,
        position: 1,
      },
      {
        fieldName: "product_interest",
        question: "And is {{requirement}} still what you need, or has the requirement changed?",
        required: true,
        position: 2,
      },
      {
        fieldName: "timeline",
        question: "Roughly when are you looking to start the work?",
        required: false,
        position: 3,
      },
    ],
    // Site-ready-now is worth more than a stated rupee figure here: a
    // confirmed need with a short timeline converts to a measurement visit,
    // and the visit is where the quote is really made.
    scoringRubric: {
      current_need_confirmed: 30,
      short_timeline: 25,
      accepts_human_followup: 20,
      specific_product: 15,
      budget_known: 10,
      vague_curiosity: 5,
      long_term_no_plan: 0,
      explicit_rejection: -100,
    },
    consentOrigin: "website_quote_form",
  },

  {
    id: "real_estate",
    label: "Real estate and property",
    summary:
      "Residential sales enquiries from portals or lead forms. Budget and locality are the qualifying facts.",
    businessContext:
      "We sell residential property. Leads come from listing portals and landing-page forms and " +
      "are often shared across several brokers, so reaching them quickly and confirming the " +
      "enquiry is the point of this call. An advisor calls back to discuss specific inventory; " +
      "this call does not name projects or prices.",
    script:
      "Hello {{name}}, this is an assistant calling about your enquiry regarding " +
      "{{requirement}}. I have just two quick questions, it will take under a minute.",
    questions: [
      {
        fieldName: "still_interested",
        question: "Can you confirm you enquired about a property, and that you are still looking?",
        required: true,
        position: 1,
      },
      {
        fieldName: "budget",
        question: "Do you have a budget range in mind?",
        required: false,
        position: 2,
      },
      {
        fieldName: "location",
        question: "Which areas or localities are you considering?",
        required: false,
        position: 3,
      },
      {
        fieldName: "timeline",
        question: "And how soon are you looking to close?",
        required: false,
        position: 4,
      },
    ],
    // A stated budget and a named locality are what let an advisor arrive with
    // the right three properties, so both are weighted above product detail.
    scoringRubric: {
      current_need_confirmed: 25,
      short_timeline: 25,
      budget_known: 20,
      specific_product: 10,
      accepts_human_followup: 15,
      vague_curiosity: 5,
      long_term_no_plan: 0,
      explicit_rejection: -100,
    },
    consentOrigin: "landing_page_form",
  },

  {
    id: "generic",
    label: "Generic enquiry verification",
    summary:
      "Any business with an enquiry form. Confirms the enquiry is real and current, and nothing else. Edit before going live.",
    businessContext:
      "Leads come from an enquiry form on our website. The goal of this call is only to confirm " +
      "that the enquiry is genuine and still current, so a human can follow up. Describe the " +
      "business here: what it sells, what a good lead looks like, and what this call must not " +
      "promise.",
    script:
      "Hello {{name}}, this is an assistant calling about your recent enquiry regarding " +
      "{{requirement}}. This is a quick confirmation call, it will take under a minute.",
    questions: [
      {
        fieldName: "still_interested",
        question:
          "Can you confirm you submitted this enquiry, and that you are still interested?",
        required: true,
        position: 1,
      },
      {
        fieldName: "timeline",
        question: "And roughly when are you looking to go ahead?",
        required: false,
        position: 2,
      },
    ],
    scoringRubric: DEFAULT_CAMPAIGN_CONFIG.scoringRubric,
    consentOrigin: "website_enquiry_form",
  },
];

export function templateById(id: string): CampaignTemplate | null {
  return CAMPAIGN_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * The URL a client's HubSpot posts leads to.
 *
 * The campaign is a query parameter because HubSpot's payload cannot carry it
 * and a service token is per tenant, not per campaign. Built from `APP_URL`
 * rather than from the browser's own origin: what matters is the address
 * HubSpot must reach, which behind a tunnel or a preview deployment is not the
 * host the operator happens to be looking at.
 */
export function hubspotWebhookUrl(appUrl: string, campaignId: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/webhooks/hubspot/leads?campaign=${campaignId}`;
}

/**
 * The URL a HubSpot **private app** subscription posts to - the path a free
 * portal can use, since free HubSpot has no workflows.
 *
 * No campaign in the URL, and no token: one private app has a single target
 * for the whole account, so the campaign is routed from a contact property,
 * and the request authenticates with `X-HubSpot-Signature-v3` rather than a
 * header we could put here. Which client it belongs to comes from the
 * `portalId` in the payload.
 */
export function hubspotAppWebhookUrl(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/webhooks/hubspot/events`;
}

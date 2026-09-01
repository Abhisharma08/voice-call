import { z } from "zod";

/**
 * The structured qualification result (FR-031, FR-032, PRD Appendix B).
 *
 * FR-031: "AI must return strict structured result. Schema validation passes
 * before persistence."
 * FR-032: "Unknown answers may be marked unknown; AI must not invent values.
 * Unsupported facts are null/unknown."
 *
 * Every extracted field is nullable for exactly that reason. A model that
 * cannot find a budget in the transcript must say null, and the rubric in
 * scoring.ts awards nothing for a null - so the failure mode of a missing
 * answer is a lower score and a review, never a fabricated one.
 */

export const INTENTS = [
  "hot",
  "interested",
  "warm",
  "follow_up",
  "not_interested",
  "wrong_number",
  "no_answer",
  "busy",
  "do_not_call",
  "unknown",
] as const;

export type Intent = (typeof INTENTS)[number];

export const QualificationSchema = z.object({
  intent: z.enum(INTENTS).describe("The lead's overall intent, from the standard taxonomy"),

  /**
   * The model's own read of how confident it is. This drives the review gate
   * (PRD 26.3), so it is required rather than optional - an absent confidence
   * would silently read as zero or as one depending on the caller.
   */
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0-1 confidence in the intent classification. Be honest; low confidence is routed to a human."),

  /** Free-text justification, kept short. Shown to the reviewing operator. */
  reason: z.string().max(500).describe("One or two sentences justifying the intent, quoting the lead where possible"),

  summary: z.string().max(500).describe("Neutral summary of what the lead said"),

  // ── Campaign qualification fields (PRD 10.3) ──────────────────────────────
  still_interested: z.boolean().nullable().describe("null if the lead never addressed it"),
  timeline: z
    .enum(["0-3_months", "3-6_months", "6-12_months", "12_months_plus", "unknown"])
    .describe("Purchase timeline as stated. 'unknown' if not stated - do not infer."),
  budget: z.string().nullable().describe("Budget exactly as stated by the lead, or null"),
  location: z.string().nullable().describe("Location of interest as stated, or null"),
  product_interest: z.string().nullable().describe("Specific product or service named, or null"),

  // ── Routing signals (FR-033, FR-034) ──────────────────────────────────────
  callback_requested: z.boolean().describe("The lead asked to be called back later"),
  callback_time_iso: z
    .string()
    .nullable()
    .describe("ISO 8601 datetime if the lead named a specific time, else null"),
  human_followup: z.boolean().describe("The lead asked for a human, or explicitly wants an advisor"),
  do_not_call: z.boolean().describe("The lead explicitly asked not to be contacted again"),
  wrong_number: z.boolean().describe("The person reached is not the lead"),
});

export type QualificationResult = z.infer<typeof QualificationSchema>;

/**
 * A result the platform can fall back to when analysis fails outright
 * (PRD 18.2: "LLM schema failure - Yes, limited - Fallback to manual review").
 * It never auto-commits: unknown intent with zero confidence always trips the
 * review gate.
 */
export function unknownResult(reason: string): QualificationResult {
  return {
    intent: "unknown",
    confidence: 0,
    reason,
    summary: "Automated analysis did not produce a usable result.",
    still_interested: null,
    timeline: "unknown",
    budget: null,
    location: null,
    product_interest: null,
    callback_requested: false,
    callback_time_iso: null,
    human_followup: false,
    do_not_call: false,
    wrong_number: false,
  };
}

/**
 * Outcomes that describe the *call*, not the conversation. If the call never
 * connected there is nothing to qualify, so these bypass the model entirely -
 * sending a no-answer to an LLM only invites it to invent a conversation.
 */
export function resultForUnconnectedCall(status: "no_answer" | "busy" | "failed" | "canceled"): QualificationResult {
  return {
    ...unknownResult(`Call ended with status ${status}; no conversation took place.`),
    intent: status === "no_answer" ? "no_answer" : status === "busy" ? "busy" : "unknown",
    confidence: 1,
    summary: `No conversation: call ${status}.`,
  };
}

import type { QualificationResult } from "@/lib/qualification/schema";
import type { RoutingThresholds } from "@/lib/qualification/scoring";

/**
 * The human-review gate.
 *
 * Low-confidence or borderline results go to a human review queue instead of
 * being auto-committed to the CRM or the sheet. They are held in
 * pending_review and excluded from auto-sync until an operator confirms or
 * corrects them.
 *
 * Three triggers, and no others - importantly, the
 * default when in doubt is to hold. The client never sees a result before it
 * lands in their CRM, so the Operations Manager is the only checkpoint.
 */

export type ReviewTrigger =
  | "low_confidence"
  | "missing_required_fields"
  | "boundary_band"
  | "dnc_needs_verification"
  | "analysis_failed";

export interface ReviewGateInput {
  result: QualificationResult;
  score: number;
  confidenceThreshold: number;
  /** Configurable band around the hot/interested boundary, e.g. +/- 5. */
  boundaryBand: number;
  thresholds: RoutingThresholds;
  /** Campaign fields marked required in qualification_rules. */
  requiredFields: string[];
  /** True when the call never connected, so there is nothing to review. */
  unconnected: boolean;
}

export type ReviewDecision =
  | { hold: false }
  | { hold: true; triggers: ReviewTrigger[]; reason: string };

export function evaluateReviewGate(input: ReviewGateInput): ReviewDecision {
  // Nothing to review on a call that never connected - the outcome is a fact
  // about the telephony, not a model judgement. It retries on its own.
  if (input.unconnected) return { hold: false };

  const triggers: ReviewTrigger[] = [];

  if (input.result.confidence < input.confidenceThreshold) {
    triggers.push("low_confidence");
  }

  // "Required qualification fields left unknown/null -> routed to review queue
  // rather than defaulted to a score."
  //
  // Not applied when the lead ended the conversation outright. Someone who
  // says "do not call me" never gets asked the qualification questions, so
  // their unanswered fields are expected rather than suspicious - and holding
  // a do-not-call in a queue risks dialling them again before an operator
  // clears it, which is the one error here with a regulatory cost.
  const missing = endedConversation(input.result)
    ? []
    : input.requiredFields.filter((field) => isMissing(input.result, field));
  if (missing.length > 0) triggers.push("missing_required_fields");

  // "Score near the hot/interested boundary (configurable band, e.g. +/-5)."
  const band = input.boundaryBand;
  const nearHot = Math.abs(input.score - input.thresholds.hotThreshold) <= band;
  const nearInterested = Math.abs(input.score - input.thresholds.interestedThreshold) <= band;
  if (nearHot || nearInterested) triggers.push("boundary_band");

  // Not in the table, but a hallucinated DNC permanently suppresses a
  // real lead and cannot be undone by a later call - so a low-confidence DNC
  // gets a human before the suppression is written.
  if (input.result.do_not_call && input.result.confidence < 0.9) {
    triggers.push("dnc_needs_verification");
  }

  if (triggers.length === 0) return { hold: false };

  return { hold: true, triggers, reason: describe(triggers, input, missing) };
}

/** The lead closed the conversation, so unanswered questions are expected. */
function endedConversation(result: QualificationResult): boolean {
  return (
    result.do_not_call ||
    result.wrong_number ||
    result.intent === "do_not_call" ||
    result.intent === "not_interested" ||
    result.intent === "wrong_number"
  );
}

function isMissing(result: QualificationResult, field: string): boolean {
  const value = (result as unknown as Record<string, unknown>)[field];
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && (value.trim() === "" || value === "unknown")) return true;
  return false;
}

function describe(triggers: ReviewTrigger[], input: ReviewGateInput, missing: string[]): string {
  const parts: string[] = [];

  for (const trigger of triggers) {
    switch (trigger) {
      case "low_confidence":
        parts.push(
          `confidence ${input.result.confidence.toFixed(2)} below threshold ${input.confidenceThreshold}`,
        );
        break;
      case "missing_required_fields":
        parts.push(`required fields unanswered: ${missing.join(", ")}`);
        break;
      case "boundary_band":
        parts.push(`score ${input.score} within ${input.boundaryBand} of a routing boundary`);
        break;
      case "dnc_needs_verification":
        parts.push("do-not-call detected below 0.90 confidence; suppression is irreversible");
        break;
      case "analysis_failed":
        parts.push("analysis did not produce a valid result");
        break;
    }
  }

  return parts.join("; ");
}

/**
 * Whether a result may sync downstream. Pending_review results are
 * "excluded from Sheets append and HubSpot update until resolved".
 */
export function mayAutoSync(reviewStatus: string): boolean {
  return reviewStatus === "auto_approved" || reviewStatus === "confirmed" || reviewStatus === "corrected";
}

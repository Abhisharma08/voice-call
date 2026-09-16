import { resolveAnalysisProvider } from "@/lib/qualification/providers";
import { unknownResult, type QualificationResult } from "@/lib/qualification/schema";
import { logger } from "@/lib/observability/log";

export { __setAnthropicClient } from "@/lib/qualification/providers/anthropic";

/**
 * Transcript analysis (PRD 10, FR-030 to FR-034), workflow W03 step 3.
 *
 * Two constraints from the PRD shape this:
 *
 *   FR-031 "AI must return strict structured result. Schema validation passes
 *   before persistence" - so this uses structured outputs against the Zod
 *   schema rather than parsing JSON out of prose.
 *
 *   FR-032 "Unknown answers may be marked unknown; AI must not invent values"
 *   and PRD 10.2 "Never fabricate pricing, availability, eligibility, policy
 *   terms, or product details" - so the system prompt is explicit that null is
 *   the correct answer for anything the lead did not say, and the review gate
 *   catches the cases where it hedges.
 *
 * Which model runs is resolved from `campaigns.analysis_model` through the
 * registry in ./providers. Everything in this file is provider-neutral: the
 * prompt, the schema, and the rule that a failure becomes a review rather than
 * a guess are the same whichever adapter answers.
 */

export interface AnalyzeRequest {
  transcript: string;
  campaign: {
    clientName: string;
    campaignName: string;
    businessContext: string;
    productService: string | null;
    questions: Array<{ fieldName: string; question: string; required: boolean }>;
    model: string;
    effort: string;
    promptVersion: string;
  };
  callDurationSec: number | null;
}

export interface AnalyzeResponse {
  result: QualificationResult;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the model failed and the caller got the unknown fallback. */
  degraded: boolean;
}

/**
 * The stable half of the prompt. Kept byte-identical across every call for a
 * given prompt version so it caches: with one system prompt shared by every
 * call in a campaign, the cached prefix is read on all but the first request.
 */
export function systemPrompt(campaign: AnalyzeRequest["campaign"]): string {
  const questionList = campaign.questions
    .map((q) => `- ${q.fieldName}${q.required ? " (required)" : ""}: ${q.question}`)
    .join("\n");

  return `You analyse completed sales qualification phone calls for ${campaign.clientName}.

Business context: ${campaign.businessContext}
Campaign: ${campaign.campaignName}
Product/service: ${campaign.productService ?? "not specified"}

The qualification questions this campaign asks:
${questionList || "- (none configured)"}

Your job is to read a call transcript and report what the lead actually said.

Rules:
- Report only what is supported by the transcript. Never infer, extrapolate, or fill a gap with a plausible value.
- If the lead did not answer something, the value is null (or "unknown" for timeline). A null is a correct answer, not a failure.
- Never invent pricing, availability, eligibility, policy terms, or product details.
- Set do_not_call only for an explicit request not to be contacted again. "Not interested right now" is not_interested, not do_not_call - the first stops one campaign, the second permanently suppresses a real person.
- Set callback_requested when the lead asks to be reached later. Fill callback_time_iso only if they named a specific time.
- Set human_followup when the lead asks for a person, an advisor, or a callback from sales.
- Set wrong_number when the person reached is not the lead.
- confidence is your honest read of how well the transcript supports your intent classification. Low confidence is routed to a human reviewer, which is the correct outcome for an ambiguous call. Do not inflate it.

Intent taxonomy:
- hot: high purchase intent, ready for human follow-up
- interested: genuine interest, not necessarily immediate
- warm: some interest, weak commitment
- follow_up: explicitly asked to be contacted later
- not_interested: explicitly declines
- wrong_number: the number does not belong to the lead
- do_not_call: explicitly asks never to be contacted again
- unknown: the transcript does not support a classification`;
}

export function userPrompt(request: AnalyzeRequest): string {
  return [
    "Analyse this call transcript.",
    request.callDurationSec !== null ? `Call duration: ${request.callDurationSec} seconds.` : "",
    "",
    "<transcript>",
    request.transcript,
    "</transcript>",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function analyzeTranscript(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const startedAt = Date.now();

  // Resolution can throw for a model no adapter claims, or one whose provider
  // has no credentials. That is caught below with everything else, so a
  // misconfigured campaign holds its leads for review rather than losing them.
  let provider;
  try {
    provider = resolveAnalysisProvider(request.campaign.model);
  } catch (err) {
    return degraded(request, startedAt, err instanceof Error ? err.message : String(err), null);
  }

  try {
    const response = await provider.analyze({
      model: request.campaign.model,
      effort: request.campaign.effort,
      system: systemPrompt(request.campaign),
      user: userPrompt(request),
    });

    if (!response.parsed) {
      // Structured output did not validate. PRD 18.2: "LLM schema failure -
      // Yes, limited - Fallback to manual review."
      return degraded(request, startedAt, "Model response did not satisfy the qualification schema.", {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });
    }

    return {
      result: response.parsed,
      model: response.model,
      promptVersion: request.campaign.promptVersion,
      latencyMs: Date.now() - startedAt,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      degraded: false,
    };
  } catch (err) {
    // A rate limit or outage must not lose the call. The result is held for
    // review and the caller decides whether to retry.
    return degraded(request, startedAt, provider.describeError(err), null);
  }
}

function degraded(
  request: AnalyzeRequest,
  startedAt: number,
  reason: string,
  usage: { inputTokens: number | null; outputTokens: number | null } | null,
): AnalyzeResponse {
  /**
   * The reason travels in the result and is shown on the review item, which is
   * the right place for the operator handling that one lead. It is the wrong
   * place to notice that *every* lead is degrading - a bad key or a wrong model
   * id looks identical to a queue of genuinely ambiguous calls until someone
   * opens one and reads it.
   *
   * So it is logged too. Model and reason only: the transcript and the lead's
   * details are not diagnostic here and do not belong in a log (PRD 26.2).
   */
  logger.error("qualification degraded to unknown; result held for review", {
    model: request.campaign.model,
    reason,
  });

  return {
    result: unknownResult(reason),
    model: request.campaign.model,
    promptVersion: request.campaign.promptVersion,
    latencyMs: Date.now() - startedAt,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    degraded: true,
  };
}

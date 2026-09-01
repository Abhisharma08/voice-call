import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  QualificationSchema,
  unknownResult,
  type QualificationResult,
} from "@/lib/qualification/schema";

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

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
  // `ant auth login` profile - see the SDK's resolution order.
  client ??= new Anthropic();
  return client;
}

/**
 * The stable half of the prompt. Kept byte-identical across every call for a
 * given prompt version so it caches: with one system prompt shared by every
 * call in a campaign, the cached prefix is read on all but the first request.
 */
function systemPrompt(campaign: AnalyzeRequest["campaign"]): string {
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

export async function analyzeTranscript(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const startedAt = Date.now();

  try {
    const response = await anthropic().messages.parse({
      model: request.campaign.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: {
        effort: request.campaign.effort as "low" | "medium" | "high" | "xhigh" | "max",
        format: zodOutputFormat(QualificationSchema),
      },
      system: [
        {
          type: "text",
          text: systemPrompt(request.campaign),
          // The system prompt is identical for every call in this campaign;
          // caching it keeps per-call cost close to the transcript alone.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            "Analyse this call transcript.",
            request.callDurationSec !== null ? `Call duration: ${request.callDurationSec} seconds.` : "",
            "",
            "<transcript>",
            request.transcript,
            "</transcript>",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      // Structured output did not validate. PRD 18.2: "LLM schema failure -
      // Yes, limited - Fallback to manual review."
      return degraded(
        request,
        startedAt,
        "Model response did not satisfy the qualification schema.",
        response.usage,
      );
    }

    return {
      result: parsed,
      model: response.model,
      promptVersion: request.campaign.promptVersion,
      latencyMs: Date.now() - startedAt,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      degraded: false,
    };
  } catch (err) {
    // A rate limit or outage must not lose the call. The result is held for
    // review and the caller decides whether to retry.
    const message =
      err instanceof Anthropic.RateLimitError
        ? "Analysis rate limited"
        : err instanceof Anthropic.APIError
          ? `Analysis failed with API error ${err.status}`
          : `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;

    return degraded(request, startedAt, message, null);
  }
}

function degraded(
  request: AnalyzeRequest,
  startedAt: number,
  reason: string,
  usage: { input_tokens: number; output_tokens: number } | null,
): AnalyzeResponse {
  return {
    result: unknownResult(reason),
    model: request.campaign.model,
    promptVersion: request.campaign.promptVersion,
    latencyMs: Date.now() - startedAt,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    degraded: true,
  };
}

/** Test seam: replace the Anthropic client with a stub. */
export function __setAnthropicClient(stub: Anthropic | null): void {
  client = stub;
}

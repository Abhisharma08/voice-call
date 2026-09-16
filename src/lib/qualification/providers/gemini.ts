import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { QualificationSchema } from "@/lib/qualification/schema";
import type {
  AnalysisProvider,
  AnalysisRequest,
  AnalysisResult,
} from "@/lib/qualification/providers/types";

/**
 * Gemini adapter, against the Interactions API (`interactions.create`).
 *
 * Three differences from the Anthropic path are worth knowing, because they
 * change what the platform can promise:
 *
 *   1. No explicit prompt caching. The Interactions API supports implicit
 *      caching only - it is automatic on a shared prefix, needs no flag, and
 *      cannot be forced. Our system prompt is byte-identical per campaign so
 *      it is eligible, but a short one may fall under the model's minimum
 *      cacheable prefix and simply never hit. Cost per call is therefore less
 *      predictable here than under Anthropic's explicit cache_control.
 *
 *   2. `store` defaults to true, which retains the interaction server-side.
 *      Transcripts are the most sensitive text this platform handles - PRD
 *      26.2 keeps them encrypted and access-logged - so this adapter turns it
 *      off explicitly. Do not remove that without a compliance decision.
 *
 *   3. Structured output is a JSON Schema on the request, not a Zod binding,
 *      and the model returns text. So the schema is converted here and the
 *      response is validated with the same Zod schema the Anthropic path uses,
 *      which keeps FR-031 ("schema validation passes before persistence") true
 *      for both providers rather than trusting either model's own conformance.
 */

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  // The SDK reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment.
  client ??= new GoogleGenAI({});
  return client;
}

/** Reset between tests, and after an env change that should rebuild the client. */
export function resetGeminiClient(): void {
  client = null;
}

/**
 * `$schema` is a JSON Schema meta-annotation, not part of the constrained
 * grammar, and the API rejects properties it does not recognise. Everything
 * else Zod 4 emits for this schema is in the supported subset: nullable fields
 * come out as `type: ["string", "null"]` and enums as `enum`, both of which
 * the API accepts.
 */
export function qualificationJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(QualificationSchema, {
    io: "output",
  }) as Record<string, unknown>;
  return rest;
}

/**
 * `analysis_effort` carries Anthropic's five levels. Gemini exposes three, so
 * the two extremes collapse rather than being rejected - a campaign set to
 * `max` should still run on Gemini, just at the highest level Gemini has.
 */
function thinkingLevel(effort: string): "low" | "medium" | "high" {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/** Usage field names differ across API revisions; read defensively. */
function tokenCount(usage: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number") return value;
  }
  return null;
}

export class GeminiAnalysisProvider implements AnalysisProvider {
  readonly name = "gemini";

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const interaction = await gemini().interactions.create({
      model: request.model,
      input: request.user,
      system_instruction: request.system,
      // Transcripts are PII. See note 2 above.
      store: false,
      generation_config: {
        thinking_level: thinkingLevel(request.effort),
        max_output_tokens: 4096,
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: qualificationJsonSchema(),
      },
      // The SDK's types track a beta API; the fields above are documented for
      // this revision but are not all in the published typings yet.
    } as never);

    const usage = (interaction as { usage?: Record<string, unknown> }).usage;
    const outputText = (interaction as { output_text?: string }).output_text ?? "";

    return {
      parsed: parseOutput(outputText),
      model: (interaction as { model?: string }).model ?? request.model,
      inputTokens: tokenCount(usage, "total_input_tokens", "input_tokens", "promptTokenCount"),
      // Thinking tokens are billed as output, so a total that excludes them
      // would understate cost in the PRD 21 metrics.
      outputTokens: sumOutputTokens(usage),
    };
  }

  describeError(err: unknown): string {
    const status = (err as { status?: number })?.status;
    if (status === 429) return "Analysis rate limited";
    if (typeof status === "number") {
      return `Analysis failed with API error ${status}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    return `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The model returns text even under a response schema, so this is where
 * FR-031 is actually enforced. A parse failure returns null, which the caller
 * turns into a degraded result held for review - never a partial object.
 */
function parseOutput(text: string): AnalysisResult["parsed"] {
  if (!text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const validated = QualificationSchema.safeParse(json);
  return validated.success ? validated.data : null;
}

function sumOutputTokens(usage: Record<string, unknown> | undefined): number | null {
  const output = tokenCount(usage, "total_output_tokens", "output_tokens", "candidatesTokenCount");
  const thinking = tokenCount(usage, "total_thought_tokens", "thought_tokens");
  if (output === null) return thinking;
  return output + (thinking ?? 0);
}

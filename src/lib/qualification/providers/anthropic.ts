import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { QualificationSchema } from "@/lib/qualification/schema";
import type {
  AnalysisProvider,
  AnalysisRequest,
  AnalysisResult,
} from "@/lib/qualification/providers/types";

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
  // `ant auth login` profile - see the SDK's resolution order.
  //
  // An identity-linked API key is scoped to a person rather than to a
  // workspace, so it cannot infer which workspace a request acts in and the
  // API rejects it with a 400 until one is named. Sending the header is
  // harmless for key types that do not need it, but only set it when
  // configured: an empty header value is itself an error.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  client ??= new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );
  return client;
}

/**
 * Test seam: inject a stub client, or pass null to restore the real one. The
 * database suite drives the whole slice against a real PostgreSQL and stubs
 * only this, so the pipeline under test is the real one.
 */
export function __setAnthropicClient(stub: Anthropic | null): void {
  client = stub;
}

export class AnthropicAnalysisProvider implements AnalysisProvider {
  readonly name = "anthropic";

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const response = await anthropic().messages.parse({
      model: request.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: {
        effort: request.effort as "low" | "medium" | "high" | "xhigh" | "max",
        format: zodOutputFormat(QualificationSchema),
      },
      system: [
        {
          type: "text",
          text: request.system,
          // The system prompt is identical for every call in this campaign;
          // caching it keeps per-call cost close to the transcript alone.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: request.user }],
    });

    return {
      parsed: response.parsed_output ?? null,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  describeError(err: unknown): string {
    if (err instanceof Anthropic.RateLimitError) return "Analysis rate limited";
    if (err instanceof Anthropic.APIError) {
      // A 400 here is usually configuration rather than a transient fault -
      // an identity-linked key with no ANTHROPIC_WORKSPACE_ID set is the
      // common one, and it otherwise looks identical to having no key at all.
      return `Analysis failed with API error ${err.status}: ${err.message}`;
    }
    return `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

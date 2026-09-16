import type { QualificationResult } from "@/lib/qualification/schema";

/**
 * The seam between "analyse this transcript" and whichever model does it
 * (PRD 10.4 applies the same reasoning to voice providers: the choice is
 * configuration, not code).
 *
 * Everything provider-neutral - the prompt text, the schema, the degraded
 * fallback, the scoring that follows - lives above this line in analyze.ts.
 * An adapter's whole job is: send these two strings, come back with something
 * that satisfies QualificationSchema, or throw.
 */

export interface AnalysisRequest {
  /** Provider-specific model id, straight from `campaigns.analysis_model`. */
  model: string;
  /** `campaigns.analysis_effort`: low | medium | high | xhigh | max. */
  effort: string;
  /**
   * Byte-identical for every call in a campaign at a given prompt version, so
   * providers that cache on a common prefix get a hit on all but the first.
   */
  system: string;
  user: string;
}

export interface AnalysisResult {
  /**
   * null means the model answered but the answer did not satisfy the schema.
   * That is a degraded result, not an exception: PRD 18.2 routes an "LLM
   * schema failure" to manual review rather than losing the call.
   */
  parsed: QualificationResult | null;
  /** What the provider says it actually ran, which may differ from `model`. */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AnalysisProvider {
  readonly name: string;

  analyze(request: AnalysisRequest): Promise<AnalysisResult>;

  /**
   * Turn a thrown error into a reason an operator can act on, since it is
   * written to `call_analyses.review_reason` and read in the review queue.
   * Each SDK has its own error classes, so each adapter maps its own.
   */
  describeError(err: unknown): string;
}

import { AnthropicAnalysisProvider } from "@/lib/qualification/providers/anthropic";
import { GeminiAnalysisProvider } from "@/lib/qualification/providers/gemini";
import type { AnalysisProvider } from "@/lib/qualification/providers/types";

/**
 * Analysis provider registry, deliberately the same shape as the voice
 * provider registry in src/lib/providers/voice - switching a client's
 * qualification model is a configuration change, not a deployment.
 *
 * Resolution is by model id prefix rather than a separate provider column,
 * because `campaigns.analysis_model` already names the model and a second
 * column could contradict it. The prefix is the provider's own namespace:
 * `claude-*` is Anthropic's, `gemini-*` is Google's.
 */

type Factory = () => AnalysisProvider;

const registry = new Map<string, Factory>();

export function registerAnalysisProvider(prefix: string, factory: Factory): void {
  registry.set(prefix, factory);
}

export function analysisProviderNames(): string[] {
  return [...registry.keys()];
}

/**
 * Throwing here is safe and intended. The one caller wraps analysis in a
 * try/catch that degrades to manual review (PRD 18.2), so a campaign pointed
 * at an unconfigured provider holds its leads for a human with the reason
 * attached - rather than dialling on and writing results no model produced.
 */
export function resolveAnalysisProvider(model: string): AnalysisProvider {
  for (const [prefix, factory] of registry) {
    if (model.startsWith(prefix)) return factory();
  }
  throw new Error(
    `No analysis provider is configured for model "${model}". ` +
      `Registered prefixes: ${analysisProviderNames().join(", ") || "none"}.`,
  );
}

// Anthropic is always registered. The SDK resolves its own credentials, and
// their absence is a documented degraded mode rather than a startup failure:
// every call returns `unknown` at confidence 0 and trips the review gate.
registerAnalysisProvider("claude-", () => new AnthropicAnalysisProvider());

// Gemini registers only when it has a key, so selecting a Gemini model on an
// unconfigured deployment fails with a message naming what is registered
// instead of failing later inside the SDK with something less legible.
if (process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()) {
  registerAnalysisProvider("gemini-", () => new GeminiAnalysisProvider());
}

export type { AnalysisProvider, AnalysisRequest, AnalysisResult } from "@/lib/qualification/providers/types";

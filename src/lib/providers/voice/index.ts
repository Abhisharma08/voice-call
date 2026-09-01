import { MockVoiceProvider } from "@/lib/providers/voice/mock";
import { SarvamVoiceProvider, sarvamConfigFromEnv } from "@/lib/providers/voice/sarvam";
import type { VoiceProvider } from "@/lib/providers/voice/types";

/**
 * Provider registry. The calling worker resolves by name from
 * `campaigns.voice_provider`, so switching a client to a regional carrier is a
 * configuration change (PRD 10.4, and the compliance-driven provider choice in
 * PRD 17.3).
 */

const registry = new Map<string, () => VoiceProvider>();

export function registerProvider(name: string, factory: () => VoiceProvider): void {
  registry.set(name, factory);
}

export function resolveProvider(name: string): VoiceProvider {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown voice provider "${name}". Registered: ${[...registry.keys()].join(", ") || "none"}`,
    );
  }
  return factory();
}

export function providerNames(): string[] {
  return [...registry.keys()];
}

// Always available: places no calls, returns scripted transcripts, and is what
// the test suite and `npm run demo` drive.
registerProvider("mock", () => new MockVoiceProvider(process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret"));

// Sarvam registers only when configured. Selecting an unconfigured provider on
// a campaign then fails loudly at claim time with a message naming what is
// registered, rather than dialling through something half-set-up.
const sarvam = sarvamConfigFromEnv();
if (sarvam) {
  registerProvider("sarvam", () => new SarvamVoiceProvider(sarvam));
}

export type { VoiceProvider } from "@/lib/providers/voice/types";

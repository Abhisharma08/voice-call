import { MockVoiceProvider } from "@/lib/providers/voice/mock";
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

// The only provider Phase 1 ships. A real carrier adapter registers itself the
// same way and needs no change in the calling worker.
registerProvider("mock", () => new MockVoiceProvider(process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret"));

export type { VoiceProvider } from "@/lib/providers/voice/types";

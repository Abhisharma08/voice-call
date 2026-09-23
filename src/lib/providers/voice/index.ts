import { MockVoiceProvider } from "@/lib/providers/voice/mock";
import { SarvamVoiceProvider, sarvamConfigFromEnv } from "@/lib/providers/voice/sarvam";
import { TwilioVoiceProvider, twilioConfigFromEnv } from "@/lib/providers/voice/twilio";
import type { VoiceProvider } from "@/lib/providers/voice/types";

/**
 * Provider registry. The calling worker resolves by name from
 * `campaigns.voice_provider`, so switching a client to a regional carrier is a
 * configuration change - and, since a provider is also a compliance choice, a
 * decision that can be made per client.
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

// Twilio is telephony only - the conversation is TwiML this platform serves.
// Registered for local testing against a phone that actually rings; the
// production voice agent is Sarvam or ElevenLabs, and ElevenLabs sits on a
// Twilio number too, so the account carries forward.
const twilio = twilioConfigFromEnv();
if (twilio) {
  registerProvider("twilio", () => new TwilioVoiceProvider(twilio));
}

export type { VoiceProvider } from "@/lib/providers/voice/types";

/**
 * Why a provider is or is not selectable, without touching the registry.
 *
 * A campaign names its provider as a string, and an unconfigured one fails at
 * claim time - correctly, but late and out of sight, in a worker log. The
 * question "can this client actually dial?" should be answerable while
 * configuring the campaign, which means naming the environment variables that
 * are missing rather than reporting a boolean.
 *
 * Read from `process.env` on each call rather than from the module-level
 * config captured at import: a value added to the environment after boot
 * should show up here as soon as the process restarts, and reading live keeps
 * this honest about what a *restart* would register - never about what this
 * process already did.
 */
export interface ProviderDiagnostic {
  name: string;
  registered: boolean;
  /** Environment variables required but unset. Empty when registered. */
  missing: string[];
  /** What this provider is for, and what it is not. */
  note: string;
}

const PROVIDER_REQUIREMENTS: Array<{ name: string; vars: string[]; note: string }> = [
  {
    name: "mock",
    vars: [],
    note: "Always available. Places no calls and returns scripted transcripts - for exercising the pipeline, never for a real list.",
  },
  {
    name: "twilio",
    vars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    note: "Telephony only: the conversation is TwiML this platform serves, one question per turn with no barge-in. Real calls, audibly a robot. Needs a public APP_URL.",
  },
  {
    name: "sarvam",
    vars: [
      "SARVAM_API_KEY",
      "SARVAM_ORG_ID",
      "SARVAM_WORKSPACE_ID",
      "SARVAM_APP_ID",
      "SARVAM_CONNECTION_ID",
      "SARVAM_AGENT_PHONE_NUMBER",
    ],
    note: "India-native conversational voice agent, and the one meant for production here. Sarvam runs the conversation; this platform only starts the call and reads the result.",
  },
];

export function providerDiagnostics(): ProviderDiagnostic[] {
  const registered = new Set(providerNames());

  return PROVIDER_REQUIREMENTS.map((p) => ({
    name: p.name,
    registered: registered.has(p.name),
    missing: p.vars.filter((v) => !process.env[v]?.trim()),
    note: p.note,
  }));
}

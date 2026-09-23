import type { SarvamConfig } from "@/lib/providers/voice/sarvam";
import type { TwilioConfig } from "@/lib/providers/voice/twilio";

/**
 * Voice provider credentials entered through the UI.
 *
 * Until now a provider was configured only by environment variable, which
 * meant onboarding a client with their own Sarvam workspace required a deploy,
 * and every client on the platform shared one voice account. The other
 * credentials this platform holds - HubSpot, Sheets, Slack - have been
 * per-client and sealed since Phase 2; this brings the dialler in line with
 * them.
 *
 * The field list is declared once and used by both the form and the
 * validator, because the failure mode of having two copies is a form that
 * cheerfully accepts something the dialler cannot use, discovered at the first
 * real call.
 *
 * `webhookSecret` and `publicUrl` are deliberately *not* here. They are
 * properties of this deployment rather than of the client's account: the
 * secret keys a token we mint and verify ourselves, and the public URL is
 * where the provider has to reach this process. A per-client value for either
 * would be a per-client way to break inbound callbacks.
 */

export interface VoiceProviderField {
  key: string;
  label: string;
  hint?: string;
  /** Rendered as a password field and never echoed back. */
  secret?: boolean;
  optional?: boolean;
}

export interface VoiceProviderSpec {
  provider: string;
  label: string;
  note: string;
  fields: VoiceProviderField[];
}

export const VOICE_PROVIDER_SPECS: VoiceProviderSpec[] = [
  {
    provider: "sarvam",
    label: "Sarvam AI",
    note: "Sarvam runs the conversation. This platform starts the call and reads the result.",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      { key: "orgId", label: "Organisation ID" },
      { key: "workspaceId", label: "Workspace ID" },
      { key: "appId", label: "App ID", hint: "The configured voice agent that will speak" },
      { key: "appVersion", label: "App version", hint: "Defaults to 1", optional: true },
      { key: "connectionId", label: "Connection ID", hint: "The telephony connection" },
      { key: "agentPhoneNumber", label: "Agent phone number", hint: "Calls originate from this" },
    ],
  },
  {
    provider: "twilio",
    label: "Twilio",
    note: "Telephony only: the conversation is TwiML this platform serves. Real calls, audibly a robot.",
    fields: [
      { key: "accountSid", label: "Account SID" },
      { key: "authToken", label: "Auth token", secret: true },
      { key: "fromNumber", label: "From number", hint: "E.164, or a verified caller ID" },
    ],
  },
];

export function specFor(provider: string): VoiceProviderSpec | null {
  return VOICE_PROVIDER_SPECS.find((s) => s.provider === provider) ?? null;
}

export interface VoiceCredential {
  provider: string;
  [key: string]: string | undefined;
}

/** Every required field is present by the time a credential is stored. */
function required(credential: VoiceCredential, key: string): string {
  const value = credential[key];
  if (value === undefined) {
    throw new Error(`Stored voice credential is missing ${key}`);
  }
  return value;
}

/**
 * Check a pasted or submitted voice credential while the plaintext is still in
 * hand. Returns an error message, or null when it is usable.
 */
export function validateVoiceCredential(credential: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(credential) as Record<string, unknown>;
  } catch {
    return 'Expected JSON like {"provider": "sarvam", "apiKey": "...", ...}';
  }

  const provider = parsed.provider;
  if (typeof provider !== "string") {
    return `Name the provider: ${VOICE_PROVIDER_SPECS.map((s) => s.provider).join(" or ")}`;
  }

  const spec = specFor(provider);
  if (!spec) {
    return `Unknown voice provider "${provider}". Configurable: ${VOICE_PROVIDER_SPECS.map(
      (s) => s.provider,
    ).join(", ")}`;
  }

  const missing = spec.fields
    .filter((f) => !f.optional)
    .filter((f) => typeof parsed[f.key] !== "string" || (parsed[f.key] as string).trim() === "")
    .map((f) => f.label);

  if (missing.length > 0) {
    return `${spec.label} needs ${missing.join(", ")}`;
  }

  // A phone number that is not in E.164 is accepted by the form and rejected
  // by the carrier at dial time, which is the worst place to find out.
  if (provider === "sarvam" || provider === "twilio") {
    const numberKey = provider === "sarvam" ? "agentPhoneNumber" : "fromNumber";
    const value = String(parsed[numberKey]).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(value)) {
      return `${numberKey === "agentPhoneNumber" ? "Agent phone number" : "From number"} must be E.164, starting with + and country code`;
    }
  }

  return null;
}

/** The provider a stored credential is for, without unsealing it. */
export function providerOf(credential: string): string | null {
  try {
    const parsed = JSON.parse(credential) as { provider?: unknown };
    return typeof parsed.provider === "string" ? parsed.provider : null;
  } catch {
    return null;
  }
}

/**
 * Turn a stored credential into the config its adapter takes, filling in the
 * deployment-level values the credential deliberately does not carry.
 */
export function sarvamConfigFrom(credential: VoiceCredential): SarvamConfig {
  return {
    apiKey: required(credential, "apiKey"),
    orgId: required(credential, "orgId"),
    workspaceId: required(credential, "workspaceId"),
    appId: required(credential, "appId"),
    appVersion: Number(credential.appVersion ?? 1) || 1,
    connectionId: required(credential, "connectionId"),
    agentPhoneNumber: required(credential, "agentPhoneNumber"),
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret",
  };
}

export function twilioConfigFrom(credential: VoiceCredential): TwilioConfig {
  return {
    accountSid: required(credential, "accountSid"),
    authToken: required(credential, "authToken"),
    fromNumber: required(credential, "fromNumber"),
    publicUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret",
  };
}

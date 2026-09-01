import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreateCallRequest,
  CreateCallResult,
  NormalizedWebhook,
  ProviderCallState,
  ProviderCallStatus,
  ProviderMetadata,
  ProviderTranscript,
  VoiceProvider,
} from "@/lib/providers/voice/types";
import { ProviderError } from "@/lib/providers/voice/types";

/**
 * Sarvam AI voice agent provider (PRD 10.4).
 *
 * Chosen for the reason PRD 17.3 gives: provider selection here is a
 * compliance decision, not a technology preference. Sarvam is India-based,
 * runs Indian-language speech models, and its telephony connections are Indian
 * carriers (Exotel, Smartflo, Vobiz and others) - which sidesteps the
 * constraint that makes a global provider awkward for Indian outbound, where
 * calls to Indian non-Twilio numbers can only originate from non-Indian
 * numbers [PRD Ref. 7].
 *
 * That is a *fit* argument, not a compliance clearance. The agency still needs
 * its own sender/telemarketer registration and consent evidence before dialling
 * (PRD 17.3), which is what the compliance gate exists to enforce.
 *
 * API surface used:
 *   POST /api/outbounds/v1/orgs/{org}/workspaces/{ws}/outbounds   -> attempt_id
 *   GET  /api/analytics/v1/{org}/{ws}/{app}/attempts              -> status
 *   GET  /api/analytics/v1/{org}/{ws}/{app}/transcripts/{id}      -> transcript
 *   webhook -> { attempt_id, status, duration, interaction_transcript, ... }
 */

const OUTBOUND_BASE = "https://apps.sarvam.ai/api/outbounds";
const ANALYTICS_BASE = "https://apps.sarvam.ai/api/analytics";

export interface SarvamConfig {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  /** The configured voice agent ("app") that will run the conversation. */
  appId: string;
  appVersion: number;
  /** Telephony connection and the number calls originate from. */
  connectionId: string;
  agentPhoneNumber: string;
  /**
   * Our own secret, not Sarvam's. See `handleWebhook` - Sarvam does not sign
   * its callbacks, so we carry a keyed token through `webhook_config.metadata`
   * and verify it on the way back.
   */
  webhookSecret: string;
}

/**
 * Sarvam's connectivity statuses, mapped onto the platform's taxonomy.
 * "connected" is the only one that produces a conversation to qualify.
 */
const STATUS_MAP: Record<string, ProviderCallStatus> = {
  connected: "completed",
  no_answer: "no_answer",
  busy: "busy",
  failed: "failed",
  // Seen on the analytics endpoint rather than the webhook.
  completed: "completed",
  cancelled: "canceled",
  canceled: "canceled",
};

/**
 * Failure reasons that mean "never call this number again", not "try later".
 *
 * Sarvam surfaces the carrier's message verbatim, e.g.
 *   "exotel: Phone number is registered under TRAI NDNC"
 *
 * India's National Do Not Call registry is a legal suppression, not a
 * transient error. Retrying it is both futile and a regulatory problem, so
 * these are matched explicitly and turned into a permanent suppression rather
 * than being left to the retry ladder.
 */
const PERMANENT_SUPPRESSION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bNDNC\b/i, reason: "trai_ndnc_registered" },
  { pattern: /\bDND\b/i, reason: "dnd_registered" },
  { pattern: /do\s*not\s*(call|disturb)\s*(registry|list)/i, reason: "dnc_registry" },
  { pattern: /number\s+(is\s+)?blacklist/i, reason: "carrier_blacklist" },
];

/** Carrier conditions that are permanent but not a suppression - a dead number. */
const PERMANENT_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+(destination|number)/i,
  /number\s+(does\s+not\s+exist|not\s+in\s+service|unallocated)/i,
  /unallocated\s+number/i,
];

export class SarvamVoiceProvider implements VoiceProvider {
  constructor(
    private readonly config: SarvamConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  metadata(): ProviderMetadata {
    return {
      name: "sarvam",
      supportsRecording: true,
      supportsTranscript: true,
      // Declared, not assumed: the calling worker treats an empty list as
      // "unrestricted, confirm with counsel".
      supportedRegions: ["IN"],
    };
  }

  async createCall(request: CreateCallRequest): Promise<CreateCallResult> {
    // Sarvam has no webhook signature, so bind a token to this call and send
    // it through metadata, which the callback echoes back verbatim.
    const token = webhookToken(request.callId, this.config.webhookSecret);

    const body = {
      app_config: {
        app_id: this.config.appId,
        app_version: this.config.appVersion,
        connection_config: {
          connection_id: this.config.connectionId,
          agent_phone_number: this.config.agentPhoneNumber,
        },
        // The campaign's questions reach the agent as variables, so one
        // configured Sarvam app serves every campaign - the same reason the
        // rest of this platform keeps client behaviour in configuration.
        agent_variables: {
          client_name: request.script.clientName,
          business_context: request.script.businessContext,
          questions: request.script.questions.map((q) => q.question).join("\n"),
          required_fields: request.script.questions
            .filter((q) => q.required)
            .map((q) => q.fieldName)
            .join(","),
        },
        ...(request.script.opening
          ? { app_overrides: { initial_bot_message: request.script.opening } }
          : {}),
      },
      user_config: { user_phone_number: request.to },
      webhook_config: {
        url: request.webhookUrl,
        metadata: {
          call_id: request.callId,
          token,
          ...(request.correlationId ? { correlation_id: request.correlationId } : {}),
        },
      },
    };

    const response = await this.post(
      `${OUTBOUND_BASE}/v1/orgs/${enc(this.config.orgId)}/workspaces/${enc(this.config.workspaceId)}/outbounds`,
      body,
    );

    const parsed = response as { attempt_id?: string };
    if (!parsed.attempt_id) {
      throw new ProviderError("Sarvam did not return an attempt_id", true, "no_attempt_id");
    }

    return { providerCallId: parsed.attempt_id, status: "initiated" };
  }

  /**
   * Sarvam exposes attempts as a time-windowed list rather than a get-by-id,
   * so this queries a window around now and filters. Only a fallback - the
   * webhook is the primary path, and this exists for reconciling a call whose
   * callback never arrived.
   */
  async getCallStatus(providerCallId: string): Promise<ProviderCallState> {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);

    const url =
      `${ANALYTICS_BASE}/v1/${enc(this.config.orgId)}/${enc(this.config.workspaceId)}/` +
      `${enc(this.config.appId)}/attempts` +
      `?start_datetime=${encodeURIComponent(start.toISOString())}` +
      `&end_datetime=${encodeURIComponent(end.toISOString())}` +
      `&limit=100`;

    const body = (await this.get(url)) as {
      items?: Array<{
        attempt_id: string;
        connectivity_status?: string;
        failure_reason?: string | null;
        duration_in_seconds?: number | null;
        start_datetime?: string;
        end_datetime?: string;
      }>;
    };

    const attempt = body.items?.find((item) => item.attempt_id === providerCallId);
    if (!attempt) {
      throw new ProviderError(
        `Attempt ${providerCallId} not found in the last 24 hours`,
        false,
        "not_found",
      );
    }

    return {
      providerCallId,
      status: STATUS_MAP[attempt.connectivity_status ?? ""] ?? "failed",
      durationSec: attempt.duration_in_seconds ?? undefined,
      startedAt: attempt.start_datetime,
      endedAt: attempt.end_datetime,
      failureReason: attempt.failure_reason ?? undefined,
    };
  }

  /**
   * Verify and normalise a Sarvam callback.
   *
   * Sarvam sends no signature header, so the usual HMAC-over-the-body check is
   * not available. Instead `createCall` puts a keyed token in
   * `webhook_config.metadata`, which Sarvam echoes back untouched; this
   * recomputes it from the call id and compares in constant time.
   *
   * That is weaker than a body signature - it authenticates the *call*, not
   * the payload, so a caller who has seen one legitimate callback could replay
   * it. Two things bound the damage: `recordCallResult` is idempotent on
   * (provider, provider_call_id) and ignores a second terminal event
   * (PRD 18.1), and the endpoint still requires a bearer service token. Treat
   * this as defence in depth, and put the callback URL behind a network
   * allowlist in production if the provider offers source IPs.
   */
  handleWebhook(
    rawBody: string,
    _headers: Record<string, string>,
    _requestUrl?: string,
  ): NormalizedWebhook {
    let payload: SarvamWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as SarvamWebhookPayload;
    } catch {
      throw new ProviderError("Sarvam webhook body is not JSON", false, "bad_body");
    }

    if (!payload.attempt_id) {
      throw new ProviderError("Sarvam webhook has no attempt_id", false, "bad_payload");
    }

    const metadata = payload.webhook_config?.metadata;
    const callId = metadata?.call_id;
    const token = metadata?.token;

    if (!callId || !token) {
      throw new ProviderError(
        "Sarvam webhook is missing the call_id/token metadata this platform sets",
        false,
        "bad_signature",
      );
    }

    const expected = webhookToken(callId, this.config.webhookSecret);
    const given = Buffer.from(token);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new ProviderError("Sarvam webhook token does not verify", false, "bad_signature");
    }

    const status = STATUS_MAP[payload.status] ?? "failed";
    const failureReason = payload.failure_reason ?? undefined;

    return {
      providerCallId: payload.attempt_id,
      status,
      durationSec: payload.duration ?? undefined,
      failureReason,
      transcript: transcriptFrom(payload),
      ...suppressionFrom(failureReason),
    };
  }

  async retrieveTranscript(providerCallId: string): Promise<ProviderTranscript | null> {
    // The transcript arrives on the webhook for a connected call. This path is
    // for reconciliation, and needs the interaction id rather than the attempt
    // id, so resolve it first.
    const state = await this.getCallStatus(providerCallId);
    if (state.status !== "completed") return null;

    const interactionId = await this.interactionIdFor(providerCallId);
    if (!interactionId) return null;

    const body = (await this.get(
      `${ANALYTICS_BASE}/v1/${enc(this.config.orgId)}/${enc(this.config.workspaceId)}/` +
        `${enc(this.config.appId)}/transcripts/${enc(interactionId)}`,
    )) as { transcript?: TranscriptTurn[]; interaction_transcript?: TranscriptTurn[] };

    const turns = body.interaction_transcript ?? body.transcript;
    if (!turns || turns.length === 0) return null;

    return { text: renderTurns(turns), language: "en-IN" };
  }

  /**
   * Sarvam's documented outbound surface has no cancel endpoint, so this
   * cannot end a call in progress.
   *
   * Failing loudly rather than returning quietly: a silent no-op here would
   * let a caller believe a call was terminated when it was not, and the one
   * place this gets used is stopping a call after a do-not-call request.
   */
  async hangup(providerCallId: string): Promise<void> {
    throw new ProviderError(
      `Sarvam exposes no hangup endpoint; call ${providerCallId} will run to completion. ` +
        `Suppression still applies to future attempts.`,
      false,
      "hangup_unsupported",
    );
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async post(url: string, body: unknown): Promise<unknown> {
    return this.request(url, { method: "POST", body: JSON.stringify(body) });
  }

  private async get(url: string): Promise<unknown> {
    return this.request(url, { method: "GET" });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          "x-api-key": this.config.apiKey,
          "content-type": "application/json",
        },
      });
    } catch (err) {
      throw new ProviderError(
        `Sarvam request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        "network",
      );
    }

    if (response.ok) {
      return response.status === 204 ? null : await response.json().catch(() => null);
    }

    const detail = (await response.text().catch(() => "")).slice(0, 300);

    // Same failure classes as the integrations (PRD 18.2): auth is permanent,
    // 429 and 5xx are worth retrying.
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`Sarvam auth failure: ${detail}`, false, "auth");
    }
    if (response.status === 404) {
      throw new ProviderError(`Sarvam resource not found: ${detail}`, false, "not_found");
    }
    if (response.status === 422 || response.status === 400) {
      throw new ProviderError(`Sarvam rejected the request: ${detail}`, false, "bad_request");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError(`Sarvam transient error ${response.status}: ${detail}`, true, "transient");
    }

    throw new ProviderError(`Sarvam error ${response.status}: ${detail}`, false, "unknown");
  }

  private async interactionIdFor(providerCallId: string): Promise<string | null> {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);

    const body = (await this.get(
      `${ANALYTICS_BASE}/v1/${enc(this.config.orgId)}/${enc(this.config.workspaceId)}/` +
        `${enc(this.config.appId)}/attempts` +
        `?start_datetime=${encodeURIComponent(start.toISOString())}` +
        `&end_datetime=${encodeURIComponent(end.toISOString())}&limit=100`,
    )) as { items?: Array<{ attempt_id: string; interaction_id?: string | null }> };

    return body.items?.find((i) => i.attempt_id === providerCallId)?.interaction_id ?? null;
  }
}

// ── Payload shapes ──────────────────────────────────────────────────────────

interface TranscriptTurn {
  role?: string;
  en_text?: string;
  text?: string;
}

interface SarvamWebhookPayload {
  attempt_id: string;
  status: string;
  duration?: number | null;
  interaction_id?: string | null;
  failure_reason?: string | null;
  final_agent_variables?: Record<string, unknown> | null;
  interaction_transcript?: TranscriptTurn[] | null;
  channel_info?: {
    channel_type?: string;
    channel_provider?: string;
    agent_phone_number?: string;
  };
  webhook_config?: {
    url?: string;
    metadata?: { call_id?: string; token?: string; correlation_id?: string };
  } | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Keyed token bound to one call, carried through Sarvam's echoed metadata. */
export function webhookToken(callId: string, secret: string): string {
  return createHmac("sha256", secret).update(callId).digest("hex");
}

function transcriptFrom(payload: SarvamWebhookPayload): ProviderTranscript | undefined {
  const turns = payload.interaction_transcript;
  if (!turns || turns.length === 0) return undefined;

  return { text: renderTurns(turns), language: "en-IN" };
}

/**
 * Render Sarvam's turn list into the plain speaker-labelled transcript the
 * qualification prompt expects. `en_text` is Sarvam's English rendering, which
 * is what the analysis reads regardless of the language actually spoken.
 */
function renderTurns(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => {
      const text = (turn.en_text ?? turn.text ?? "").trim();
      if (!text) return null;
      const speaker = turn.role === "assistant" || turn.role === "agent" ? "Agent" : "Lead";
      return `${speaker}: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Classify a carrier failure reason.
 *
 * A number on India's NDNC registry is a legal suppression, not a transient
 * error - retrying it is futile and a regulatory problem. A dead number is
 * permanent but not a suppression. Everything else falls through to the normal
 * retry ladder.
 */
export function suppressionFrom(
  failureReason: string | undefined,
): { suppress?: { reason: string; permanent: true } } {
  if (!failureReason) return {};

  for (const { pattern, reason } of PERMANENT_SUPPRESSION_PATTERNS) {
    if (pattern.test(failureReason)) {
      return { suppress: { reason, permanent: true } };
    }
  }

  for (const pattern of PERMANENT_FAILURE_PATTERNS) {
    if (pattern.test(failureReason)) {
      return { suppress: { reason: "invalid_number", permanent: true } };
    }
  }

  return {};
}

/** Build from environment, for the single-account case. Returns null if unset. */
export function sarvamConfigFromEnv(): SarvamConfig | null {
  const required = {
    apiKey: process.env.SARVAM_API_KEY,
    orgId: process.env.SARVAM_ORG_ID,
    workspaceId: process.env.SARVAM_WORKSPACE_ID,
    appId: process.env.SARVAM_APP_ID,
    connectionId: process.env.SARVAM_CONNECTION_ID,
    agentPhoneNumber: process.env.SARVAM_AGENT_PHONE_NUMBER,
  };

  if (Object.values(required).some((v) => !v)) return null;

  return {
    apiKey: required.apiKey!,
    orgId: required.orgId!,
    workspaceId: required.workspaceId!,
    appId: required.appId!,
    appVersion: Number(process.env.SARVAM_APP_VERSION ?? 1),
    connectionId: required.connectionId!,
    agentPhoneNumber: required.agentPhoneNumber!,
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret",
  };
}

/**
 * Voice provider abstraction (PRD 10.4).
 *
 * "Implement a provider adapter so the core platform is not coupled to a
 * single telecom or AI vendor. Provider contract should expose: create_call,
 * get_call_status, handle_webhook, retrieve_recording_or_transcript, hangup,
 * and provider_metadata."
 *
 * This matters commercially, not just architecturally: PRD 17.3 notes that
 * India outbound restrictions make provider selection a compliance decision.
 * A regional provider has to be swappable without touching the calling worker.
 */

export interface CreateCallRequest {
  to: string;
  callId: string;
  tenantId: string;
  campaignId: string;
  /** Opening line and qualification questions for this campaign. */
  script: {
    opening: string;
    questions: Array<{ fieldName: string; question: string; required: boolean }>;
    businessContext: string;
    clientName: string;
  };
  /** Where the provider should post status and result callbacks. */
  webhookUrl: string;
  correlationId: string | null;
}

export interface CreateCallResult {
  providerCallId: string;
  status: ProviderCallStatus;
}

export type ProviderCallStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled";

export interface ProviderCallState {
  providerCallId: string;
  status: ProviderCallStatus;
  durationSec?: number;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
}

export interface ProviderTranscript {
  text: string;
  language?: string;
  recordingRef?: string;
}

/** Normalised webhook payload, so the platform never parses vendor JSON directly. */
export interface NormalizedWebhook {
  providerCallId: string;
  status: ProviderCallStatus;
  durationSec?: number;
  failureReason?: string;
  transcript?: ProviderTranscript;
}

export interface ProviderMetadata {
  name: string;
  supportsRecording: boolean;
  supportsTranscript: boolean;
  /**
   * Regions this provider may legally originate commercial calls to, as
   * configured. Empty means "unrestricted - confirm with counsel", which the
   * calling worker treats as a reason to require explicit compliance approval.
   */
  supportedRegions: string[];
}

export interface VoiceProvider {
  metadata(): ProviderMetadata;
  createCall(request: CreateCallRequest): Promise<CreateCallResult>;
  getCallStatus(providerCallId: string): Promise<ProviderCallState>;
  /** Verify the signature and normalise the vendor's payload shape. */
  handleWebhook(rawBody: string, headers: Record<string, string>): NormalizedWebhook;
  retrieveTranscript(providerCallId: string): Promise<ProviderTranscript | null>;
  hangup(providerCallId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

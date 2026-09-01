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
  /**
   * The carrier reported a condition that must stop all future attempts, not
   * just this one - a number on India's NDNC/DND registry, or one that does
   * not exist.
   *
   * This is distinct from a failed call. The retry ladder would otherwise
   * treat "registered under TRAI NDNC" as a transient failure and dial again,
   * which is both futile and a regulatory problem (PRD 17.4, 17.3). An adapter
   * sets this when it recognises such a reason; the platform turns it into a
   * permanent suppression.
   */
  suppress?: { reason: string; permanent: true };
}

export interface ProviderMetadata {
  name: string;
  supportsRecording: boolean;
  supportsTranscript: boolean;
  /**
   * The provider cryptographically signs its callbacks, so `handleWebhook`
   * authenticates the request on its own.
   *
   * A carrier posting a status callback cannot attach a bearer service token,
   * so for these the signature *is* the credential and the tenant is resolved
   * from the call record. Providers that do not sign must be called with a
   * service token as well, and default to false.
   */
  verifiesWebhookSignature?: boolean;
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
  /**
   * Verify the signature and normalise the vendor's payload shape.
   *
   * `requestUrl` is the full URL the callback was delivered to, including the
   * query string. Twilio signs the URL together with the parameters, so a
   * signature cannot be checked without it - and reconstructing it from Host
   * and path is exactly the kind of guess that produces a check which passes
   * on malformed input.
   */
  handleWebhook(
    rawBody: string,
    headers: Record<string, string>,
    requestUrl: string,
  ): NormalizedWebhook;
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

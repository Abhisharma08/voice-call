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
 * Twilio voice provider — telephony for local testing.
 *
 * Twilio is a carrier, not a voice-AI vendor: it dials, plays audio and reports
 * status. The conversation itself is TwiML this platform serves, using
 * `<Say>` for each question and `<Gather input="speech">` to capture the
 * answer. That is enough to produce a genuine transcript from a real call, so
 * intake -> queue -> call -> qualification -> review -> sync can all be
 * exercised against a phone that actually rings.
 *
 * It is not a production voice agent. There is no barge-in, no interruption
 * handling, and no conversational recovery: it reads a question, waits, and
 * moves on. Production wants Sarvam (India-native, its own carriers) or
 * ElevenLabs Agents — and ElevenLabs still needs a Twilio number underneath,
 * so this account carries forward either way.
 *
 * One caveat: Twilio's India guidance restricts outbound calls
 * to Indian non-Twilio numbers to non-Indian originating numbers [Ref. 7].
 * That constraint applies to any stack where Twilio is the carrier, ElevenLabs
 * included.
 */

const API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The Twilio number, or a verified caller ID, calls originate from. */
  fromNumber: string;
  /** Public base URL Twilio can reach. Callbacks are built from it. */
  publicUrl: string;
  /** Keys the token that binds a TwiML request to one call. */
  webhookSecret: string;
}

/** Twilio's call statuses, mapped onto the platform taxonomy. */
const STATUS_MAP: Record<string, ProviderCallStatus> = {
  queued: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "answered",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

export class TwilioVoiceProvider implements VoiceProvider {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  metadata(): ProviderMetadata {
    return {
      name: "twilio",
      supportsRecording: true,
      // Via <Gather input="speech">, not a vendor transcription product.
      supportsTranscript: true,
      // Twilio signs with X-Twilio-Signature, so its callbacks authenticate
      // themselves - which they must, since a carrier cannot attach a bearer
      // token to a status callback.
      verifiesWebhookSignature: true,
      // Deliberately empty: Twilio reaches most of the world, but the India
      // origination rule means "can it dial" and "may we dial" differ here.
      // An empty list makes the calling worker treat this as needing explicit
      // compliance approval, which is the correct posture.
      supportedRegions: [],
    };
  }

  async createCall(request: CreateCallRequest): Promise<CreateCallResult> {
    const token = twimlToken(request.callId, this.config.webhookSecret);

    // Twilio fetches this for the conversation, and posts status separately.
    const twimlUrl =
      `${this.config.publicUrl}/api/webhooks/voice/twilio/twiml` +
      `?callId=${encodeURIComponent(request.callId)}&token=${token}&turn=0`;

    const params = new URLSearchParams({
      To: request.to,
      From: this.config.fromNumber,
      Url: twimlUrl,
      Method: "POST",
      StatusCallback: `${this.config.publicUrl}/api/webhooks/voice/twilio`,
      StatusCallbackMethod: "POST",
      // A trial call that nobody answers should stop ringing rather than
      // burning the full default timeout.
      Timeout: "30",
      Record: "false",
    });

    // StatusCallbackEvent repeats, so it cannot go in the object literal above.
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      params.append("StatusCallbackEvent", event);
    }

    const body = (await this.request(
      `/Accounts/${encodeURIComponent(this.config.accountSid)}/Calls.json`,
      params,
    )) as { sid?: string; status?: string };

    if (!body.sid) {
      throw new ProviderError("Twilio did not return a call SID", true, "no_sid");
    }

    return {
      providerCallId: body.sid,
      status: STATUS_MAP[body.status ?? "queued"] ?? "initiated",
    };
  }

  async getCallStatus(providerCallId: string): Promise<ProviderCallState> {
    const body = (await this.request(
      `/Accounts/${encodeURIComponent(this.config.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`,
      null,
    )) as {
      sid: string;
      status: string;
      duration?: string | null;
      start_time?: string | null;
      end_time?: string | null;
    };

    return {
      providerCallId: body.sid,
      status: STATUS_MAP[body.status] ?? "failed",
      durationSec: body.duration ? Number(body.duration) : undefined,
      startedAt: body.start_time ?? undefined,
      endedAt: body.end_time ?? undefined,
    };
  }

  /**
   * Verify `X-Twilio-Signature` and normalise the status callback.
   *
   * Unlike Sarvam, Twilio really does sign: HMAC-SHA1 over the full request
   * URL concatenated with every POST parameter, sorted by name, keys and
   * values joined with no delimiter, base64 encoded. The URL is part of the
   * signed material, which is why the interface passes it in rather than the
   * adapter guessing it from Host.
   */
  handleWebhook(
    rawBody: string,
    headers: Record<string, string>,
    requestUrl: string,
  ): NormalizedWebhook {
    const signature = headers["x-twilio-signature"] ?? "";
    if (!signature) {
      throw new ProviderError("Missing X-Twilio-Signature", false, "bad_signature");
    }

    const params = new URLSearchParams(rawBody);
    const expected = twilioSignature(this.config.authToken, requestUrl, params);

    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new ProviderError("Twilio signature does not verify", false, "bad_signature");
    }

    const callSid = params.get("CallSid");
    if (!callSid) {
      throw new ProviderError("Twilio callback has no CallSid", false, "bad_payload");
    }

    const status = STATUS_MAP[params.get("CallStatus") ?? ""] ?? "failed";
    const duration = params.get("CallDuration");

    return {
      providerCallId: callSid,
      status,
      durationSec: duration ? Number(duration) : undefined,
      failureReason: params.get("ErrorMessage") ?? undefined,
      // The transcript is assembled turn by turn by the TwiML endpoint and is
      // already in the database by the time this fires, so nothing is attached
      // here. recordCallResult looks for a stored transcript as well.
    };
  }

  /** The conversation is captured live by the TwiML endpoint, not fetched after. */
  async retrieveTranscript(_providerCallId: string): Promise<ProviderTranscript | null> {
    return null;
  }

  async hangup(providerCallId: string): Promise<void> {
    await this.request(
      `/Accounts/${encodeURIComponent(this.config.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`,
      new URLSearchParams({ Status: "completed" }),
    );
  }

  private async request(path: string, params: URLSearchParams | null): Promise<unknown> {
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: params ? "POST" : "GET",
        headers: {
          authorization: `Basic ${auth}`,
          ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(params ? { body: params.toString() } : {}),
      });
    } catch (err) {
      throw new ProviderError(
        `Twilio request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        "network",
      );
    }

    if (response.ok) return await response.json().catch(() => null);

    const detail = (await response.text().catch(() => "")).slice(0, 400);

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`Twilio auth failure: ${detail}`, false, "auth");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError(`Twilio transient error ${response.status}: ${detail}`, true, "transient");
    }

    // Trial accounts reject an unverified destination with code 21219, which is
    // a configuration problem rather than something to retry - and the most
    // likely first failure when testing.
    if (detail.includes("21219") || /unverified/i.test(detail)) {
      throw new ProviderError(
        `Twilio trial account: the destination number is not verified. ` +
          `Verify it in the Twilio console, and add it to the campaign's dial allowlist. (${detail})`,
        false,
        "unverified_number",
      );
    }

    throw new ProviderError(`Twilio error ${response.status}: ${detail}`, false, "bad_request");
  }
}

/**
 * Twilio's signature: HMAC-SHA1 of the full URL plus each POST parameter,
 * sorted by name, key and value concatenated with no separator.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
): string {
  const sorted = [...params.keys()].sort();
  let data = url;
  for (const key of sorted) {
    data += key + (params.get(key) ?? "");
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

/** Binds a TwiML request to one call, so the endpoint cannot be driven arbitrarily. */
export function twimlToken(callId: string, secret: string): string {
  return createHmac("sha256", secret).update(`twiml:${callId}`).digest("hex");
}

export function twilioConfigFromEnv(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) return null;

  return {
    accountSid,
    authToken,
    fromNumber,
    publicUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET ?? "dev-webhook-secret",
  };
}

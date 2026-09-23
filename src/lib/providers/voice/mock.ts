import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CreateCallRequest,
  CreateCallResult,
  NormalizedWebhook,
  ProviderCallState,
  ProviderMetadata,
  ProviderTranscript,
  VoiceProvider,
} from "@/lib/providers/voice/types";
import { ProviderError } from "@/lib/providers/voice/types";

/**
 * In-process voice provider for local development, CI, and the sandbox test
 * call in the onboarding wizard.
 *
 * It places no calls. It exists so the whole vertical slice - queue, call
 * record, webhook, transcript, qualification, CRM sync - can be exercised
 * end-to-end without a telecom account, and so the real adapter has a
 * reference for the contract it must satisfy.
 *
 * Outcomes are deterministic from the callId, so a test that expects a
 * no-answer gets one every run.
 */

interface MockCall {
  providerCallId: string;
  to: string;
  status: ProviderCallState["status"];
  createdAt: number;
  transcript: ProviderTranscript | null;
  durationSec: number;
}

const calls = new Map<string, MockCall>();

/** Scripted conversations the mock can return, selected by lead phone suffix. */
const SCENARIOS = {
  hot: {
    durationSec: 154,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a 2BHK in Noida?",
      "Lead: Yes, that's me.",
      "Agent: Are you still actively looking?",
      "Lead: Yes, I'm actively looking. I want to close within the next two months.",
      "Agent: Do you have a budget range in mind?",
      "Lead: Around 50 to 75 lakh.",
      "Agent: Would you like one of our advisors to call you?",
      "Lead: Yes please, that would be helpful.",
    ].join("\n"),
  },
  not_interested: {
    durationSec: 22,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a property in Noida?",
      "Lead: I already bought something else. Not interested.",
      "Agent: Understood, thank you for your time.",
    ].join("\n"),
  },
  do_not_call: {
    durationSec: 14,
    text: [
      "Agent: Hello, am I speaking with the person who enquired about a property in Noida?",
      "Lead: Do not call me again. Remove my number.",
      "Agent: I will remove your number right away. Apologies for the disturbance.",
    ].join("\n"),
  },
  callback: {
    durationSec: 31,
    text: [
      "Agent: Hello, is now a good time to talk about your property enquiry?",
      "Lead: I'm driving. Can you call me tomorrow at 11am?",
      "Agent: Of course, I will arrange a call for tomorrow at 11am.",
    ].join("\n"),
  },
} as const;

export type MockScenario = keyof typeof SCENARIOS | "no_answer" | "busy" | "provider_failure";

/**
 * The last digit of the dialled number selects the scenario, so a seeded lead
 * can deterministically produce a hot result or a DNC without any test wiring.
 */
function scenarioFor(to: string): MockScenario {
  switch (to.slice(-1)) {
    case "1":
      return "no_answer";
    case "2":
      return "busy";
    case "3":
      return "not_interested";
    case "4":
      return "do_not_call";
    case "5":
      return "callback";
    case "9":
      return "provider_failure";
    default:
      return "hot";
  }
}

export class MockVoiceProvider implements VoiceProvider {
  constructor(private readonly webhookSecret: string) {}

  metadata(): ProviderMetadata {
    return {
      name: "mock",
      supportsRecording: false,
      supportsTranscript: true,
      supportedRegions: [],
    };
  }

  async createCall(request: CreateCallRequest): Promise<CreateCallResult> {
    const scenario = scenarioFor(request.to);

    if (scenario === "provider_failure") {
      // Provider busy or rate limited: queue it for later.
      throw new ProviderError("Mock provider transient failure", true, "mock_transient");
    }

    const providerCallId = `mock_${randomUUID()}`;
    const outcome =
      scenario === "no_answer" ? "no_answer" : scenario === "busy" ? "busy" : "completed";

    calls.set(providerCallId, {
      providerCallId,
      to: request.to,
      status: outcome,
      createdAt: Date.now(),
      durationSec: outcome === "completed" ? SCENARIOS[scenario as keyof typeof SCENARIOS].durationSec : 0,
      transcript:
        outcome === "completed"
          ? { text: SCENARIOS[scenario as keyof typeof SCENARIOS].text, language: "en-IN" }
          : null,
    });

    return { providerCallId, status: "initiated" };
  }

  async getCallStatus(providerCallId: string): Promise<ProviderCallState> {
    const call = calls.get(providerCallId);
    if (!call) throw new ProviderError(`Unknown call ${providerCallId}`, false, "not_found");

    return {
      providerCallId,
      status: call.status,
      durationSec: call.durationSec,
      startedAt: new Date(call.createdAt).toISOString(),
      endedAt: new Date(call.createdAt + call.durationSec * 1000).toISOString(),
    };
  }

  handleWebhook(rawBody: string, headers: Record<string, string>, _requestUrl?: string): NormalizedWebhook {
    // "Webhook signature invalid - No - Reject + security log."
    const signature = headers["x-mock-signature"] ?? "";
    const expected = signWebhook(rawBody, this.webhookSecret);

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ProviderError("Invalid webhook signature", false, "bad_signature");
    }

    const parsed = JSON.parse(rawBody) as {
      provider_call_id: string;
      status: NormalizedWebhook["status"];
      duration_sec?: number;
      failure_reason?: string;
      transcript?: { text: string; language?: string };
    };

    return {
      providerCallId: parsed.provider_call_id,
      status: parsed.status,
      durationSec: parsed.duration_sec,
      failureReason: parsed.failure_reason,
      transcript: parsed.transcript,
    };
  }

  async retrieveTranscript(providerCallId: string): Promise<ProviderTranscript | null> {
    return calls.get(providerCallId)?.transcript ?? null;
  }

  async hangup(providerCallId: string): Promise<void> {
    const call = calls.get(providerCallId);
    if (call) call.status = "canceled";
  }

  /** Test helper: the callback the real provider would post back. */
  buildWebhookPayload(providerCallId: string): string {
    const call = calls.get(providerCallId);
    if (!call) throw new ProviderError(`Unknown call ${providerCallId}`, false, "not_found");

    return JSON.stringify({
      provider_call_id: providerCallId,
      status: call.status,
      duration_sec: call.durationSec,
      transcript: call.transcript ? { text: call.transcript.text, language: call.transcript.language } : undefined,
    });
  }
}

export function signWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Test-only: forget every mock call between test files. */
export function resetMockProvider(): void {
  calls.clear();
}

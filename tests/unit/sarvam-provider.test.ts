import { describe, expect, it, vi } from "vitest";
import {
  SarvamVoiceProvider,
  suppressionFrom,
  webhookToken,
  type SarvamConfig,
} from "@/lib/providers/voice/sarvam";
import { ProviderError } from "@/lib/providers/voice/types";

const config: SarvamConfig = {
  apiKey: "test-key",
  orgId: "org_1",
  workspaceId: "ws_1",
  appId: "app_1",
  appVersion: 3,
  connectionId: "conn_1",
  agentPhoneNumber: "+911140000000",
  webhookSecret: "test-webhook-secret",
};

const CALL_ID = "11111111-2222-4333-8444-555555555555";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const callRequest = {
  to: "+919876543210",
  callId: CALL_ID,
  tenantId: "t1",
  campaignId: "c1",
  script: {
    opening: "Hello, calling about your enquiry.",
    questions: [
      { fieldName: "still_interested", question: "Still looking?", required: true },
      { fieldName: "budget", question: "Budget range?", required: false },
    ],
    businessContext: "Residential property in Noida.",
    clientName: "Acme Real Estate",
  },
  webhookUrl: "https://platform.example.com/api/webhooks/voice/sarvam",
  correlationId: "corr-1",
};

describe("createCall", () => {
  it("posts to the outbound endpoint with the org and workspace in the path", async () => {
    const { impl, calls } = stubFetch(() => json({ attempt_id: "att_123" }));
    const provider = new SarvamVoiceProvider(config, impl);

    const result = await provider.createCall(callRequest);

    expect(result).toEqual({ providerCallId: "att_123", status: "initiated" });
    expect(calls[0]!.url).toBe(
      "https://apps.sarvam.ai/api/outbounds/v1/orgs/org_1/workspaces/ws_1/outbounds",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("authenticates with x-api-key, not a bearer token", async () => {
    const { impl, calls } = stubFetch(() => json({ attempt_id: "att_123" }));
    await new SarvamVoiceProvider(config, impl).createCall(callRequest);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers.authorization).toBeUndefined();
  });

  it("sends the campaign script and questions as agent variables", async () => {
    const { impl, calls } = stubFetch(() => json({ attempt_id: "att_123" }));
    await new SarvamVoiceProvider(config, impl).createCall(callRequest);

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      app_config: {
        app_id: string;
        app_version: number;
        agent_variables: Record<string, string>;
        app_overrides?: { initial_bot_message?: string };
        connection_config: { connection_id: string; agent_phone_number: string };
      };
      user_config: { user_phone_number: string };
    };

    expect(body.app_config.app_id).toBe("app_1");
    expect(body.app_config.app_version).toBe(3);
    expect(body.app_config.connection_config).toEqual({
      connection_id: "conn_1",
      agent_phone_number: "+911140000000",
    });
    expect(body.user_config.user_phone_number).toBe("+919876543210");

    // One configured Sarvam agent serves every campaign; the difference
    // travels as variables.
    expect(body.app_config.agent_variables.client_name).toBe("Acme Real Estate");
    expect(body.app_config.agent_variables.required_fields).toBe("still_interested");
    expect(body.app_config.app_overrides?.initial_bot_message).toBe(
      "Hello, calling about your enquiry.",
    );
  });

  it("carries a keyed token in webhook metadata, since Sarvam does not sign callbacks", async () => {
    const { impl, calls } = stubFetch(() => json({ attempt_id: "att_123" }));
    await new SarvamVoiceProvider(config, impl).createCall(callRequest);

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      webhook_config: { url: string; metadata: { call_id: string; token: string } };
    };

    expect(body.webhook_config.url).toBe(callRequest.webhookUrl);
    expect(body.webhook_config.metadata.call_id).toBe(CALL_ID);
    expect(body.webhook_config.metadata.token).toBe(
      webhookToken(CALL_ID, config.webhookSecret),
    );
  });

  it("treats a 401 as permanent and a 503 as retryable", async () => {
    const unauthorized = new SarvamVoiceProvider(
      config,
      stubFetch(() => json({ detail: "bad key" }, 401)).impl,
    );
    await expect(unauthorized.createCall(callRequest)).rejects.toMatchObject({
      retryable: false,
      providerCode: "auth",
    });

    const unavailable = new SarvamVoiceProvider(
      config,
      stubFetch(() => json({ detail: "upstream" }, 503)).impl,
    );
    await expect(unavailable.createCall(callRequest)).rejects.toMatchObject({ retryable: true });
  });

  it("fails retryably when no attempt_id comes back", async () => {
    const provider = new SarvamVoiceProvider(config, stubFetch(() => json({})).impl);
    await expect(provider.createCall(callRequest)).rejects.toMatchObject({ retryable: true });
  });
});

describe("handleWebhook", () => {
  const provider = new SarvamVoiceProvider(config);

  function payload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      attempt_id: "att_123",
      status: "connected",
      duration: 154,
      interaction_id: "int_9",
      channel_info: { channel_type: "phone", channel_provider: "exotel" },
      interaction_transcript: [
        { role: "assistant", en_text: "Are you still looking?" },
        { role: "user", en_text: "Yes, within two months." },
      ],
      webhook_config: {
        url: callRequest.webhookUrl,
        metadata: { call_id: CALL_ID, token: webhookToken(CALL_ID, config.webhookSecret) },
      },
      ...overrides,
    });
  }

  it("accepts a callback carrying the token we set", () => {
    const result = provider.handleWebhook(payload(), {});
    expect(result.providerCallId).toBe("att_123");
    expect(result.status).toBe("completed");
    expect(result.durationSec).toBe(154);
  });

  it("renders the transcript with speaker labels", () => {
    const result = provider.handleWebhook(payload(), {});
    expect(result.transcript?.text).toBe(
      "Agent: Are you still looking?\nLead: Yes, within two months.",
    );
  });

  it("rejects a forged token", () => {
    const forged = payload({
      webhook_config: { metadata: { call_id: CALL_ID, token: "0".repeat(64) } },
    });
    expect(() => provider.handleWebhook(forged, {})).toThrow(ProviderError);
    expect(() => provider.handleWebhook(forged, {})).toThrow(/does not verify/);
  });

  it("rejects a token minted for a different call", () => {
    const otherCall = "99999999-2222-4333-8444-555555555555";
    const swapped = payload({
      webhook_config: {
        metadata: { call_id: CALL_ID, token: webhookToken(otherCall, config.webhookSecret) },
      },
    });
    expect(() => provider.handleWebhook(swapped, {})).toThrow(/does not verify/);
  });

  it("rejects a callback with no metadata at all", () => {
    expect(() => provider.handleWebhook(payload({ webhook_config: null }), {})).toThrow(
      /missing the call_id\/token metadata/,
    );
  });

  it("rejects a body that is not JSON", () => {
    expect(() => provider.handleWebhook("<html>oops</html>", {})).toThrow(/not JSON/);
  });

  it("maps every Sarvam status onto the platform taxonomy", () => {
    const cases: Array<[string, string]> = [
      ["connected", "completed"],
      ["no_answer", "no_answer"],
      ["busy", "busy"],
      ["failed", "failed"],
    ];
    for (const [sarvam, expected] of cases) {
      const result = provider.handleWebhook(
        payload({ status: sarvam, interaction_transcript: null }),
        {},
      );
      expect(result.status).toBe(expected);
    }
  });

  it("omits the transcript when the call did not connect", () => {
    const result = provider.handleWebhook(
      payload({ status: "no_answer", duration: null, interaction_transcript: null }),
      {},
    );
    expect(result.transcript).toBeUndefined();
    expect(result.durationSec).toBeUndefined();
  });
});

describe("carrier failure classification", () => {
  const provider = new SarvamVoiceProvider(config);

  function failure(reason: string) {
    return JSON.stringify({
      attempt_id: "att_1",
      status: "failed",
      failure_reason: reason,
      webhook_config: {
        metadata: { call_id: CALL_ID, token: webhookToken(CALL_ID, config.webhookSecret) },
      },
    });
  }

  it("suppresses a number registered under TRAI NDNC", () => {
    // The exact string Sarvam's docs give as an example. Retrying a
    // registry-suppressed number is futile and a regulatory problem, so it
    // must not reach the retry ladder.
    const result = provider.handleWebhook(
      failure("exotel: Phone number is registered under TRAI NDNC"),
      {},
    );
    expect(result.suppress).toEqual({ reason: "trai_ndnc_registered", permanent: true });
  });

  it("suppresses a DND registration however the carrier words it", () => {
    for (const reason of [
      "Number is on the DND registry",
      "Call blocked: do not call list",
      "subscriber has do not disturb registry preference",
    ]) {
      expect(suppressionFrom(reason).suppress?.permanent).toBe(true);
    }
  });

  it("suppresses a number that does not exist", () => {
    expect(suppressionFrom("Invalid destination number").suppress).toEqual({
      reason: "invalid_number",
      permanent: true,
    });
    expect(suppressionFrom("Number not in service").suppress?.reason).toBe("invalid_number");
  });

  it("leaves an ordinary failure to the retry ladder", () => {
    for (const reason of [
      "Network congestion, please retry",
      "Agent unavailable",
      "carrier timeout",
      "",
    ]) {
      expect(suppressionFrom(reason).suppress).toBeUndefined();
    }
  });

  it("does not suppress on a bare 'call ended' style message", () => {
    // Guards against a pattern that is too eager: "DND" must be a word, not a
    // substring of something else.
    expect(suppressionFrom("Ended by candidate").suppress).toBeUndefined();
    expect(suppressionFrom("Redundant attempt").suppress).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("declares India as its supported region", () => {
    // The calling worker treats an empty list as "unrestricted,
    // confirm with counsel". Sarvam's whole point here is that it is not empty.
    expect(new SarvamVoiceProvider(config).metadata()).toMatchObject({
      name: "sarvam",
      supportedRegions: ["IN"],
      supportsTranscript: true,
    });
  });

  it("refuses hangup loudly rather than pretending", async () => {
    // Sarvam documents no cancel endpoint. A silent no-op would let a caller
    // believe a call was terminated when it was not.
    await expect(new SarvamVoiceProvider(config).hangup("att_1")).rejects.toThrow(
      /no hangup endpoint/,
    );
  });
});

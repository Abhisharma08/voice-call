import { describe, expect, it, vi } from "vitest";
import {
  TwilioVoiceProvider,
  twilioSignature,
  twimlToken,
  type TwilioConfig,
} from "@/lib/providers/voice/twilio";
import { ProviderError } from "@/lib/providers/voice/types";

const config: TwilioConfig = {
  accountSid: "AC00000000000000000000000000000001",
  authToken: "test-auth-token",
  fromNumber: "+15005550006",
  publicUrl: "https://platform.example.com",
  webhookSecret: "test-webhook-secret",
};

const CALL_ID = "11111111-2222-4333-8444-555555555555";
const CALLBACK_URL = "https://platform.example.com/api/webhooks/voice/twilio";

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
    questions: [{ fieldName: "still_interested", question: "Still looking?", required: true }],
    businessContext: "Property in Noida.",
    clientName: "Acme Real Estate",
  },
  webhookUrl: `${config.publicUrl}/api/webhooks/voice/twilio`,
  correlationId: null,
};

describe("signature verification", () => {
  const provider = new TwilioVoiceProvider(config);

  function signed(params: Record<string, string>, url = CALLBACK_URL) {
    const body = new URLSearchParams(params);
    return {
      body: body.toString(),
      headers: {
        "x-twilio-signature": twilioSignature(config.authToken, url, body),
      },
    };
  }

  it("computes the documented signature: URL plus sorted key+value pairs", () => {
    // The worked example from Twilio's security docs.
    const params = new URLSearchParams({
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    });

    // Reimplemented here rather than reusing the function under test, so a
    // change to the concatenation order fails loudly.
    const url = "https://example.com/myapp?foo=1&bar=2";
    const expected =
      url +
      "CallSidCA1234567890ABCDE" +
      "Caller+14158675310" +
      "Digits1234" +
      "From+14158675310" +
      "To+18005551212";

    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    expect(twilioSignature("tok", url, params)).toBe(
      createHmac("sha1", "tok").update(Buffer.from(expected, "utf8")).digest("base64"),
    );
  });

  it("accepts a correctly signed callback", () => {
    const { body, headers } = signed({ CallSid: "CA1", CallStatus: "completed", CallDuration: "42" });
    const result = provider.handleWebhook(body, headers, CALLBACK_URL);

    expect(result.providerCallId).toBe("CA1");
    expect(result.status).toBe("completed");
    expect(result.durationSec).toBe(42);
  });

  it("rejects a tampered parameter", () => {
    const { headers } = signed({ CallSid: "CA1", CallStatus: "completed" });
    const tampered = new URLSearchParams({ CallSid: "CA999", CallStatus: "completed" }).toString();

    expect(() => provider.handleWebhook(tampered, headers, CALLBACK_URL)).toThrow(
      /does not verify/,
    );
  });

  it("rejects a signature computed for a different URL", () => {
    // The URL is signed material, which is why the interface passes it in.
    const { body, headers } = signed(
      { CallSid: "CA1", CallStatus: "completed" },
      "https://evil.example.com/api/webhooks/voice/twilio",
    );
    expect(() => provider.handleWebhook(body, headers, CALLBACK_URL)).toThrow(/does not verify/);
  });

  it("rejects a callback with no signature at all", () => {
    const body = new URLSearchParams({ CallSid: "CA1", CallStatus: "completed" }).toString();
    expect(() => provider.handleWebhook(body, {}, CALLBACK_URL)).toThrow(/Missing X-Twilio-Signature/);
  });

  it("rejects a signature made with the wrong auth token", () => {
    const body = new URLSearchParams({ CallSid: "CA1", CallStatus: "completed" });
    const headers = {
      "x-twilio-signature": twilioSignature("someone-elses-token", CALLBACK_URL, body),
    };
    expect(() => provider.handleWebhook(body.toString(), headers, CALLBACK_URL)).toThrow(
      ProviderError,
    );
  });

  it("declares that it authenticates its own callbacks", () => {
    // A carrier cannot attach a bearer token to a status callback, so the
    // route relies on this flag to accept one without a service token.
    expect(provider.metadata().verifiesWebhookSignature).toBe(true);
  });
});

describe("status mapping", () => {
  const provider = new TwilioVoiceProvider(config);

  function callback(status: string) {
    const body = new URLSearchParams({ CallSid: "CA1", CallStatus: status });
    return provider.handleWebhook(body.toString(), {
      "x-twilio-signature": twilioSignature(config.authToken, CALLBACK_URL, body),
    }, CALLBACK_URL);
  }

  it("maps Twilio's hyphenated statuses onto the platform taxonomy", () => {
    expect(callback("completed").status).toBe("completed");
    expect(callback("no-answer").status).toBe("no_answer");
    expect(callback("in-progress").status).toBe("answered");
    expect(callback("busy").status).toBe("busy");
    expect(callback("failed").status).toBe("failed");
    expect(callback("canceled").status).toBe("canceled");
    expect(callback("ringing").status).toBe("ringing");
  });

  it("treats an unrecognised status as a failure rather than passing it through", () => {
    expect(callback("something-new").status).toBe("failed");
  });
});

describe("createCall", () => {
  it("posts form-encoded to the Calls endpoint with basic auth", async () => {
    const { impl, calls } = stubFetch(() => json({ sid: "CA123", status: "queued" }));
    const result = await new TwilioVoiceProvider(config, impl).createCall(callRequest);

    expect(result).toEqual({ providerCallId: "CA123", status: "initiated" });
    expect(calls[0]!.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
    );
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("points the TwiML URL at this platform with a call-bound token", async () => {
    const { impl, calls } = stubFetch(() => json({ sid: "CA123", status: "queued" }));
    await new TwilioVoiceProvider(config, impl).createCall(callRequest);

    const body = new URLSearchParams(String(calls[0]!.init.body));
    const twimlUrl = new URL(body.get("Url")!);

    expect(twimlUrl.pathname).toBe("/api/webhooks/voice/twilio/twiml");
    expect(twimlUrl.searchParams.get("callId")).toBe(CALL_ID);
    expect(twimlUrl.searchParams.get("turn")).toBe("0");
    expect(twimlUrl.searchParams.get("token")).toBe(
      twimlToken(CALL_ID, config.webhookSecret),
    );

    expect(body.get("To")).toBe("+919876543210");
    expect(body.get("From")).toBe(config.fromNumber);
    expect(body.getAll("StatusCallbackEvent")).toContain("completed");
  });

  it("explains a trial account's unverified-number rejection", async () => {
    // Error 21219 is the single most likely first failure when testing, and
    // Twilio's raw message does not mention the dial allowlist.
    const { impl } = stubFetch(() =>
      json({ code: 21219, message: "The 'To' number is not verified" }, 400),
    );

    await expect(new TwilioVoiceProvider(config, impl).createCall(callRequest)).rejects.toMatchObject(
      { retryable: false, providerCode: "unverified_number" },
    );
    await expect(new TwilioVoiceProvider(config, impl).createCall(callRequest)).rejects.toThrow(
      /dial allowlist/,
    );
  });

  it("classifies auth as permanent and 5xx as retryable", async () => {
    const unauthorized = new TwilioVoiceProvider(config, stubFetch(() => json({}, 401)).impl);
    await expect(unauthorized.createCall(callRequest)).rejects.toMatchObject({ retryable: false });

    const unavailable = new TwilioVoiceProvider(config, stubFetch(() => json({}, 503)).impl);
    await expect(unavailable.createCall(callRequest)).rejects.toMatchObject({ retryable: true });
  });
});

describe("capabilities", () => {
  it("declares no supported regions, so compliance approval is always required", () => {
    // Twilio reaches most of the world, but "can dial" and "may dial" differ:
    // its India guidance restricts outbound to Indian numbers to non-Indian
    // originating numbers. An empty list keeps the compliance gate engaged.
    expect(new TwilioVoiceProvider(config).metadata().supportedRegions).toEqual([]);
  });

  it("does not fetch transcripts, because the TwiML endpoint captures them live", async () => {
    expect(await new TwilioVoiceProvider(config).retrieveTranscript("CA1")).toBeNull();
  });
});

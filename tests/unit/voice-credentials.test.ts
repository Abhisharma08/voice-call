import { describe, expect, it } from "vitest";
import {
  VOICE_PROVIDER_SPECS,
  providerOf,
  sarvamConfigFrom,
  specFor,
  twilioConfigFrom,
  validateVoiceCredential,
  type VoiceCredential,
} from "@/lib/providers/voice/credentials";

/**
 * The shape check that stands between a pasted value and a campaign that
 * cannot dial. Every case here is one someone would otherwise discover at the
 * first real call.
 */

const SARVAM: VoiceCredential = {
  provider: "sarvam",
  apiKey: "sk_test_abcdef123456",
  orgId: "org_1",
  workspaceId: "ws_1",
  appId: "app_1",
  connectionId: "conn_1",
  agentPhoneNumber: "+919876543210",
};

const TWILIO: VoiceCredential = {
  provider: "twilio",
  accountSid: "AC123",
  authToken: "tok_123",
  fromNumber: "+12025550143",
};

describe("voice credential validation", () => {
  it("accepts a complete Sarvam credential", () => {
    expect(validateVoiceCredential(JSON.stringify(SARVAM))).toBeNull();
  });

  it("accepts a complete Twilio credential", () => {
    expect(validateVoiceCredential(JSON.stringify(TWILIO))).toBeNull();
  });

  it("names every missing field at once, rather than one per attempt", () => {
    const error = validateVoiceCredential(
      JSON.stringify({ provider: "sarvam", apiKey: "sk_test_abcdef123456" }),
    );
    expect(error).toContain("Organisation ID");
    expect(error).toContain("Workspace ID");
    expect(error).toContain("Agent phone number");
  });

  it("treats a blank field as missing", () => {
    expect(validateVoiceCredential(JSON.stringify({ ...SARVAM, orgId: "   " }))).toContain(
      "Organisation ID",
    );
  });

  it("does not require the optional app version", () => {
    const { appVersion: _omitted, ...withoutVersion } = { ...SARVAM, appVersion: "2" };
    expect(validateVoiceCredential(JSON.stringify(withoutVersion))).toBeNull();
  });

  it("refuses a caller ID that is not E.164", () => {
    expect(
      validateVoiceCredential(JSON.stringify({ ...SARVAM, agentPhoneNumber: "9876543210" })),
    ).toContain("E.164");
    expect(
      validateVoiceCredential(JSON.stringify({ ...TWILIO, fromNumber: "(202) 555-0143" })),
    ).toContain("E.164");
  });

  it("refuses an unknown provider by name", () => {
    const error = validateVoiceCredential(JSON.stringify({ provider: "vonage", apiKey: "k" }));
    expect(error).toContain("vonage");
    expect(error).toContain("sarvam");
  });

  it("refuses a credential that names no provider", () => {
    expect(validateVoiceCredential(JSON.stringify({ apiKey: "k" }))).toContain("sarvam");
  });

  it("refuses something that is not JSON", () => {
    expect(validateVoiceCredential("sk_live_not_json")).toContain("JSON");
  });
});

describe("reading a stored credential", () => {
  it("reports the provider without unsealing anything else", () => {
    expect(providerOf(JSON.stringify(SARVAM))).toBe("sarvam");
    expect(providerOf("not json")).toBeNull();
    expect(providerOf(JSON.stringify({ apiKey: "k" }))).toBeNull();
  });

  it("fills deployment values the credential deliberately does not carry", () => {
    process.env.VOICE_WEBHOOK_SECRET = "test-webhook-secret";
    const config = sarvamConfigFrom(SARVAM);

    expect(config.apiKey).toBe(SARVAM.apiKey);
    expect(config.appVersion).toBe(1);
    // Ours, not the client's: it keys a token we mint and verify.
    expect(config.webhookSecret).toBe("test-webhook-secret");
  });

  it("carries an explicit app version through", () => {
    expect(sarvamConfigFrom({ ...SARVAM, appVersion: "3" }).appVersion).toBe(3);
  });

  it("gives Twilio the deployment's public URL, since callbacks are built from it", () => {
    process.env.APP_URL = "https://calls.example.com/";
    expect(twilioConfigFrom(TWILIO).publicUrl).toBe("https://calls.example.com");
  });
});

describe("the field specs the form renders from", () => {
  it("marks secrets so the form never renders them in the clear", () => {
    const sarvam = specFor("sarvam")!;
    expect(sarvam.fields.find((f) => f.key === "apiKey")?.secret).toBe(true);
    expect(specFor("twilio")!.fields.find((f) => f.key === "authToken")?.secret).toBe(true);
  });

  it("asks for exactly what the adapter reads", () => {
    // If a field is added to SarvamConfig without appearing here, the form
    // cannot collect it and the credential is stored incomplete.
    const keys = specFor("sarvam")!.fields.map((f) => f.key);
    expect(keys).toEqual([
      "apiKey",
      "orgId",
      "workspaceId",
      "appId",
      "appVersion",
      "connectionId",
      "agentPhoneNumber",
    ]);
  });

  it("has a spec for every provider it claims to configure", () => {
    for (const spec of VOICE_PROVIDER_SPECS) {
      expect(specFor(spec.provider)).toBe(spec);
      expect(spec.fields.length).toBeGreaterThan(0);
    }
  });
});

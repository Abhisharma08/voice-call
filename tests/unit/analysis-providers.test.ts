import { describe, it, expect } from "vitest";
import {
  resolveAnalysisProvider,
  analysisProviderNames,
} from "@/lib/qualification/providers";
import { qualificationJsonSchema } from "@/lib/qualification/providers/gemini";
import { analyzeTranscript } from "@/lib/qualification/analyze";
import { QualificationSchema } from "@/lib/qualification/schema";

/**
 * The analysis provider registry (PRD 10.4's reasoning applied to the model,
 * not the carrier). No network: resolution, schema conversion, and the rule
 * that a misconfigured campaign degrades to review rather than failing loudly
 * at the caller.
 */

const campaign = {
  clientName: "Acme",
  campaignName: "Q3 enquiries",
  businessContext: "Real estate",
  productService: "2BHK apartments",
  questions: [{ fieldName: "timeline", question: "When are you buying?", required: true }],
  model: "claude-opus-5",
  effort: "medium",
  promptVersion: "v1",
};

describe("analysis provider registry", () => {
  it("always registers Anthropic, whose absent credentials are a degraded mode not a startup failure", () => {
    expect(analysisProviderNames()).toContain("claude-");
  });

  it("resolves a model to the provider whose namespace it is in", () => {
    expect(resolveAnalysisProvider("claude-opus-5").name).toBe("anthropic");
  });

  it("refuses a model no adapter claims, naming what is registered", () => {
    expect(() => resolveAnalysisProvider("gpt-4o")).toThrow(/No analysis provider/);
    expect(() => resolveAnalysisProvider("gpt-4o")).toThrow(/claude-/);
  });

  it("registers Gemini only when a key is configured", () => {
    const configured = Boolean(
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
    );
    expect(analysisProviderNames().includes("gemini-")).toBe(configured);
  });
});

describe("an unresolvable model degrades to review (PRD 18.2)", () => {
  it("returns the unknown fallback rather than throwing at the caller", async () => {
    const response = await analyzeTranscript({
      transcript: "Agent: Hello. Lead: Not now, thanks.",
      campaign: { ...campaign, model: "some-unregistered-model" },
      callDurationSec: 30,
    });

    // Confidence 0 always trips the review gate, so nothing reaches a client's
    // CRM that no model actually produced.
    expect(response.degraded).toBe(true);
    expect(response.result.intent).toBe("unknown");
    expect(response.result.confidence).toBe(0);
    expect(response.result.reason).toMatch(/No analysis provider/);

    // The reason has to name the model, or an operator cannot tell which
    // campaign is misconfigured from the review queue alone.
    expect(response.result.reason).toContain("some-unregistered-model");
  });

  it("reports no token usage for a call that never reached a model", async () => {
    const response = await analyzeTranscript({
      transcript: "Agent: Hello.",
      campaign: { ...campaign, model: "some-unregistered-model" },
      callDurationSec: null,
    });

    // Billing metrics (PRD 21) must not count tokens nobody spent.
    expect(response.inputTokens).toBeNull();
    expect(response.outputTokens).toBeNull();
  });
});

describe("Gemini structured output schema", () => {
  const schema = qualificationJsonSchema() as {
    type: string;
    properties: Record<string, { type?: unknown; enum?: unknown }>;
    required: string[];
  };

  it("drops $schema, which the API rejects as an unrecognised property", () => {
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.type).toBe("object");
  });

  it("expresses nullable fields as a type union, the form the API accepts", () => {
    // FR-032: a field the lead never addressed must be expressible as null,
    // or the model has no way to say "not stated" except by inventing one.
    expect(schema.properties.budget?.type).toEqual(["string", "null"]);
    expect(schema.properties.still_interested?.type).toEqual(["boolean", "null"]);
  });

  it("keeps the intent taxonomy as a closed enum", () => {
    expect(schema.properties.intent?.enum).toContain("do_not_call");
    expect(schema.properties.intent?.enum).toContain("unknown");
  });

  it("requires every field the scoring rubric reads", () => {
    // A field the model may omit reads as undefined downstream, which scores
    // differently from an explicit null. Both providers must return all of them.
    for (const field of Object.keys(QualificationSchema.shape)) {
      expect(schema.required).toContain(field);
    }
  });
});

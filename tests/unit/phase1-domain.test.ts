import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { isWithinWindow, parseHHMM, zonedTimeToUtc } from "@/lib/calling/windows";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, decideRetry } from "@/lib/calling/retry";
import { DEFAULT_RUBRIC, decideRouting, scoreResult } from "@/lib/qualification/scoring";
import { evaluateReviewGate, mayAutoSync } from "@/lib/qualification/review";
import { QualificationSchema, resultForUnconnectedCall, unknownResult } from "@/lib/qualification/schema";
import type { QualificationResult } from "@/lib/qualification/schema";

function result(overrides: Partial<QualificationResult> = {}): QualificationResult {
  return { ...unknownResult("test"), confidence: 0.95, ...overrides };
}

describe("phone normalisation (FR-011, FR-012)", () => {
  it("normalises an Indian mobile to E.164", () => {
    const r = normalizePhone("98765 43210", "IN");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.e164).toBe("+919876543210");
      expect(r.country).toBe("IN");
      expect(r.last4).toBe("3210");
    }
  });

  it("accepts an already-normalised number without a default country", () => {
    const r = normalizePhone("+919876543210");
    expect(r.ok).toBe(true);
  });

  it("normalises the same number written several ways to one value", () => {
    // This is what makes the dedupe blind index work (FR-013).
    const forms = ["+91 98765 43210", "098765 43210", "+919876543210", "9876543210"];
    const normalised = forms.map((f) => {
      const r = normalizePhone(f, "IN");
      return r.ok ? r.e164 : null;
    });
    expect(new Set(normalised)).toEqual(new Set(["+919876543210"]));
  });

  it("rejects an empty or missing number", () => {
    expect(normalizePhone(null).ok).toBe(false);
    expect(normalizePhone("").ok).toBe(false);
    expect(normalizePhone("   ").ok).toBe(false);
  });

  it("rejects a number that is too short to route", () => {
    const r = normalizePhone("12345", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_short");
  });

  it("rejects a well-formed but invalid number for the region", () => {
    // Right shape, not an allocated Indian range.
    const r = normalizePhone("+91 00000 00000", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_for_region");
  });

  it("rejects a US number that does not exist", () => {
    const r = normalizePhone("+1 555 555 0100");
    expect(r.ok).toBe(false);
  });

  it("classifies line type, which the default metadata build cannot do", () => {
    // Guards the `/max` import in src/lib/phone.ts: with the default "min"
    // metadata getType() is always undefined, so the not_callable check for
    // voicemail and premium-rate ranges would silently never fire.
    const mobile = normalizePhone("+91 98765 43210", "IN");
    expect(mobile.ok).toBe(true);

    const premium = normalizePhone("+44 909 8790000", "GB");
    expect(premium.ok).toBe(false);
    if (!premium.ok) expect(premium.reason).toBe("not_callable");
  });

  it("lowercases and trims emails for the blind index", () => {
    expect(normalizeEmail("  Rahul@Example.COM ")).toBe("rahul@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("calling windows (FR-021)", () => {
  const window = { windowStart: "09:30", windowEnd: "18:30", timezone: "Asia/Kolkata" };

  it("parses HH:MM and rejects nonsense", () => {
    expect(parseHHMM("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(() => parseHHMM("25:00")).toThrow();
    expect(() => parseHHMM("9:30")).toThrow();
  });

  it("allows a call inside the window in the campaign timezone", () => {
    // 12:00 IST = 06:30 UTC
    const decision = isWithinWindow(new Date("2026-09-01T06:30:00Z"), window);
    expect(decision.allowed).toBe(true);
  });

  it("blocks a call before the window opens and reports the next opening", () => {
    // 08:00 IST = 02:30 UTC
    const decision = isWithinWindow(new Date("2026-09-01T02:30:00Z"), window);
    expect(decision.allowed).toBe(false);
    // 09:30 IST the same day = 04:00 UTC
    expect(decision.nextOpenAt.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  it("rolls to the next day after the window closes", () => {
    // 20:00 IST = 14:30 UTC
    const decision = isWithinWindow(new Date("2026-09-01T14:30:00Z"), window);
    expect(decision.allowed).toBe(false);
    expect(decision.nextOpenAt.toISOString()).toBe("2026-09-02T04:00:00.000Z");
  });

  it("uses the campaign timezone, not the server's", () => {
    // 06:30 UTC is inside the window in Kolkata and outside it in New York.
    const instant = new Date("2026-09-01T06:30:00Z");
    expect(isWithinWindow(instant, window).allowed).toBe(true);
    expect(isWithinWindow(instant, { ...window, timezone: "America/New_York" }).allowed).toBe(false);
  });

  it("skips days the campaign does not call on", () => {
    // 2026-09-05 is a Saturday; weekdays only.
    const decision = isWithinWindow(new Date("2026-09-05T06:30:00Z"), {
      ...window,
      days: [1, 2, 3, 4, 5],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.nextOpenAt.toISOString()).toBe("2026-09-07T04:00:00.000Z");
  });

  it("converts wall-clock to UTC correctly across a DST boundary", () => {
    // US DST ends 2026-11-01. 09:30 local is UTC-4 before and UTC-5 after.
    expect(zonedTimeToUtc("America/New_York", 2026, 10, 15, 9, 30).toISOString()).toBe(
      "2026-10-15T13:30:00.000Z",
    );
    expect(zonedTimeToUtc("America/New_York", 2026, 11, 15, 9, 30).toISOString()).toBe(
      "2026-11-15T14:30:00.000Z",
    );
  });

  it("rejects a window whose end is not after its start", () => {
    expect(() => isWithinWindow(new Date(), { ...window, windowEnd: "09:00" })).toThrow();
  });
});

describe("retry policy (FR-024, W04)", () => {
  const now = new Date("2026-09-01T10:00:00Z");

  it("schedules a no-answer retry from the ladder", () => {
    const d = decideRetry({ outcome: "no_answer", attemptsMade: 1, policy: DEFAULT_RETRY_POLICY, now });
    expect(d.action).toBe("retry");
    if (d.action === "retry") {
      expect(d.nextCallAt.toISOString()).toBe("2026-09-01T10:15:00.000Z");
      expect(d.attemptNo).toBe(2);
    }
  });

  it("walks the ladder on later attempts", () => {
    const d = decideRetry({ outcome: "no_answer", attemptsMade: 2, policy: DEFAULT_RETRY_POLICY, now });
    if (d.action === "retry") expect(d.nextCallAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("uses the short retry for a busy signal", () => {
    const d = decideRetry({ outcome: "busy", attemptsMade: 2, policy: DEFAULT_RETRY_POLICY, now });
    if (d.action === "retry") expect(d.nextCallAt.toISOString()).toBe("2026-09-01T10:15:00.000Z");
  });

  it("stops at max attempts", () => {
    const d = decideRetry({ outcome: "no_answer", attemptsMade: 3, policy: DEFAULT_RETRY_POLICY, now });
    expect(d).toEqual({ action: "stop", reason: "max_attempts_reached" });
  });

  it("stops permanently on a DNC, even with attempts remaining", () => {
    const d = decideRetry({ outcome: "do_not_call", attemptsMade: 1, policy: DEFAULT_RETRY_POLICY, now });
    expect(d).toEqual({ action: "stop", reason: "do_not_call" });
  });

  it("honours a requested callback over the retry ladder", () => {
    const callbackAt = new Date("2026-09-02T05:30:00Z");
    const d = decideRetry({
      outcome: "no_answer",
      attemptsMade: 1,
      policy: DEFAULT_RETRY_POLICY,
      callbackAt,
      now,
    });
    expect(d.action).toBe("callback");
    if (d.action === "callback") expect(d.nextCallAt).toEqual(callbackAt);
  });

  it("does not honour a callback in the past", () => {
    const d = decideRetry({
      outcome: "no_answer",
      attemptsMade: 1,
      policy: DEFAULT_RETRY_POLICY,
      callbackAt: new Date("2026-08-01T00:00:00Z"),
      now,
    });
    expect(d.action).toBe("retry");
  });

  it("backs off exponentially with jitter, bounded by the cap", () => {
    expect(backoffDelayMs(1, 1000)).toBeGreaterThan(500);
    expect(backoffDelayMs(1, 1000)).toBeLessThan(2000);
    expect(backoffDelayMs(20, 1000)).toBeLessThanOrEqual(15 * 60_000 * 1.2);
  });
});

describe("scoring rubric (PRD 11.2)", () => {
  it("scores the PRD's worked example as hot", () => {
    // "Actively searching; requests advisor", 0-3 months, budget, 2BHK -> 90
    const { score } = scoreResult(
      result({
        intent: "hot",
        still_interested: true,
        timeline: "0-3_months",
        budget: "50-75 lakh",
        product_interest: "2BHK",
        human_followup: true,
      }),
    );
    expect(score).toBe(90);
  });

  it("awards nothing for fields the model left null (FR-032)", () => {
    const { score } = scoreResult(result({ intent: "warm", still_interested: true }));
    expect(score).toBe(DEFAULT_RUBRIC.currentNeedConfirmed);
  });

  it("floors an explicit rejection regardless of other signals", () => {
    const { score } = scoreResult(
      result({
        intent: "not_interested",
        still_interested: true,
        timeline: "0-3_months",
        budget: "1 crore",
        human_followup: true,
      }),
    );
    expect(score).toBe(-100);
  });

  it("gives vague curiosity a token score", () => {
    const { score } = scoreResult(result({ intent: "warm" }));
    expect(score).toBe(DEFAULT_RUBRIC.vagueCuriosity);
  });

  it("records the signals that produced the score", () => {
    const { signals } = scoreResult(result({ still_interested: true, timeline: "0-3_months" }));
    expect(signals.map((s) => s.signal)).toEqual(["current_need_confirmed", "short_timeline"]);
  });
});

describe("routing thresholds (PRD 11.3)", () => {
  it("routes a high score to human sales", () => {
    expect(decideRouting(result({ intent: "hot" }), 82).action).toBe("hot_sales_routing");
  });

  it("creates a follow-up in the interested band", () => {
    expect(decideRouting(result({ intent: "interested" }), 60).action).toBe("create_followup");
  });

  it("nurtures below the interested threshold", () => {
    expect(decideRouting(result({ intent: "warm" }), 20).action).toBe("nurture");
  });

  it("suppresses on DNC regardless of score", () => {
    expect(decideRouting(result({ intent: "hot", do_not_call: true }), 95).action).toBe(
      "suppress_permanently",
    );
  });

  it("honours a callback request regardless of score", () => {
    expect(decideRouting(result({ intent: "warm", callback_requested: true }), 10).action).toBe(
      "schedule_callback",
    );
  });

  it("stops the campaign on not_interested", () => {
    expect(decideRouting(result({ intent: "not_interested" }), -100).action).toBe("stop_campaign");
  });

  it("retries when no conversation happened", () => {
    expect(decideRouting(result({ intent: "no_answer" }), 0).action).toBe("retry");
  });
});

describe("review gate (FR-035, PRD 26.3)", () => {
  const base = {
    confidenceThreshold: 0.75,
    boundaryBand: 5,
    thresholds: { hotThreshold: 75, interestedThreshold: 50 },
    requiredFields: [] as string[],
    unconnected: false,
  };

  it("auto-approves a confident, unambiguous result", () => {
    const decision = evaluateReviewGate({ ...base, result: result({ intent: "hot" }), score: 90 });
    expect(decision.hold).toBe(false);
  });

  it("holds a low-confidence result", () => {
    const decision = evaluateReviewGate({
      ...base,
      result: result({ intent: "hot", confidence: 0.4 }),
      score: 90,
    });
    expect(decision.hold).toBe(true);
    if (decision.hold) expect(decision.triggers).toContain("low_confidence");
  });

  it("holds when a required field was never answered", () => {
    const decision = evaluateReviewGate({
      ...base,
      requiredFields: ["budget"],
      result: result({ intent: "hot", budget: null }),
      score: 90,
    });
    expect(decision.hold).toBe(true);
    if (decision.hold) expect(decision.triggers).toContain("missing_required_fields");
  });

  it("treats an 'unknown' timeline as unanswered", () => {
    const decision = evaluateReviewGate({
      ...base,
      requiredFields: ["timeline"],
      result: result({ intent: "hot", timeline: "unknown" }),
      score: 90,
    });
    if (decision.hold) expect(decision.triggers).toContain("missing_required_fields");
  });

  it("holds a score sitting on a routing boundary", () => {
    const decision = evaluateReviewGate({ ...base, result: result({ intent: "hot" }), score: 77 });
    expect(decision.hold).toBe(true);
    if (decision.hold) expect(decision.triggers).toContain("boundary_band");
  });

  it("holds a do-not-call the model is not sure about", () => {
    // Suppression is irreversible, so an uncertain DNC gets a human first.
    const decision = evaluateReviewGate({
      ...base,
      result: result({ intent: "do_not_call", do_not_call: true, confidence: 0.8 }),
      score: -100,
    });
    expect(decision.hold).toBe(true);
    if (decision.hold) expect(decision.triggers).toContain("dnc_needs_verification");
  });

  it("does not hold a confident do-not-call", () => {
    const decision = evaluateReviewGate({
      ...base,
      result: result({ intent: "do_not_call", do_not_call: true, confidence: 0.98 }),
      score: -100,
    });
    expect(decision.hold).toBe(false);
  });

  it("does not review a call that never connected", () => {
    const decision = evaluateReviewGate({
      ...base,
      result: resultForUnconnectedCall("no_answer"),
      score: 0,
      unconnected: true,
    });
    expect(decision.hold).toBe(false);
  });

  it("only lets committed statuses sync downstream", () => {
    expect(mayAutoSync("pending_review")).toBe(false);
    expect(mayAutoSync("rejected")).toBe(false);
    expect(mayAutoSync("auto_approved")).toBe(true);
    expect(mayAutoSync("confirmed")).toBe(true);
    expect(mayAutoSync("corrected")).toBe(true);
  });
});

describe("qualification schema (FR-031, FR-032)", () => {
  it("accepts a well-formed result", () => {
    expect(QualificationSchema.safeParse(result({ intent: "hot" })).success).toBe(true);
  });

  it("rejects an intent outside the taxonomy", () => {
    expect(QualificationSchema.safeParse(result({ intent: "very_hot" as never })).success).toBe(false);
  });

  it("rejects a confidence outside 0-1", () => {
    expect(QualificationSchema.safeParse(result({ confidence: 1.5 })).success).toBe(false);
  });

  it("allows null for every extracted field", () => {
    const parsed = QualificationSchema.safeParse(
      result({ budget: null, location: null, product_interest: null, still_interested: null }),
    );
    expect(parsed.success).toBe(true);
  });

  it("gives an unconnected call zero-cost certainty rather than a guess", () => {
    const r = resultForUnconnectedCall("no_answer");
    expect(r.intent).toBe("no_answer");
    expect(r.confidence).toBe(1);
    expect(r.budget).toBeNull();
  });
});

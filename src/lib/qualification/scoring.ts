import type { QualificationResult } from "@/lib/qualification/schema";

/**
 * Lead scoring and routing.
 *
 * The scoring rubric is deliberately computed here in code, from the model's
 * extracted fields, rather than being asked of the model. The rubric is
 * arithmetic; making the LLM do arithmetic adds a failure mode and removes
 * auditability. This way a score is always reproducible from the stored
 * structured payload, which matters when an operator disputes a routing
 * decision.
 *
 * The rubric is configurable per campaign. The default is illustrative and
 * must not override a client's own domain-specific qualification logic.
 */

export interface ScoringRubric {
  currentNeedConfirmed: number;
  shortTimeline: number;
  budgetKnown: number;
  specificProduct: number;
  acceptsHumanFollowup: number;
  vagueCuriosity: number;
  longTermNoPlan: number;
  explicitRejection: number;
}

export const DEFAULT_RUBRIC: ScoringRubric = {
  currentNeedConfirmed: 25,
  shortTimeline: 25,
  budgetKnown: 15,
  specificProduct: 10,
  acceptsHumanFollowup: 15,
  vagueCuriosity: 5,
  longTermNoPlan: 0,
  explicitRejection: -100,
};

export function rubricFromConfig(config: Record<string, unknown>): ScoringRubric {
  const pick = (key: keyof ScoringRubric, snake: string): number => {
    const value = config[snake];
    return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_RUBRIC[key];
  };

  return {
    currentNeedConfirmed: pick("currentNeedConfirmed", "current_need_confirmed"),
    shortTimeline: pick("shortTimeline", "short_timeline"),
    budgetKnown: pick("budgetKnown", "budget_known"),
    specificProduct: pick("specificProduct", "specific_product"),
    acceptsHumanFollowup: pick("acceptsHumanFollowup", "accepts_human_followup"),
    vagueCuriosity: pick("vagueCuriosity", "vague_curiosity"),
    longTermNoPlan: pick("longTermNoPlan", "long_term_no_plan"),
    explicitRejection: pick("explicitRejection", "explicit_rejection"),
  };
}

export interface ScoreBreakdown {
  score: number;
  signals: Array<{ signal: string; points: number }>;
}

export function scoreResult(result: QualificationResult, rubric = DEFAULT_RUBRIC): ScoreBreakdown {
  const signals: ScoreBreakdown["signals"] = [];

  // An explicit rejection is terminal for scoring; nothing else can lift it.
  if (result.intent === "not_interested" || result.do_not_call) {
    signals.push({ signal: "explicit_rejection", points: rubric.explicitRejection });
    return { score: clamp(rubric.explicitRejection), signals };
  }

  if (result.still_interested === true) {
    signals.push({ signal: "current_need_confirmed", points: rubric.currentNeedConfirmed });
  }

  if (result.timeline === "0-3_months") {
    signals.push({ signal: "short_timeline", points: rubric.shortTimeline });
  } else if (result.timeline === "12_months_plus") {
    signals.push({ signal: "long_term_no_plan", points: rubric.longTermNoPlan });
  }

  if (result.budget !== null && result.budget.trim() !== "") {
    signals.push({ signal: "budget_known", points: rubric.budgetKnown });
  }

  if (result.product_interest !== null && result.product_interest.trim() !== "") {
    signals.push({ signal: "specific_product", points: rubric.specificProduct });
  }

  if (result.human_followup) {
    signals.push({ signal: "accepts_human_followup", points: rubric.acceptsHumanFollowup });
  }

  // "Just checking" - interest with nothing concrete behind it.
  if (signals.length === 0 && result.intent === "warm") {
    signals.push({ signal: "vague_curiosity", points: rubric.vagueCuriosity });
  }

  return { score: clamp(signals.reduce((sum, s) => sum + s.points, 0)), signals };
}

function clamp(score: number): number {
  return Math.max(-100, Math.min(100, score));
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type RoutingAction =
  | "hot_sales_routing"
  | "create_followup"
  | "nurture"
  | "schedule_callback"
  | "stop_campaign"
  | "suppress_permanently"
  | "retry";

export interface RoutingThresholds {
  hotThreshold: number;
  interestedThreshold: number;
}

export const DEFAULT_THRESHOLDS: RoutingThresholds = {
  hotThreshold: 75,
  interestedThreshold: 50,
};

export function thresholdsFromConfig(config: Record<string, unknown>): RoutingThresholds {
  return {
    hotThreshold: Number(config.hot_threshold ?? DEFAULT_THRESHOLDS.hotThreshold),
    interestedThreshold: Number(config.interested_threshold ?? DEFAULT_THRESHOLDS.interestedThreshold),
  };
}

export interface RoutingDecision {
  action: RoutingAction;
  reason: string;
}

/**
 * the condition table, in its stated precedence. DNC and explicit
 * rejection win "regardless of score"; a requested callback is honoured
 * "regardless of score" too.
 */
export function decideRouting(
  result: QualificationResult,
  score: number,
  thresholds = DEFAULT_THRESHOLDS,
): RoutingDecision {
  if (result.do_not_call || result.intent === "do_not_call") {
    return { action: "suppress_permanently", reason: "intent=do_not_call suppresses regardless of score" };
  }

  if (result.wrong_number || result.intent === "wrong_number") {
    return { action: "stop_campaign", reason: "wrong number; stop and flag for data correction" };
  }

  if (result.intent === "not_interested") {
    return { action: "stop_campaign", reason: "intent=not_interested stops the campaign" };
  }

  if (result.intent === "no_answer" || result.intent === "busy") {
    return { action: "retry", reason: "no conversation took place" };
  }

  if (result.callback_requested) {
    return { action: "schedule_callback", reason: "callback_requested=true regardless of score" };
  }

  if (score >= thresholds.hotThreshold) {
    return { action: "hot_sales_routing", reason: `score ${score} >= ${thresholds.hotThreshold}` };
  }

  if (score >= thresholds.interestedThreshold) {
    return { action: "create_followup", reason: `score ${score} in interested/warm band` };
  }

  return { action: "nurture", reason: `score ${score} below interested threshold` };
}

/** Map a score and intent onto the outcome taxonomy the CRM expects. */
export function qualificationLabel(result: QualificationResult, score: number): string {
  if (result.do_not_call) return "do_not_call";
  if (result.wrong_number) return "wrong_number";
  if (result.intent === "not_interested") return "not_interested";
  if (result.intent === "no_answer" || result.intent === "busy") return result.intent;
  if (score >= DEFAULT_THRESHOLDS.hotThreshold) return "qualified";
  if (score >= DEFAULT_THRESHOLDS.interestedThreshold) return "partially_qualified";
  return "unqualified";
}

/**
 * Retry and callback policy (FR-024, PRD 9 workflow W04).
 *
 * W04's trigger table maps an outcome to an action:
 *   no_answer           increment attempt; schedule retry within campaign policy
 *   busy                short retry unless a callback time exists
 *   callback_requested  schedule the exact callback time if available
 *   provider_failure    retry transient failures with exponential backoff
 *   DNC                 terminate retries permanently
 *   max_attempts        terminal status; no more calls
 */

export type CallOutcome =
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled"
  | "do_not_call";

export interface RetryPolicy {
  maxAttempts: number;
  /** Minutes to wait before attempt N+1, indexed by attempts already made. */
  retryMinutes: number[];
  /** Short retry for a busy signal, which usually means "try again soon". */
  busyRetryMinutes: number;
}

export type RetryDecision =
  | { action: "retry"; nextCallAt: Date; attemptNo: number; reason: string }
  | { action: "callback"; nextCallAt: Date; reason: string }
  | { action: "stop"; reason: "max_attempts_reached" | "do_not_call" | "completed" | "terminal" };

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  retryMinutes: [15, 120, 1440],
  busyRetryMinutes: 15,
};

export function retryPolicyFromConfig(config: Record<string, unknown>): RetryPolicy {
  const retryMinutes = Array.isArray(config.retry_minutes)
    ? (config.retry_minutes as number[]).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_RETRY_POLICY.retryMinutes;

  return {
    maxAttempts: Number(config.max_attempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
    retryMinutes: retryMinutes.length > 0 ? retryMinutes : DEFAULT_RETRY_POLICY.retryMinutes,
    busyRetryMinutes: Number(config.busy_retry_minutes ?? DEFAULT_RETRY_POLICY.busyRetryMinutes),
  };
}

export function decideRetry(args: {
  outcome: CallOutcome;
  attemptsMade: number;
  policy: RetryPolicy;
  callbackAt?: Date | null;
  now?: Date;
}): RetryDecision {
  const now = args.now ?? new Date();
  const { policy, attemptsMade } = args;

  // A callback the lead explicitly asked for outranks the retry ladder
  // entirely - W04: "schedule exact callback time if available".
  if (args.callbackAt && args.callbackAt.getTime() > now.getTime()) {
    return { action: "callback", nextCallAt: args.callbackAt, reason: "callback_requested" };
  }

  if (args.outcome === "do_not_call") return { action: "stop", reason: "do_not_call" };
  if (args.outcome === "completed") return { action: "stop", reason: "completed" };
  if (args.outcome === "canceled") return { action: "stop", reason: "terminal" };

  if (attemptsMade >= policy.maxAttempts) {
    return { action: "stop", reason: "max_attempts_reached" };
  }

  const delayMinutes =
    args.outcome === "busy"
      ? policy.busyRetryMinutes
      : // Attempts already made indexes the ladder; the last entry repeats if
        // maxAttempts exceeds the ladder length.
        policy.retryMinutes[Math.min(attemptsMade - 1, policy.retryMinutes.length - 1)] ??
        policy.retryMinutes[policy.retryMinutes.length - 1] ??
        60;

  return {
    action: "retry",
    nextCallAt: new Date(now.getTime() + delayMinutes * 60_000),
    attemptNo: attemptsMade + 1,
    reason: args.outcome,
  };
}

/**
 * Exponential backoff for integration retries (PRD 18.2: "Temporary HTTP 5xx -
 * Yes - Exponential backoff"). Jittered, so a provider outage does not produce
 * a synchronised retry stampede when it recovers.
 */
export function backoffDelayMs(attempt: number, baseMs = 1_000, maxMs = 15 * 60_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential - exponential * 0.15 + jitter);
}

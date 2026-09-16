/**
 * Structured logging.
 *
 * The codebase already logs one JSON object per line - `{level, msg, ...}` -
 * hand-built at each call site with `JSON.stringify`. That shape is right and
 * this does not change it; what it adds is the two things a hand-built line
 * cannot be relied on to do.
 *
 * **Redaction.** A log line is the easiest way for a phone number or a lead's
 * name to leave the encrypted column it was carefully put into (PRD 26.2).
 * Every value passed here goes through `redact()`, so a field that should
 * never have been logged is dropped by the logger rather than by the author
 * remembering.
 *
 * **Bounded output.** An error carrying a provider's HTML error page, or a
 * payload echoed into a log line, produces a multi-megabyte entry that costs
 * real money on a hosted log drain and is unreadable anyway. Values are
 * truncated.
 *
 * Deliberately not a logging library. This writes to stdout because that is
 * what every host - Vercel, a container platform, systemd - already collects,
 * and a transport that buffers would lose exactly the lines that matter when
 * an instance is torn down mid-request.
 */

export type Level = "debug" | "info" | "warn" | "error";

/** Values at or below this are dropped. */
const THRESHOLD: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && configured in THRESHOLD) return THRESHOLD[configured as Level];
  // Debug is off by default; everything else is on.
  return THRESHOLD.info;
}

/**
 * Field names whose values never belong in a log, matched case-insensitively
 * and as substrings.
 *
 * Substring matching is what makes this hold up over time: the list has to
 * catch `phone`, `lead_phone`, `phoneE164` and `customer_phone_number` without
 * anyone maintaining an enumeration of every name a phone number is given. It
 * over-matches occasionally - a field called `telephone_supported` would be
 * redacted - and that is the right direction to be wrong in.
 */
const SENSITIVE = [
  "phone",
  "email",
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "apikey",
  "api_key",
  "access_key",
  "private_key",
  "webhookurl",
  "webhook_url",
  "transcript",
  "recording",
  "name_enc",
  "phone_enc",
];

/**
 * Names that contain a sensitive substring but are safe, and are load-bearing
 * in the logs that already exist.
 *
 * `tenant_name` and `campaign_name` are a client's business name and their own
 * label for a campaign - the two things that make a log line identifiable as
 * *this* client's - and redacting them would make the operational logs useless
 * to answer "whose campaign is failing". They are agency-side configuration,
 * not a lead's personal data.
 */
const ALLOWED = ["tenant_name", "campaign_name", "provider_name", "worker_name", "key_id"];

const MAX_STRING = 512;
const MAX_DEPTH = 4;

export function redact(value: unknown, keyHint = "", depth = 0): unknown {
  if (isSensitive(keyHint)) return "[redacted]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Date) return value.toISOString();

  // A Buffer is either ciphertext or key material here. Neither is loggable,
  // and its JSON form is a wall of byte values that would bury the line.
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      // No stack by default: it is the bulkiest part of a line and routinely
      // contains interpolated argument values from frames above the throw.
      ...(process.env.LOG_STACKS === "true" ? { stack: value.stack?.slice(0, 2000) } : {}),
    };
  }

  if (depth >= MAX_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    const shown = value.slice(0, 20).map((v) => redact(v, keyHint, depth + 1));
    return value.length > 20 ? [...shown, `…${value.length - 20} more`] : shown;
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redact(v, k, depth + 1),
      ]),
    );
  }

  return String(value);
}

function isSensitive(key: string): boolean {
  if (!key) return false;
  const lower = key.toLowerCase();
  if (ALLOWED.includes(lower)) return false;
  return SENSITIVE.some((s) => lower.includes(s));
}

export interface LogFields {
  [key: string]: unknown;
}

export function log(level: Level, msg: string, fields: LogFields = {}): void {
  if (THRESHOLD[level] < minLevel()) return;

  const line = {
    level,
    msg,
    time: new Date().toISOString(),
    ...(redact(fields) as LogFields),
  };

  // stderr for warn and error so a host that separates the streams classifies
  // them without having to parse the payload.
  const write = level === "error" || level === "warn" ? console.error : console.log;
  write(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => log("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => log("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => log("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => log("error", msg, fields),
};

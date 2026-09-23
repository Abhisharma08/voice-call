import { z } from "zod";

/**
 * Fail fast on misconfiguration. Production and
 * staging credentials and encrypted secrets at rest — a missing or reused key
 * is a security defect, not a warning, so the process refuses to start.
 */

const base64Key = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, "base64").length === bytes;
        } catch {
          return false;
        }
      },
      { message: `must be ${bytes} raw bytes encoded as base64` },
    );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),

  DATABASE_URL: z.string().url(),
  DATABASE_URL_APP: z.string().url(),
  DATABASE_URL_SERVICE: z.string().url(),

  KMS_MASTER_KEY: base64Key(32),
  KMS_MASTER_KEY_ID: z.string().min(1),
  KMS_PREVIOUS_KEYS: z.string().default("{}"),

  PII_ENCRYPTION_KEY: base64Key(32),
  PII_BLIND_INDEX_KEY: base64Key(32),

  SESSION_SECRET: base64Key(32),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  APP_URL: z.string().url(),

  /**
   * Shared secret for the scheduled sweep at `/api/cron/tick`. Vercel Cron
   * sends it as `Authorization: Bearer $CRON_SECRET`.
   *
   * The endpoint refuses to serve without it rather than running open, so a
   * missing value costs retries and outbox delivery, not isolation. It is
   * still required outside development: on a serverless platform this
   * scheduler is the only thing that dials a lead whose retry came due, and a
   * deploy that silently has no scheduler looks exactly like one where nobody
   * is calling anyone back.
   */
  CRON_SECRET: z.string().min(24, "Use at least 24 characters").optional(),

  /**
   * Per-pool connection ceiling. Every serverless instance opens its own
   * pool, so the useful number on Vercel is small and the connection string
   * should be a pooled one (Neon's `-pooler` host, Supabase's port 6543).
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const e = parsed.data;

  // Distinct key material per purpose. Reusing one key across the secrets
  // vault, PII columns and the blind index collapses three trust boundaries
  // into one.
  const keys = [e.KMS_MASTER_KEY, e.PII_ENCRYPTION_KEY, e.PII_BLIND_INDEX_KEY, e.SESSION_SECRET];
  if (new Set(keys).size !== keys.length) {
    throw new Error(
      "KMS_MASTER_KEY, PII_ENCRYPTION_KEY, PII_BLIND_INDEX_KEY and SESSION_SECRET must all differ",
    );
  }

  // The runtime must never hold owner credentials (RLS is only
  // enforced against a non-owner role).
  if (e.APP_ENV !== "development" && e.DATABASE_URL_APP === e.DATABASE_URL) {
    throw new Error("DATABASE_URL_APP must not be the migration owner connection");
  }

  if (e.APP_ENV !== "development" && !e.CRON_SECRET) {
    throw new Error(
      "CRON_SECRET is required outside development: without it nothing dials a lead " +
        "whose retry or callback comes due. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"`",
    );
  }

  cached = e;
  return e;
}

export function previousKmsKeys(): Record<string, Buffer> {
  const raw = JSON.parse(env().KMS_PREVIOUS_KEYS) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([id, b64]) => [id, Buffer.from(b64, "base64")]),
  );
}

export function resetEnvCache(): void {
  cached = null;
}

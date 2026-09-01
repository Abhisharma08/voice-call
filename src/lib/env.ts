import { z } from "zod";

/**
 * Fail fast on misconfiguration. PRD 17.1 requires separate production and
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

  // The runtime must never hold owner credentials (PRD 8.2: RLS is only
  // enforced against a non-owner role).
  if (e.APP_ENV !== "development" && e.DATABASE_URL_APP === e.DATABASE_URL) {
    throw new Error("DATABASE_URL_APP must not be the migration owner connection");
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

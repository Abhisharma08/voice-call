import "../scripts/load-env.ts";

// Deterministic keys so tests do not depend on a developer's .env.local.
// Distinct per purpose, matching the constraint enforced in src/lib/env.ts.
const TEST_KEYS: Record<string, string> = {
  KMS_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  KMS_MASTER_KEY_ID: "test-1",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  PII_BLIND_INDEX_KEY: Buffer.alloc(32, 3).toString("base64"),
  SESSION_SECRET: Buffer.alloc(32, 4).toString("base64"),
  APP_URL: "http://localhost:3000",
  APP_ENV: "development",
};

for (const [key, value] of Object.entries(TEST_KEYS)) {
  process.env[key] = value;
}

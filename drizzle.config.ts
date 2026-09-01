import type { Config } from "drizzle-kit";

// Migrations are authored as raw SQL in db/migrations (see README: RLS policies and
// column-level encryption are first-class, so we do not generate DDL from the TS schema).
// drizzle-kit is kept for `introspect`/`check` workflows only.
export default {
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
} satisfies Config;

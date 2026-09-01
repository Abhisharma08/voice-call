import { Client } from "pg";
import "./load-env.ts";

/**
 * Drop and recreate the public and app schemas. Development and CI only -
 * refuses to run against a non-development APP_ENV.
 */
async function main() {
  if ((process.env.APP_ENV ?? "development") !== "development") {
    throw new Error(`Refusing to reset the database with APP_ENV=${process.env.APP_ENV}`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`drop schema if exists public cascade`);
    await client.query(`drop schema if exists app cascade`);
    await client.query(`create schema public`);
    console.log("Schemas dropped and recreated.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

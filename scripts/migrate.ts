import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Client } from "pg";
import "./load-env.ts";

/**
 * Forward-only SQL migrations, applied in filename order inside a transaction
 * each, with a checksum recorded so an already-applied file cannot be edited
 * without CI noticing.
 *
 * Runs as the owner connection (DATABASE_URL). Nothing else should.
 */

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run migrations");

  const client = new Client({ connectionString: url, application_name: "leadcalling-migrate" });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )`);

    const applied = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>(
        `select filename, checksum from schema_migrations`,
      )).rows.map((r) => [r.filename, r.checksum]),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    let ran = 0;
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after it was applied.\n` +
              `Write a new migration instead of editing an applied one.`,
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${file} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          `insert into schema_migrations (filename, checksum) values ($1, $2)`,
          [file, checksum],
        );
        await client.query("commit");
        process.stdout.write("ok\n");
        ran += 1;
      } catch (err) {
        await client.query("rollback");
        process.stdout.write("FAILED\n");
        throw err;
      }
    }

    console.log(ran === 0 ? "Database already up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

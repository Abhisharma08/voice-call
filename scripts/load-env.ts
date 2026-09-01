import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader for CLI scripts. Next.js loads .env.local itself; the
 * migration and seed scripts run outside it, so they need this. Real
 * environment variables always win, so CI can override without a file.
 */
for (const name of [".env.local", ".env"]) {
  const path = join(process.cwd(), name);
  if (!existsSync(path)) continue;

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment from an unquoted value. Only ` #`
      // counts, so a '#' inside a password or connection string survives.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Start a public tunnel and point `APP_URL` at it.
 *
 *   npm run tunnel
 *
 * Inbound traffic - HubSpot's contact-created webhook, Twilio's status
 * callbacks and TwiML fetches - has to reach this machine, and a laptop has no
 * public address. Cloudflare's quick tunnels give one for free with no account.
 *
 * The reason this is a script rather than a line in the README: a quick tunnel
 * gets a **new hostname every time it starts**, and `APP_URL` is not
 * cosmetic. The calling worker mints provider callback URLs from it, and the
 * signature check compares against it. A stale value does not throw - calls
 * dial normally and every result is silently dropped, which is a genuinely
 * expensive hour to debug. So the URL is written to .env.local the moment it
 * is known, and the previous value is kept in .env.local.bak.
 *
 * Restart `next dev` after this prints, so the new value is loaded.
 *
 * For anything beyond local testing, use a named tunnel on a domain you own
 * (`cloudflared tunnel route dns`) and set APP_URL once, permanently.
 */

const PORT = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "3001";
const ENV_FILE = ".env.local";
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function setAppUrl(url: string): void {
  const current = readFileSync(ENV_FILE, "utf8");

  const previous = /^APP_URL=(.*)$/m.exec(current)?.[1]?.trim();
  if (previous === url) {
    console.log(`\n  APP_URL already points at ${url}\n`);
    return;
  }

  writeFileSync(`${ENV_FILE}.bak`, current);

  const updated = /^APP_URL=/m.test(current)
    ? current.replace(/^APP_URL=.*$/m, `APP_URL=${url}`)
    : `${current.replace(/\n*$/, "\n")}APP_URL=${url}\n`;

  writeFileSync(ENV_FILE, updated);

  console.log(`\n  tunnel    ${url}`);
  console.log(`  APP_URL   updated in ${ENV_FILE}${previous ? ` (was ${previous})` : ""}`);
  console.log(`  previous  saved to ${ENV_FILE}.bak`);
  console.log(`\n  Restart \`next dev\` now, or callbacks will still be signed`);
  console.log(`  against the old hostname and every call result will be dropped.\n`);
  console.log(`  Verify from outside:  curl ${url}/api/health\n`);
}

const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

child.on("error", (err) => {
  const hint =
    (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "cloudflared is not installed. `brew install cloudflared`"
      : err.message;
  console.error(`\n  Could not start the tunnel: ${hint}\n`);
  process.exit(1);
});

let claimed = false;

// cloudflared writes its banner to stderr, and the URL can arrive on either.
const watch = (chunk: Buffer) => {
  const text = chunk.toString();
  process.stderr.write(text);

  if (claimed) return;
  const match = URL_PATTERN.exec(text);
  if (match) {
    claimed = true;
    setAppUrl(match[0]);
  }
};

child.stdout.on("data", watch);
child.stderr.on("data", watch);

// The tunnel only exists while this process does, so make that explicit rather
// than leaving a dead hostname in .env.local looking live.
const goodbye = () => {
  console.log(`\n  Tunnel closed. APP_URL in ${ENV_FILE} now points at a dead hostname.\n`);
  child.kill();
  process.exit(0);
};

process.on("SIGINT", goodbye);
process.on("SIGTERM", goodbye);

child.on("exit", (code) => {
  console.log(`\n  cloudflared exited (${code}).\n`);
  process.exit(code ?? 0);
});

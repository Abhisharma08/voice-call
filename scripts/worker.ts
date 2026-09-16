import "./load-env.ts";

/**
 * The local stand-in for the production scheduler.
 *
 *   npm run worker
 *
 * In production a cron calls `/api/cron/tick` (see `vercel.json` and
 * `docs/DEPLOY.md`). This is a timer that calls the same endpoint, so what
 * runs locally is what runs deployed - one code path, and no way for the two
 * to drift.
 *
 * It used to be the scheduler itself: it minted a service token, resolved one
 * named tenant and campaign from the command line, and posted to
 * `/api/internal/dial` and `/api/internal/sync` on two intervals. That shape
 * could not be deployed - a serverless platform has no long-lived process -
 * and it did not survive a second client, since the campaign was an argument.
 * All of it moved into the endpoint, which sweeps every tenant and every
 * campaign, so nothing here needs to know what exists.
 *
 * You do not need this running to see a call placed. A lead arriving from
 * HubSpot dials on the webhook's own invocation. This covers what a later tick
 * has to notice: retries on the backoff ladder, a calling window opening, a
 * requested callback coming due, and the sync outbox.
 */

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const BASE = arg("url") ?? process.env.WORKER_URL ?? "http://localhost:3000";
const INTERVAL_SECONDS = Number(arg("interval") ?? 60);
const ONCE = process.argv.includes("--once");

const SECRET = process.env.CRON_SECRET;

interface Sweep {
  campaigns?: number;
  calls_placed?: number;
  calls_failed?: number;
  outbox_processed?: number;
  outbox_failed?: number;
  duration_ms?: number;
}

/** Local time, not UTC: a calling window is configured in the campaign's timezone. */
const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

async function tick(): Promise<void> {
  const response = await fetch(`${BASE}/api/cron/tick`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });

  const body = (await response.json().catch(() => null)) as Sweep | { error?: string } | null;

  if (!response.ok) {
    const detail = (body as { error?: string } | null)?.error ?? response.statusText;
    // 401 here means this process and the server disagree about CRON_SECRET -
    // usually a server started before the value was added to .env.local.
    throw new Error(
      response.status === 401
        ? `401 from ${BASE}: CRON_SECRET does not match the running server. Restart \`npm run dev\`.`
        : `${response.status} ${detail}`,
    );
  }

  const sweep = body as Sweep;
  const did =
    (sweep.calls_placed ?? 0) + (sweep.calls_failed ?? 0) + (sweep.outbox_processed ?? 0);

  // Silent when there was nothing to do: a line every minute saying "0" trains
  // you to stop reading the log.
  if (did === 0) return;

  console.log(
    `  ${stamp()}  ${sweep.calls_placed ?? 0} placed, ${sweep.calls_failed ?? 0} failed, ` +
      `${sweep.outbox_processed ?? 0} synced across ${sweep.campaigns ?? 0} campaign(s)`,
  );
}

async function main() {
  if (!SECRET) {
    throw new Error(
      "CRON_SECRET is not set. Add it to .env.local - generate one with:\n" +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }

  if (ONCE) {
    await tick();
    return;
  }

  console.log(`\n  sweeping  ${BASE}/api/cron/tick every ${INTERVAL_SECONDS}s`);
  console.log(`\n  New leads dial on their own webhook invocation - this covers retries,`);
  console.log(`  callbacks, a calling window opening, and the sync outbox.`);
  console.log(`  Quiet ticks print nothing. Ctrl-C to stop.\n`);

  // A thrown tick must not kill the loop: the app restarting mid-tick is
  // normal in development, and the next tick recovers on its own.
  const safely = async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`  ${stamp()}  ${err instanceof Error ? err.message : err}`);
    }
  };

  await safely();
  const timer = setInterval(() => void safely(), INTERVAL_SECONDS * 1000);

  const stop = () => {
    clearInterval(timer);
    console.log(`\n  Stopped. Queued leads stay queued; nothing is lost.\n`);
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

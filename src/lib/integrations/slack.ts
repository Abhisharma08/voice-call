import { openSecret, type SealedSecret } from "@/lib/crypto/kms";
import { IntegrationError } from "@/lib/integrations/hubspot";
import type { NotificationPayload } from "@/lib/integrations/sync-worker";

/**
 * Hot-lead delivery over a Slack incoming webhook.
 *
 * Everything upstream of this file already existed: `qualifyCall` enqueues a
 * `notification` row into `sync_outbox`, `sync-worker` builds the payload with
 * the phone number already masked and holds it back while the result is under
 * review, and `routing_events` is stamped `notified` once it lands. The only
 * missing piece was something that actually sends, which is all this is - a
 * transport behind the `notifier` dependency the worker already accepts.
 *
 * Consequences of arriving through the outbox, rather than being called
 * directly from the pipeline: a Slack outage is a retry on the existing
 * backoff ladder, a delivery is deduplicated by the outbox's unique key, and
 * eight failures dead-letter the row for manual replay instead of dropping a
 * hot lead silently.
 *
 * An incoming webhook is chosen over a bot token because its authority is
 * exactly one channel, decided in Slack at the time it is created. A bot token
 * can post anywhere in the workspace, which is a great deal more access than
 * "tell this client's sales channel about a hot lead" needs - and the
 * credential is held by the agency on the client's behalf, so the narrower one
 * is the right one to be holding.
 */

export interface SlackCredentials {
  /** `https://hooks.slack.com/services/T…/B…/…` */
  webhookUrl: string;
}

/** The sealed-secret `purpose`, matching `integrations.type`. */
export const SLACK_SECRET_PURPOSE = "notification";

const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]+$/;

export class SlackNotifier {
  constructor(
    private readonly credentials: SlackCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromSealedSecret(sealed: SealedSecret, fetchImpl: typeof fetch = fetch): SlackNotifier {
    const raw = openSecret(sealed, SLACK_SECRET_PURPOSE);
    return new SlackNotifier(JSON.parse(raw) as SlackCredentials, fetchImpl);
  }

  async send(payload: NotificationPayload): Promise<void> {
    await this.post(buildMessage(payload));
  }

  /**
   * Prove the webhook works, from the `/integrations` test button.
   *
   * There is no read-only way to validate an incoming webhook: Slack offers no
   * endpoint that says "this URL is live" without posting. So the test posts a
   * real, clearly-labelled message. That is the honest behaviour - it proves
   * the URL resolves, the channel still exists and the app has not been
   * revoked - but it is visible to the client, so it says what it is.
   */
  async verifyConnection(): Promise<void> {
    await this.post({
      text: "Lead calling platform: notification test",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*Notification test* — this channel is connected to the AI lead calling " +
              "platform. Hot leads will arrive here. No action needed.",
          },
        },
      ],
    });
  }

  private async post(body: SlackMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.credentials.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Network failures and timeouts are transient by definition.
      throw new IntegrationError(
        `Slack request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    if (response.ok) return;

    const detail = (await response.text().catch(() => "")).slice(0, 200);

    // Slack answers an incoming webhook with a plain-text body rather than
    // JSON, and the useful distinction is whether the webhook is gone for good
    // or the request merely failed this time.
    //
    // `no_service`, `no_team` and 404 all mean the webhook was revoked or the
    // app uninstalled. Retrying those eight times just delays the moment
    // somebody notices the client's channel has been disconnected, so they are
    // classified non-retryable and dead-letter immediately.
    if (response.status === 404 || /no_service|no_team|invalid_token/.test(detail)) {
      throw new IntegrationError(
        `Slack webhook is no longer valid (${response.status}): ${detail}`,
        false,
        // Surfaced as 401 so the worker's auth-failure rule marks the
        // integration `error` and stops using it, rather than leaving a dead
        // webhook configured and apparently healthy.
        401,
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new IntegrationError(`Slack transient error ${response.status}`, true, response.status);
    }

    throw new IntegrationError(
      `Slack error ${response.status}: ${detail}`,
      false,
      response.status,
    );
  }
}

interface SlackMessage {
  text: string;
  blocks: unknown[];
}

/**
 * The Slack message for a hot lead.
 *
 * `text` is set as well as `blocks` because it is what Slack shows in the
 * notification popup and the sidebar preview; a blocks-only message reads as
 * "[no text]" there, which for an alert whose entire job is to get someone's
 * attention defeats the point.
 *
 * The phone number arrives already masked from `sync-worker`, and is not
 * unmasked here. A Slack channel is outside the platform's access-control
 * layer and its retention is the client's, so the full number stays in
 * PostgreSQL behind the audited reveal.
 */
export function buildMessage(payload: NotificationPayload): SlackMessage {
  const who = payload.leadName ?? "Unnamed lead";
  const headline = `Hot lead: ${who} — score ${payload.score} (${payload.intent})`;

  const fields = [
    `*Campaign*\n${payload.campaignName || "—"}`,
    `*Client*\n${payload.tenantName}`,
    `*Phone*\n${payload.maskedPhone ?? "—"}`,
    `*Call length*\n${formatDuration(payload.durationSec)}`,
  ];

  return {
    text: headline,
    blocks: [
      {
        type: "header",
        // A header block renders plain text only, and Slack rejects one over
        // 150 characters rather than truncating it.
        text: { type: "plain_text", text: truncate(headline, 150), emoji: true },
      },
      {
        type: "section",
        fields: fields.map((text) => ({ type: "mrkdwn", text })),
      },
      ...(payload.summary
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*Summary*\n${truncate(payload.summary, 2800)}` },
            },
          ]
        : []),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Call \`${payload.callId}\`` }],
      },
    ],
  };
}

/**
 * Slack rejects a message whose block text exceeds its limit outright, so an
 * over-long LLM summary would fail the whole delivery and then fail every
 * retry identically until it dead-lettered. Truncating is the difference
 * between a slightly clipped alert and no alert.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Validate a pasted credential while the plaintext is still in hand.
 *
 * The URL is checked against Slack's own host rather than merely being parsed
 * as a URL, because this credential is used for exactly one thing: an outbound
 * POST carrying a lead's name and masked number. A typo'd or hostile host
 * would be a data exfiltration path that looks like a configuration mistake,
 * and the check that prevents it costs nothing here.
 */
export function validateSlackCredential(credential: string): string | null {
  const shape = 'Expected JSON like {"webhookUrl": "https://hooks.slack.com/services/T.../B.../..."}';

  let parsed: { webhookUrl?: unknown };
  try {
    parsed = JSON.parse(credential) as { webhookUrl?: unknown };
  } catch {
    return shape;
  }

  if (typeof parsed.webhookUrl !== "string" || parsed.webhookUrl.trim().length === 0) {
    return shape;
  }

  if (!SLACK_WEBHOOK_RE.test(parsed.webhookUrl.trim())) {
    return (
      "webhookUrl must be a Slack incoming webhook on https://hooks.slack.com/services/ — " +
      "create one under the Slack app's “Incoming Webhooks” page"
    );
  }

  return null;
}

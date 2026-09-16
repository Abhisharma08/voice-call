import { describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../../src/lib/integrations/hubspot.ts";
import type { NotificationPayload } from "../../src/lib/integrations/sync-worker.ts";
import {
  SlackNotifier,
  buildMessage,
  validateSlackCredential,
} from "../../src/lib/integrations/slack.ts";

const WEBHOOK = "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop";

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    tenantName: "Acme Windows",
    campaignName: "Q1 Retrofit",
    leadName: "Rahul Sharma",
    maskedPhone: "+91 ***** 3210",
    intent: "hot",
    score: 88,
    summary: "Wants a quote for 6 windows, budget confirmed, decision this month.",
    callId: "11111111-2222-4333-8444-555555555555",
    durationSec: 154,
    ...overrides,
  };
}

function respondWith(status: number, body = ""): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("validateSlackCredential", () => {
  it("accepts a well-formed incoming webhook", () => {
    expect(validateSlackCredential(JSON.stringify({ webhookUrl: WEBHOOK }))).toBeNull();
  });

  it("rejects anything that is not JSON", () => {
    expect(validateSlackCredential(WEBHOOK)).toMatch(/Expected JSON/);
  });

  it("rejects JSON without a webhookUrl", () => {
    expect(validateSlackCredential('{"token":"xoxb-123"}')).toMatch(/Expected JSON/);
  });

  /**
   * The credential's only use is an outbound POST carrying a lead's name and
   * masked number, so a non-Slack host is a data exfiltration path wearing a
   * typo's clothing. Refusing it at paste time costs nothing.
   */
  it("rejects a webhook pointed at another host", () => {
    const other = JSON.stringify({ webhookUrl: "https://hooks.slack.com.evil.test/services/a/b/c" });
    expect(validateSlackCredential(other)).toMatch(/must be a Slack incoming webhook/);
  });

  it("rejects plain http, even on the right host", () => {
    const insecure = JSON.stringify({ webhookUrl: WEBHOOK.replace("https:", "http:") });
    expect(validateSlackCredential(insecure)).toMatch(/must be a Slack incoming webhook/);
  });

  it("rejects a Slack URL that is not an incoming webhook", () => {
    const api = JSON.stringify({ webhookUrl: "https://hooks.slack.com/workflows/T0/B0/x" });
    expect(validateSlackCredential(api)).toMatch(/must be a Slack incoming webhook/);
  });
});

describe("buildMessage", () => {
  it("sets fallback text, which is what the notification popup shows", () => {
    expect(buildMessage(payload()).text).toBe("Hot lead: Rahul Sharma — score 88 (hot)");
  });

  /**
   * PRD 26.2: a Slack channel sits outside the platform's access control and
   * its retention belongs to the client, so the full number never goes there.
   * The payload arrives masked from sync-worker and must stay that way.
   */
  it("carries only the masked phone the worker supplied", () => {
    const rendered = JSON.stringify(buildMessage(payload()));
    expect(rendered).toContain("+91 ***** 3210");
    expect(rendered).not.toContain("9876543210");
  });

  it("names an unnamed lead rather than rendering null", () => {
    expect(buildMessage(payload({ leadName: null })).text).toContain("Unnamed lead");
  });

  it("renders a missing duration and phone as a dash", () => {
    const rendered = JSON.stringify(
      buildMessage(payload({ durationSec: null, maskedPhone: null })),
    );
    expect(rendered).toContain("—");
  });

  it("formats duration as minutes and seconds", () => {
    expect(JSON.stringify(buildMessage(payload({ durationSec: 154 })))).toContain("2m 34s");
    expect(JSON.stringify(buildMessage(payload({ durationSec: 42 })))).toContain("42s");
  });

  it("omits the summary block when there is no summary", () => {
    expect(JSON.stringify(buildMessage(payload({ summary: "" })))).not.toContain("*Summary*");
  });

  /**
   * Slack rejects an over-long block outright rather than truncating it, so an
   * unusually verbose model summary would fail the delivery and then fail
   * every retry identically until it dead-lettered. A clipped alert beats no
   * alert.
   */
  it("truncates a header and summary Slack would reject", () => {
    const message = buildMessage(
      payload({ leadName: "N".repeat(400), summary: "S".repeat(5000) }),
    );
    const header = message.blocks[0] as { text: { text: string } };
    expect(header.text.text.length).toBeLessThanOrEqual(150);

    const summary = JSON.stringify(message.blocks).match(/\*Summary\*\\n(S+…?)/)?.[1] ?? "";
    expect(summary.length).toBeLessThanOrEqual(2800);
  });
});

describe("SlackNotifier delivery", () => {
  it("posts JSON to the configured webhook", async () => {
    const fetchImpl = respondWith(200, "ok");
    await new SlackNotifier({ webhookUrl: WEBHOOK }, fetchImpl).send(payload());

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).text).toContain("Hot lead");
  });

  /**
   * PRD 18.2's failure classes. The outbox reads `retryable` to decide between
   * the backoff ladder and an immediate dead-letter, so the classification is
   * the contract - getting it wrong either buries a real failure under eight
   * retries or abandons a lead over a transient blip.
   */
  it("classifies 5xx and 429 as retryable", async () => {
    for (const status of [500, 502, 503, 429]) {
      const err = await new SlackNotifier({ webhookUrl: WEBHOOK }, respondWith(status))
        .send(payload())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable, `status ${status}`).toBe(true);
    }
  });

  it("classifies a revoked webhook as non-retryable and as an auth failure", async () => {
    const err = await new SlackNotifier({ webhookUrl: WEBHOOK }, respondWith(404, "no_service"))
      .send(payload())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).retryable).toBe(false);
    // 401 is what makes the worker mark the integration `error` and stop using
    // it, rather than leaving a dead webhook configured and apparently healthy.
    expect((err as IntegrationError).status).toBe(401);
  });

  it("treats a network failure as transient", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const err = await new SlackNotifier({ webhookUrl: WEBHOOK }, boom)
      .send(payload())
      .catch((e: unknown) => e);

    expect((err as IntegrationError).retryable).toBe(true);
  });

  it("does not retry a 400, which will fail identically every time", async () => {
    const err = await new SlackNotifier({ webhookUrl: WEBHOOK }, respondWith(400, "invalid_payload"))
      .send(payload())
      .catch((e: unknown) => e);

    expect((err as IntegrationError).retryable).toBe(false);
  });

  it("posts a labelled test message for the connection check", async () => {
    const fetchImpl = respondWith(200, "ok");
    await new SlackNotifier({ webhookUrl: WEBHOOK }, fetchImpl).verifyConnection();

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(JSON.parse(String(init.body)).text).toMatch(/notification test/i);
  });
});

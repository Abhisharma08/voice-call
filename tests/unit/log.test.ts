import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logger, redact } from "../../src/lib/observability/log.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_STACKS;
});

function captured(fn: () => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const sink = (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>);
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "error").mockImplementation(sink);
  fn();
  return lines;
}

describe("redact", () => {
  /**
   * PRD 26.2 puts phone numbers and names in encrypted columns; a log line is
   * the easiest way for one to get back out. The substring match is what makes
   * this hold as field names multiply - nobody has to maintain an enumeration
   * of every name a phone number is given.
   */
  it("redacts sensitive fields whatever they are called", () => {
    const out = redact({
      phone: "+919876543210",
      lead_phone: "+919876543210",
      customerPhoneNumber: "+919876543210",
      email: "someone@example.test",
      accessToken: "pat-na1-secret",
      clientSecret: "shhh",
      webhookUrl: "https://hooks.slack.com/services/T/B/x",
      transcript: "the whole call",
    }) as Record<string, unknown>;

    for (const [key, value] of Object.entries(out)) {
      expect(value, key).toBe("[redacted]");
    }
  });

  it("redacts nested fields too", () => {
    const out = redact({ lead: { name_enc: "x", phone: "+91987", id: "abc" } }) as {
      lead: Record<string, unknown>;
    };
    expect(out.lead.phone).toBe("[redacted]");
    expect(out.lead.name_enc).toBe("[redacted]");
    expect(out.lead.id).toBe("abc");
  });

  /**
   * The allowlist is load-bearing, not a nicety: `tenant_name` and
   * `campaign_name` are what make an operational log line answer "whose
   * campaign is failing". They are agency-side configuration, not a lead's
   * personal data.
   */
  it("keeps the identifying fields the operational logs depend on", () => {
    const out = redact({
      tenant_name: "Acme Windows",
      campaign_name: "Q1 Retrofit",
      key_id: "test-1",
    }) as Record<string, unknown>;

    expect(out.tenant_name).toBe("Acme Windows");
    expect(out.campaign_name).toBe("Q1 Retrofit");
    expect(out.key_id).toBe("test-1");
  });

  it("leaves ordinary operational fields alone", () => {
    const out = redact({ tenant_id: "t-1", dialled: 3, failed: 0, ok: true }) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ tenant_id: "t-1", dialled: 3, failed: 0, ok: true });
  });

  it("bounds a long string rather than emitting it whole", () => {
    const out = redact({ detail: "x".repeat(5000) }) as { detail: string };
    expect(out.detail.length).toBeLessThan(600);
    expect(out.detail).toMatch(/\[5000\]$/);
  });

  it("summarises a Buffer instead of dumping its bytes", () => {
    const out = redact({ ciphertext: Buffer.alloc(64) }) as { ciphertext: string };
    expect(out.ciphertext).toBe("[buffer 64b]");
  });

  it("reduces an Error to name and message, without a stack by default", () => {
    const out = redact({ err: new Error("boom") }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: "Error", message: "boom" });
  });

  it("includes a bounded stack when asked", () => {
    process.env.LOG_STACKS = "true";
    const out = redact({ err: new Error("boom") }) as { err: Record<string, unknown> };
    expect(typeof out.err.stack).toBe("string");
  });

  it("truncates deep nesting instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });

  it("caps a long array", () => {
    const out = redact({ ids: Array.from({ length: 100 }, (_, i) => i) }) as { ids: unknown[] };
    expect(out.ids).toHaveLength(21);
    expect(out.ids[20]).toBe("…80 more");
  });
});

describe("log", () => {
  it("writes one JSON object per line with level, msg and time", () => {
    const [line] = captured(() => logger.info("dial tick", { dialled: 2 }));
    expect(line).toMatchObject({ level: "info", msg: "dial tick", dialled: 2 });
    expect(typeof line!.time).toBe("string");
  });

  it("redacts through the logger, not just through redact()", () => {
    const [line] = captured(() => logger.info("intake", { phone: "+919876543210" }));
    expect(line!.phone).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("9876543210");
  });

  /**
   * warn and error go to stderr so a host that separates the streams
   * classifies them without parsing the payload.
   */
  it("sends warn and error to stderr and info to stdout", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.info("a");
    logger.warn("b");
    logger.error("c");

    expect(out).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("drops debug by default and emits it when LOG_LEVEL says so", () => {
    expect(captured(() => logger.debug("quiet"))).toHaveLength(0);

    process.env.LOG_LEVEL = "debug";
    expect(captured(() => logger.debug("loud"))).toHaveLength(1);
  });

  it("suppresses everything below a raised threshold", () => {
    process.env.LOG_LEVEL = "error";
    expect(captured(() => log("warn", "ignored"))).toHaveLength(0);
    expect(captured(() => log("error", "kept"))).toHaveLength(1);
  });

  it("ignores an unrecognised LOG_LEVEL rather than going silent", () => {
    process.env.LOG_LEVEL = "chatty";
    expect(captured(() => logger.info("still here"))).toHaveLength(1);
  });
});

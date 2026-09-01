import { type NextRequest } from "next/server";
import { withoutScope, withScope } from "@/db/client";
import { decryptPiiOrNull, encryptPii } from "@/lib/crypto/pii";
import { twilioConfigFromEnv, twilioSignature, twimlToken } from "@/lib/providers/voice/twilio";

export const runtime = "nodejs";

/**
 * The conversation itself, as TwiML.
 *
 * Twilio is a carrier, not a voice agent: it dials and plays audio, and this
 * endpoint decides what to say next. One turn per request - speak a question,
 * `<Gather input="speech">` the answer, then come back for the next one. Each
 * answer is appended to the call's transcript, so by the time the status
 * callback reports `completed` there is a real conversation for qualification
 * to read.
 *
 * Deliberately simple. No barge-in, no clarification, no recovery from a
 * misheard answer. It is enough to exercise the pipeline against a phone that
 * rings, and no substitute for a production voice agent.
 */

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId");
  const token = url.searchParams.get("token");
  const turn = Number(url.searchParams.get("turn") ?? 0);

  const config = twilioConfigFromEnv();
  if (!config) return twiml(say("This platform is not configured for Twilio."));

  // Two independent checks. The token proves the URL was minted by createCall
  // for this specific call; the signature proves Twilio sent the request.
  if (!callId || token !== twimlToken(callId, config.webhookSecret)) {
    return twiml(say("Sorry, this call could not be verified."), 403);
  }

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);
  const signature = request.headers.get("x-twilio-signature") ?? "";

  if (signature !== twilioSignature(config.authToken, request.url, params)) {
    return twiml(say("Sorry, this call could not be verified."), 403);
  }

  // Resolve the call's tenant before opening a scoped transaction: this
  // request arrives from Twilio with no session and no service token, so the
  // call id is the only thing tying it to a tenant.
  const context = await withoutScope(async (tx) => {
    const r = await tx.query<{ tenant_id: string; campaign_id: string | null }>(
      `select tenant_id, campaign_id from call_attempts where id = $1`,
      [callId],
    );
    return r.rows[0] ?? null;
  });

  if (!context) return twiml(say("Sorry, we could not find this call."));

  const scope = {
    tenantId: context.tenant_id,
    globalScope: false,
    actorId: null,
    actorType: "service" as const,
  };

  return withScope(scope, async (tx) => {
    const campaign = await tx.query<{
      script: string | null;
      questions: Array<{ question: string }>;
    }>(
      `select c.script,
              coalesce(
                (select json_agg(json_build_object('question', q.question) order by q.position)
                   from qualification_rules q where q.campaign_id = c.id),
                '[]'::json
              ) as questions
         from campaigns c where c.id = $1`,
      [context.campaign_id],
    );

    const script = campaign.rows[0]?.script ?? "Hello, calling about your recent enquiry.";
    const questions = (campaign.rows[0]?.questions ?? []).map((q) => q.question);

    // Twilio posts the previous <Gather>'s result on the next request.
    const heard = params.get("SpeechResult");
    if (heard && turn > 0) {
      await appendTurn(tx, context.tenant_id, callId, "Lead", heard);
    }

    // turn 0 is the opening; turns 1..n ask question n-1.
    const nextQuestion = questions[turn];

    if (nextQuestion === undefined) {
      await appendTurn(tx, context.tenant_id, callId, "Agent", CLOSING);
      return twiml(`${say(CLOSING)}<Hangup/>`);
    }

    const spoken = turn === 0 ? `${script} ${nextQuestion}` : nextQuestion;
    await appendTurn(tx, context.tenant_id, callId, "Agent", spoken);

    const nextUrl =
      `${config.publicUrl}/api/webhooks/voice/twilio/twiml` +
      `?callId=${encodeURIComponent(callId)}&token=${token}&turn=${turn + 1}`;

    return twiml(
      `<Gather input="speech" speechTimeout="auto" action="${escapeXml(nextUrl)}" method="POST">` +
        say(spoken) +
        `</Gather>` +
        // Reached only if the caller says nothing: move on rather than hanging
        // in silence, so an unanswered question still produces a transcript.
        `<Redirect method="POST">${escapeXml(nextUrl)}</Redirect>`,
    );
  });
}

const CLOSING = "Thank you for your time. Someone will follow up shortly. Goodbye.";

/**
 * Append one turn to the call's transcript.
 *
 * Read-modify-write on an encrypted column rather than a turns table: the
 * transcript is one row per call (PRD 12), turns arrive strictly in order on a
 * single call leg, and a call has a handful of them. PRD 26.2 keeps it
 * encrypted at the application layer either way.
 */
async function appendTurn(
  tx: Parameters<Parameters<typeof withScope>[1]>[0],
  tenantId: string,
  callId: string,
  speaker: "Agent" | "Lead",
  text: string,
): Promise<void> {
  const existing = await tx.query<{ id: string; transcript_enc: Buffer | null }>(
    `select id, transcript_enc from call_transcripts where call_id = $1 for update`,
    [callId],
  );

  const line = `${speaker}: ${text.trim()}`;
  const row = existing.rows[0];

  if (!row) {
    await tx.query(
      `insert into call_transcripts (tenant_id, call_id, transcript_enc, language)
       values ($1, $2, $3, $4)`,
      [tenantId, callId, encryptPii(line), "en-US"],
    );
    return;
  }

  const previous = decryptPiiOrNull(row.transcript_enc) ?? "";
  await tx.query(`update call_transcripts set transcript_enc = $2 where id = $1`, [
    row.id,
    encryptPii(previous ? `${previous}\n${line}` : line),
  ]);
}

function say(text: string): string {
  return `<Say voice="Polly.Aditi">${escapeXml(text)}</Say>`;
}

function twiml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
